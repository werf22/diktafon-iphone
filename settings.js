/**
 * settings.js — okno Nastavenia: API kľúče, prepínače, log.
 *
 * WHAT:  openSettings(note) otvorí okno; bindSettings() pripojí jeho tlačidlá (volá sa raz pri štarte).
 * WHY:   Kľúče sa píšu priamo v iPhone a ostávajú len v ňom (store.js); na obrazovke sa ukazuje len ich maska.
 */
import * as store from './store.js';

export const VERSION = '1.8-ios';
const $ = id => document.getElementById(id);

function showMasks() {
  $('maskEleven').textContent = '— ' + store.mask(store.get('elevenKey'));
  $('maskOpenai').textContent = '— ' + store.mask(store.get('openaiKey'));
  $('elevenKey').value = ''; $('openaiKey').value = '';
}

function say(text) { $('saved').textContent = text; $('saved').hidden = false; }

export function openSettings(note) {
  showMasks();
  $('gpt').checked = store.get('gpt'); $('autoCopy').checked = store.get('autoCopy');
  $('saved').hidden = true;
  $('settingsNote').hidden = !note; $('settingsNote').textContent = note || '';
  $('ver').textContent = 'v' + VERSION; $('logText').textContent = store.getLog() || '(prázdny)';
  $('settings').hidden = false;
}

function save() {
  let ok = true;
  const e = $('elevenKey').value.trim(), o = $('openaiKey').value.trim();
  if (e) ok = store.set('elevenKey', e) && ok;
  if (o) ok = store.set('openaiKey', o) && ok;
  ok = store.set('gpt', $('gpt').checked) && ok;
  ok = store.set('autoCopy', $('autoCopy').checked) && ok;
  showMasks();
  say(ok ? '✓ Uložené.' : 'Uloženie zlyhalo — prehliadač nepustil zápis (súkromné okno?).');
}

async function copyLog() {
  try { await navigator.clipboard.writeText(store.getLog()); say('✓ Log skopírovaný.'); }
  catch (e) { say('Log sa nepodarilo skopírovať: ' + e.name); }
}

export function bindSettings() {
  $('gear').addEventListener('click', () => openSettings());
  $('close').addEventListener('click', () => { $('settings').hidden = true; });
  $('save').addEventListener('click', save);
  $('wipe').addEventListener('click', () => { store.remove('elevenKey'); store.remove('openaiKey'); showMasks(); say('Kľúče zmazané.'); });
  $('copyLog').addEventListener('click', copyLog);
  $('clearLog').addEventListener('click', () => { store.clearLog(); $('logText').textContent = '(prázdny)'; });
}
