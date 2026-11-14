/**
 * app.js — obrazovka a ovládanie Diktafónu pre iPhone.
 *
 * WHAT:  ťuk = nahrávanie, ďalší ťuk = koniec → ElevenLabs prepis → (voliteľne) GPT úprava → text sa skopíruje do schránky.
 * WHY:   iOS nedovoľuje appke počúvať aktivačné slovo na pozadí ani vkladať text do inej appky, preto je to ťuknutím a vložením.
 * FLOW:  nahrávka sa PRED odoslaním uloží (store.pendingPut) — pri chybe ostane a dá sa poslať znova.
 * TWEAK: texty stavov v LABELS; dĺžka nahrávky a modely v core.js.
 */
import * as core from './core.js';
import * as store from './store.js';
import { openSettings, bindSettings } from './settings.js';

const $ = id => document.getElementById(id);
const LABELS = {
  idle: 'Ťukni a diktuj', recording: 'Nahrávam… ťukni na koniec', transcribing: 'Prepisujem…',
  polishing: 'Upravujem text…', done: 'Hotovo — ťukni na novú nahrávku', error: 'Ťukni a skús znova',
};

let state = 'idle';
let systemPrompt = null;
let rec = null, stream = null, chunks = [], recExt = 'm4a', startedAt = 0, timer = 0;
let audioCtx = null, raf = 0, peak = 0, wakeLock = null;
let armed = null;      // zápis do schránky pripravený v ťuknutí na „koniec" (Safari ho povolí len z ťuknutia)

function setState(s) { state = s; document.body.dataset.state = s; $('mainLabel').textContent = LABELS[s]; $('main').setAttribute('aria-label', LABELS[s]); }

// ---------------- hlášky ----------------

function showMsg(title, text, kind = 'err', retry = false) {
  $('msg').className = 'card ' + kind;
  $('msgTitle').textContent = title; $('msgText').textContent = text || '';
  $('retry').hidden = !retry; $('msg').hidden = false;
}
function hideMsg() { $('msg').hidden = true; }

function fail(e, keepPending) {
  const err = e instanceof core.ApiError ? e : new core.ApiError('Neočakávaná chyba', `${e && e.name}: ${core.clip(e && e.message)}`);
  store.log('error', `${err.title} — ${err.message}`);
  if (armed) { armed.reject(err); armed = null; }
  setState('error');
  showMsg(err.title, err.message, 'err', keepPending);
}

// ---------------- nahrávanie ----------------

function micError(e) {
  if (e && e.name === 'NotAllowedError') return new core.ApiError('Mikrofón nie je povolený', 'Nastavenia iPhonu → Safari → Mikrofón → Povoliť (alebo v Safari ťukni na aA → Nastavenia webovej stránky → Mikrofón).');
  if (e && e.name === 'NotFoundError') return new core.ApiError('Mikrofón sa nenašiel', 'Zariadenie nemá dostupný mikrofón.');
  return new core.ApiError('Mikrofón sa nespustil', `${e && e.name}: ${core.clip(e && e.message)}`);
}

async function startRecording() {
  hideMsg(); $('resultCard').hidden = true;
  // Neodoslaná nahrávka sa nesmie ticho prepísať novou — najprv ju treba odoslať alebo zahodiť.
  if (await checkPending()) return showMsg('Máš neodoslanú nahrávku', 'Najprv ju odošli („Odoslať znova“) alebo zahoď, aby sa neprepísala.', 'warn');
  if (!store.get('elevenKey')) return openSettings('Najprv vlož ElevenLabs kľúč.');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder)
    return fail(new core.ApiError('Nahrávanie nie je podporované', 'Otvor appku v Safari na iOS 14.5 alebo novšom.'), false);
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { return fail(micError(e), false); }

  const { mime, ext } = core.pickMime(m => MediaRecorder.isTypeSupported(m));
  recExt = ext; chunks = []; peak = 0;
  try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (e) { releaseStream(); return fail(new core.ApiError('Nahrávanie sa nespustilo', `${e.name}: ${core.clip(e.message)}`), false); }
  rec.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  rec.onerror = ev => { store.log('error', 'MediaRecorder: ' + (ev.error && ev.error.name)); stopRecording(false); };
  rec.onstop = onRecorded;
  stream.getAudioTracks().forEach(t => { t.onended = () => { store.log('warn', 'Mikrofón sa prerušil'); stopRecording(false); }; });
  try { rec.start(); }
  catch (e) { releaseStream(); return fail(new core.ApiError('Nahrávanie sa nespustilo', `${e.name}: ${core.clip(e.message)} (príčina neznáma — skús appku zavrieť a znova otvoriť)`), false); }
  startedAt = Date.now();
  store.log('info', `Nahrávam (${rec.mimeType || 'predvolený formát'})`);
  warmUp(); startMeter(); keepAwake();
  $('timer').hidden = false; $('level').hidden = false; tick();
  timer = setInterval(tick, 250);
  setState('recording');
}

function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s >= core.MAX_RECORD_SEC) stopRecording(false);
}

/** Zahreje spojenie (DNS+TLS) ešte kým hovoríš, aby prvé odoslanie nestrácalo čas. */
function warmUp() {
  const hosts = ['https://api.elevenlabs.io/'].concat(store.get('gpt') ? ['https://api.openai.com/'] : []);
  hosts.forEach(u => fetch(u, { method: 'HEAD', mode: 'no-cors' }).catch(e => store.log('debug', 'Zahriatie spojenia zlyhalo (nevadí): ' + e.name)));
}

/** Ukazovateľ hlasitosti — vidíš, že mikrofón ťa počuje. Zlyhanie nie je kritické, appka nahráva ďalej. */
function startMeter() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    audioCtx.resume().catch(e => store.log('debug', 'AudioContext.resume: ' + e.name));   // iOS ho štartuje pozastavený
    const an = audioCtx.createAnalyser(); an.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      peak = Math.max(peak, lvl); $('level').style.setProperty('--lvl', lvl.toFixed(2));
      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) { store.log('warn', 'Ukazovateľ hlasitosti sa nespustil: ' + e.name); }
}

async function keepAwake() {
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e) { store.log('warn', 'Obrazovka sa nedá držať zapnutá: ' + e.name); }
}

function releaseStream() {
  clearInterval(timer); cancelAnimationFrame(raf);
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close().catch(e => store.log('debug', 'AudioContext.close: ' + e.name));
  if (wakeLock) wakeLock.release().catch(e => store.log('debug', 'wakeLock.release: ' + e.name));
  stream = audioCtx = wakeLock = null;
  $('timer').hidden = true; $('level').hidden = true;
}

/** Zápis do schránky sa musí začať priamo v ťuknutí; text dodáme, až keď je prepis hotový. */
function armClipboard() {
  if (!store.get('autoCopy') || !navigator.clipboard || !window.ClipboardItem) return null;
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  const blob = p.then(t => new Blob([t], { type: 'text/plain' }));
  blob.catch(() => { /* chybu už hlási fail() — toto len zabráni druhému, všeobecnému hláseniu tej istej chyby */ });
  try {
    const written = navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
      .then(() => true, e => { store.log('warn', 'Schránka: ' + e.name); return false; });
    return { resolve, reject, written };
  } catch (e) { store.log('warn', 'Schránka sa nepripravila: ' + e.name); return null; }
}

function stopRecording(fromTap) {
  if (state !== 'recording' || !rec || rec.state === 'inactive') return;
  armed = fromTap ? armClipboard() : null;
  rec.stop();
}

async function onRecorded() {
  const seconds = (Date.now() - startedAt) / 1000;
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/mp4' });
  releaseStream();
  store.log('info', `Nahrávka ${seconds.toFixed(1)} s, ${Math.round(blob.size / 1024)} kB, úroveň ${Math.round(peak * 100)} %`);
  if (seconds < 0.6 || blob.size < 500) return fail(new core.ApiError('Príliš krátka nahrávka', 'Skús hovoriť dlhšie.'), false);
  await process(blob, recExt);
}

// ---------------- spracovanie: prepis → úprava → výsledok ----------------

async function process(blob, ext) {
  const t0 = Date.now();
  try { await store.pendingPut({ blob, ext, ts: Date.now() }); }
  catch (e) { store.log('warn', 'Nahrávka sa neuložila pre prípad zlyhania: ' + e.name); }
  let raw;
  try { setState('transcribing'); raw = await core.transcribe(blob, ext, store.get('elevenKey')); }
  catch (e) { return fail(e, true); }
  store.log('info', `Prepis OK: ${raw.length} znakov za ${Date.now() - t0} ms`);
  if (!raw) {
    await dropPending();
    const lvl = peak > 0 ? ` (najsilnejší zvuk ${Math.round(peak * 100)} %)` : '';
    return fail(new core.ApiError('Prázdny prepis', `Nahrávka neobsahovala rozpoznateľnú reč${lvl}.`), false);
  }
  let text = raw, warn = '';
  if (store.get('gpt')) {
    if (!systemPrompt) warn = 'Prompt na úpravu sa nenačítal — text je neupravený.';
    else try {
      setState('polishing');
      const t1 = Date.now();
      const r = await core.polishFast(raw, systemPrompt, store.get('openaiKey'));
      if (r.text) text = r.text;
      if (r.failed) warn = `${r.failed} z ${r.total} častí ostalo neupravených (pomalá sieť alebo limit).`;
      store.log('info', `GPT OK: ${text.length} znakov za ${Date.now() - t1} ms (${r.total} č.)`);
    } catch (e) {
      warn = `GPT nefungoval — vložený neupravený text. ${e.title}: ${e.message}`;
      store.log('error', 'GPT zlyhal: ' + e.title);
    }
  }
  await dropPending();
  finish(text, raw, warn);
}

async function dropPending() { try { await store.pendingDel(); } catch (e) { store.log('warn', 'Uloženú nahrávku sa nepodarilo zmazať: ' + e.name); } }

async function finish(text, raw, warn) {
  store.saveLast({ text, raw, ts: Date.now() });
  showResult(text);
  setState('done');
  if (warn) showMsg('Upozornenie', warn, 'warn'); else hideMsg();
  let copied = false;
  if (armed) { armed.resolve(text); copied = await armed.written; armed = null; }
  setCopied(copied ? '✓ Skopírované do schránky — vlož kdekoľvek (podrž prst → Prilepiť).' : 'Ťukni na Kopírovať a vlož text, kam potrebuješ.');
}

function showResult(text) { $('result').value = text; $('resultCard').hidden = false; $('copied').hidden = true; }
function setCopied(t) { $('copied').textContent = t; $('copied').hidden = false; }

// ---------------- tlačidlá výsledku ----------------

async function copyText() {
  const t = $('result').value;
  try { await navigator.clipboard.writeText(t); return setCopied('✓ Skopírované do schránky.'); }
  catch (e) { store.log('warn', 'clipboard.writeText: ' + e.name); }
  const ta = $('result'); ta.focus(); ta.select(); ta.setSelectionRange(0, t.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) { store.log('warn', 'execCommand: ' + e.name); }
  setCopied(ok ? '✓ Skopírované do schránky.' : 'Skopírovanie zlyhalo — text je označený, podrž prst → Kopírovať.');
}

async function shareText() {
  if (!navigator.share) return setCopied('Zdieľanie tento prehliadač nepodporuje — použi Kopírovať.');
  try { await navigator.share({ text: $('result').value }); }
  catch (e) { if (e.name !== 'AbortError') store.log('warn', 'share: ' + e.name); }
}

// ---------------- neodoslaná nahrávka ----------------

async function checkPending() {
  try { const p = await store.pendingGet(); $('pending').hidden = !p; return p; }
  catch (e) { store.log('warn', 'IndexedDB nedostupná: ' + e.name); return null; }
}
async function sendPending() {
  const p = await checkPending();
  if (!p) return showMsg('Nahrávka sa nenašla', 'Uložená nahrávka už nie je v zariadení — nahraj text znova.', 'warn');
  $('pending').hidden = true; hideMsg(); peak = 0; await process(p.blob, p.ext);
}

// ---------------- štart ----------------

let starting = false;      // ochrana proti dvojitému ťuknutiu, kým iPhone čaká na povolenie mikrofónu
$('main').addEventListener('click', () => {
  if (state === 'recording') return stopRecording(true);
  if (starting || !(state === 'idle' || state === 'done' || state === 'error')) return;
  starting = true;
  startRecording().catch(e => { releaseStream(); fail(e, false); }).finally(() => { starting = false; });
});
bindSettings();
$('copy').addEventListener('click', copyText);
$('share').addEventListener('click', shareText);
$('clear').addEventListener('click', () => { $('resultCard').hidden = true; $('result').value = ''; store.clearLast(); setState('idle'); });
$('retry').addEventListener('click', sendPending);
$('pendingSend').addEventListener('click', sendPending);
$('pendingDrop').addEventListener('click', async () => { await dropPending(); $('pending').hidden = true; });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state === 'recording') keepAwake(); });
/** Poistka: čokoľvek nečakané sa zapíše do logu AJ ukáže na obrazovke — appka nikdy nezamrzne ticho. */
function unexpected(what) {
  store.log('error', 'Nečakaná chyba: ' + what);
  if (state === 'transcribing' || state === 'polishing') setState('error');
  showMsg('Neočakávaná chyba', what + ' — podrobnosti sú v Nastaveniach (Log).', 'err');
}
window.addEventListener('error', ev => unexpected(core.clip(ev.message)));
window.addEventListener('unhandledrejection', ev => unexpected(core.clip(ev.reason && (ev.reason.message || ev.reason))));

(async function init() {
  setState('idle');
  if (/iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches) $('install').hidden = false;
  const last = store.loadLast();
  if (last && last.text) { showResult(last.text); setCopied('Posledný výsledok.'); }
  await checkPending();
  try { const r = await fetch('system_prompt.txt'); if (!r.ok) throw new Error('HTTP ' + r.status); systemPrompt = await r.text(); }
  catch (e) { store.log('error', 'Prompt sa nenačítal: ' + e.message); showMsg('Prompt na úpravu sa nenačítal', 'Prepis funguje, ale text nebude upravený cez GPT.', 'warn'); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => store.log('warn', 'Offline režim sa nespustil: ' + e.name));
  if (!store.get('elevenKey')) openSettings('Vlož ElevenLabs a OpenAI kľúč (tie isté ako na tablete).');
})();
