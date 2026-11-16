/**
 * core.js — čistá logika Diktafónu pre iPhone (bez DOM, testovateľná v Node).
 *
 * WHAT:  prepis reči (ElevenLabs Scribe v3) a úprava textu (OpenAI GPT) — presne ten istý reťazec
 *        ako Android appka (Pipeline.java + TextChunker.java), prepísaný do JavaScriptu.
 * WHY:   iPhone nemôže spustiť APK; táto webová appka (PWA) robí rovnakú prácu z Safari.
 * TWEAK: konštanty hneď nižšie (model, jazyk, dĺžka častí). Sieť sa dá v testoch nahradiť parametrom `f`.
 * Chyby sa hádžu ako ApiError { title, message } s ľudsky čitateľným dôvodom.
 */

export const ELEVEN_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
export const ELEVEN_MODEL = 'scribe_v3';
export const LANGUAGE = 'slk';
export const OPENAI_URL = 'https://api.openai.com/v1/responses';
export const GPT_MODEL = 'gpt-5.4-mini';
export const CHUNK_TARGET = 700;     // približná dĺžka časti pri paralelnej úprave dlhého textu
export const MIN_TO_CHUNK = 1000;    // kratší text ide v jednej požiadavke
export const MAX_RECORD_SEC = 600;   // poistka: max 10 min nahrávky

export class ApiError extends Error {
  constructor(title, detail) { super(detail || title); this.title = title; }
}

/** Skráti text na jeden riadok (max 180 znakov) — do hlášok. */
export function clip(s) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > 180 ? s.slice(0, 180) + '…' : s;
}

/** Vyberie formát nahrávky, ktorý prehliadač vie (Safari: audio/mp4, Chrome: webm). */
export function pickMime(isSupported) {
  const list = [['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg']];
  for (const [mime, ext] of list) { try { if (isSupported(mime)) return { mime, ext }; } catch { /* formát nepodporovaný — skús ďalší */ } }
  return { mime: '', ext: 'm4a' };
}

// ---------------- ElevenLabs ----------------

/** Rovnaké polia formulára ako Android (Pipeline.sendTranscribe). */
export function buildTranscribeForm(blob, ext) {
  const f = new FormData();
  f.append('model_id', ELEVEN_MODEL);
  f.append('language_code', LANGUAGE);
  f.append('tag_audio_events', 'false');
  f.append('diarize', 'false');
  f.append('file', blob, 'audio.' + ext);
  return f;
}

/** Prepis nahrávky. Vráti text; pri chybe hodí ApiError. */
export async function transcribe(blob, ext, key, f = fetch) {
  if (!key) throw new ApiError('Chýba ElevenLabs kľúč', 'Zadaj ho v Nastaveniach.');
  const r = await send(f, ELEVEN_URL, { method: 'POST', headers: { 'xi-api-key': key }, body: buildTranscribeForm(blob, ext) }, 120000);
  if (r.status !== 200) throw elevenError(r.status, r.body);
  try { return String(JSON.parse(r.body).text || '').trim(); }
  catch { throw new ApiError('Prepis: nečitateľná odpoveď', clip(r.body)); }
}

export function elevenError(code, body) {
  const b = body || '';
  const msg = serverMessage(b);
  if (code === 401 || /invalid_api_key|authentication_error/.test(b)) return new ApiError('Neplatný ElevenLabs kľúč', 'Vlož nový kľúč (sk_…) v Nastaveniach.');
  if (code === 429 || /quota/i.test(b)) return new ApiError('ElevenLabs: limit alebo kredit', msg);
  return new ApiError(`Prepis zlyhal (HTTP ${code})`, msg);
}

// ---------------- OpenAI ----------------

/** Telo požiadavky — rovnaké ako Android (Pipeline.polish). */
export function buildPolishBody(raw, systemPrompt) {
  return {
    model: GPT_MODEL, instructions: systemPrompt, input: raw,
    text: { format: { type: 'text' }, verbosity: 'low' },
    reasoning: { effort: 'none' }, store: false,
  };
}

/** Poskladá text z odpovede /v1/responses: output[type=message].content[type=output_text].text */
export function parsePolish(body) {
  const out = JSON.parse(body).output || [];
  let s = '';
  for (const item of out) {
    if (item.type !== 'message') continue;
    for (const c of item.content || []) if (c.type === 'output_text') s += c.text || '';
  }
  return s.trim();
}

/** Úprava jedného kúska textu; pri 429/5xx jedna rýchla opakovaná požiadavka. */
export async function polish(raw, systemPrompt, key, f = fetch, readMs = 45000) {
  if (!key) throw new ApiError('Chýba OpenAI kľúč', 'Zadaj ho v Nastaveniach.');
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(buildPolishBody(raw, systemPrompt)) };
  let r = await send(f, OPENAI_URL, init, readMs);
  if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 400)); r = await send(f, OPENAI_URL, init, readMs); }
  if (r.status !== 200) {
    const id = r.requestId ? ` [x-request-id ${r.requestId}]` : '';
    if (r.status === 401) throw new ApiError('Neplatný OpenAI kľúč', 'Vlož nový kľúč v Nastaveniach.');
    if (r.status === 429) throw new ApiError('OpenAI: limit alebo kredit', serverMessage(r.body) + id);
    throw new ApiError(`GPT zlyhal (HTTP ${r.status})`, serverMessage(r.body) + id);
  }
  try { return parsePolish(r.body); } catch { throw new ApiError('GPT: nečitateľná odpoveď', clip(r.body)); }
}

/**
 * Rýchla úprava: krátky text v jednej požiadavke, dlhý sa rozdelí a upraví PARALELNE (výstup GPT rastie s dĺžkou).
 * Časť, ktorá zlyhá, ostane neupravená. Vráti { text, failed, total }.
 */
export async function polishFast(raw, systemPrompt, key, f = fetch) {
  if (!shouldChunk(raw)) return { text: await polish(raw, systemPrompt, key, f, 45000), failed: 0, total: 1 };
  const parts = splitText(raw, CHUNK_TARGET);
  if (parts.length < 2) return { text: await polish(raw, systemPrompt, key, f, 45000), failed: 0, total: 1 };
  const results = await Promise.allSettled(parts.map(p => withTimeout(polish(p, systemPrompt, key, f, 25000), 40000)));
  let failed = 0, first = null;
  const out = results.map((r, i) => {
    if (r.status === 'fulfilled' && r.value) return r.value;
    failed++; if (r.status === 'rejected' && !first) first = r.reason;
    return parts[i];
  });
  if (failed === parts.length && first) throw first;     // úplné zlyhanie (napr. neplatný kľúč)
  return { text: joinParts(out), failed, total: parts.length };
}

// ---------------- delenie textu (TextChunker.java) ----------------

/** Delí sa len ak je text dlhý a neobsahuje „Windsurf" (inštrukcia medzi dvoma „Windsurf" sa nesmie rozdeliť). */
export function shouldChunk(t) {
  if (!t || t.length < MIN_TO_CHUNK) return false;
  const n = t.toLowerCase().replace(/\s+/g, ' ');
  return !(n.includes('windsurf') || n.includes('wind surf'));
}

/** Delí na koncoch viet na časti ≥ target znakov. Spojením cez medzeru vznikne pôvodný text. */
export function splitText(text, target) {
  const out = [];
  if (!text || !text.trim()) return out;
  let cur = '';
  for (const sentence of sentences(text.trim())) {
    for (const piece of hardSplit(sentence, target * 2)) {
      if (cur) cur += ' ';
      cur += piece;
      if (cur.length >= target) { out.push(cur); cur = ''; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Rozdelenie za .!?… nasledovanými medzerou (bez lookbehind — starší Safari by celý súbor odmietol). */
function sentences(t) {
  const res = []; let start = 0, m; const re = /[.!?…]\s+/g;
  while ((m = re.exec(t))) { res.push(t.slice(start, m.index + 1)); start = m.index + m[0].length; }
  res.push(t.slice(start));
  return res.filter(s => s.length);
}

/** Veta bez interpunkcie dlhšia než limit sa rozseká na najbližšej medzere. */
function hardSplit(s, limit) {
  const parts = []; let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Spojí upravené časti; medzi časti dá medzeru, ak predošlá nekončí odstavcom. */
export function joinParts(parts) {
  let sb = '';
  for (const p of parts) {
    if (sb && sb[sb.length - 1] !== '\n') sb += ' ';
    sb += p.replace(/^\s+/, '').replace(/[ \t]+$/, '');
  }
  return sb;
}

// ---------------- sieť ----------------

/** fetch s časovým limitom; vráti { status, body, requestId } alebo hodí ApiError so zrozumiteľným dôvodom. */
async function send(f, url, init, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await f(url, { ...init, signal: ctl.signal });
    const body = await res.text();
    return { status: res.status, body, requestId: res.headers && res.headers.get ? res.headers.get('x-request-id') : null };
  } catch (e) {
    const host = new URL(url).host;
    if (e && e.name === 'AbortError') throw new ApiError('Server neodpovedá', `Vypršal čas spojenia (${host}).`);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiError('Bez internetu', 'Zariadenie nie je pripojené k sieti.');
    // „Load failed" / „Failed to fetch" nerozlišuje internet od blokovaného spojenia — príčinu netvrdíme.
    throw new ApiError('Spojenie zlyhalo', `${clip(e && e.message)} (${host}) — príčina neznáma.`);
  } finally { clearTimeout(timer); }
}

function withTimeout(p, ms) {
  let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new ApiError('GPT: časový limit', 'Časť textu trvala príliš dlho.')), ms); })])
    .finally(() => clearTimeout(t));
}

/** Text chyby zo servera (JSON detail.message / error.message / message), inak telo odpovede — doslovne, skrátené. */
function serverMessage(body) {
  try {
    const j = JSON.parse(body);
    const m = (j.detail && (j.detail.message || (typeof j.detail === 'string' && j.detail))) || (j.error && j.error.message) || j.message;
    if (m) return clip(m);
  } catch { /* telo nie je JSON — použije sa doslovne nižšie */ }
  return clip(body);
}
