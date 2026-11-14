/**
 * store.js — ukladanie v zariadení: nastavenia + API kľúče, posledný výsledok, neodoslaná nahrávka a log.
 *
 * WHAT:  localStorage (nastavenia, kľúče, posledný výsledok, log) a IndexedDB (nahrávka čakajúca na prepis).
 * WHY:   Nahrávka sa uloží ešte PRED odoslaním — ak zlyhá sieť alebo iOS appku zavrie, diktát sa nestratí.
 * SECURITY: Kľúče sú len v tomto zariadení (localStorage tejto appky), nikdy v kóde ani v logu.
 *        Log sa na úrovni loggera zbavuje všetkého, čo vyzerá ako kľúč, a nikdy nenesie obsah diktátu.
 * TWEAK: MAX_LOG = koľko riadkov logu sa pamätá.
 */

const DEFAULTS = { elevenKey: '', openaiKey: '', gpt: '1', autoCopy: '1' };
const BOOL = new Set(['gpt', 'autoCopy']);
const MAX_LOG = 120;

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { console.warn('localStorage nedostupný', e.name); return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { console.warn('localStorage zápis zlyhal', e.name); return false; } }

/** Hodnota nastavenia (booleany ako true/false, kľúče ako text). */
export function get(name) {
  const v = lsGet('dk_' + name);
  const val = v === null ? DEFAULTS[name] : v;
  return BOOL.has(name) ? val === '1' : val;
}

/** Uloží nastavenie; vráti false, ak ho prehliadač neuložil (súkromné okno, plné úložisko). */
export function set(name, v) { return lsSet('dk_' + name, typeof v === 'boolean' ? (v ? '1' : '0') : String(v).trim()); }

export function remove(name) { try { localStorage.removeItem('dk_' + name); } catch (e) { console.warn('localStorage mazanie zlyhalo', e.name); } }

/** „sk_…a1b2" — na zobrazenie, nikdy celý kľúč. */
export function mask(k) {
  if (!k) return '(nenastavený)';
  return k.length < 10 ? '(nastavený)' : k.slice(0, 3) + '…' + k.slice(-4);
}

// ---------------- posledný výsledok ----------------

export function saveLast(o) { return lsSet('dk_last', JSON.stringify(o)); }
export function loadLast() { try { return JSON.parse(lsGet('dk_last')); } catch { return null; } }
export function clearLast() { remove('last'); }

// ---------------- log (bez kľúčov a bez obsahu diktátu) ----------------

let lines = (() => { try { const a = JSON.parse(lsGet('dk_log')); return Array.isArray(a) ? a : []; } catch { return []; } })();

export function log(level, msg) {
  const clean = String(msg).replace(/(sk[-_]|xi-)[A-Za-z0-9_-]{6,}/g, '$1…');
  const line = `${new Date().toISOString().slice(11, 19)} ${level.toUpperCase()} ${clean}`;
  lines.push(line);
  if (lines.length > MAX_LOG) lines.shift();
  lsSet('dk_log', JSON.stringify(lines));
  (console[level] || console.log).call(console, line);
}
export function getLog() { return lines.join('\n'); }
export function clearLog() { lines = []; remove('log'); }

// ---------------- nahrávka čakajúca na prepis (IndexedDB) ----------------

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('diktafon', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => { d.close(); res(req && req.result); };
    t.onerror = t.onabort = () => { d.close(); rej(t.error); };
  });
}
export const pendingPut = rec => tx('readwrite', s => s.put(rec, 'pending'));
export const pendingGet = () => tx('readonly', s => s.get('pending'));
export const pendingDel = () => tx('readwrite', s => s.delete('pending'));
