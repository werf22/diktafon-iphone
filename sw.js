/**
 * sw.js — offline režim: appka sa otvorí aj bez internetu (prepis samozrejme internet potrebuje).
 * Súbory appky sa berú najprv zo siete (nová verzia príde hneď), a keď sieť nie je, z pamäte.
 * Volania na ElevenLabs/OpenAI sa sem nedostanú — iná doména, nechávame ich prehliadaču.
 * TWEAK: pri zmene súborov zvýš CACHE (v1 → v2), stará pamäť sa sama zmaže.
 */
const CACHE = 'diktafon-ios-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'store.js', 'settings.js', 'system_prompt.txt',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(hit => hit || Promise.reject(new Error('offline a nie je v pamäti: ' + u.pathname)))));
});
