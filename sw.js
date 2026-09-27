/* TwinGaze service worker: keeps the app working with no network.
 * App files: network first (so updates show up), cache as the fallback.
 * Fonts: cache first. The models and the ONNX runtime are cached the first time a scan loads them. */
const CACHE = 'twingaze-v26';
const SHELL = [
  './', 'index.html', 'css/app.css',
  'js/native.js', 'js/detector.js', 'js/sensors.js', 'js/audio.js', 'js/voice.js', 'js/recognizer.js', 'js/infer-worker.js', 'js/radio.js', 'js/spyware-db.js', 'js/guard.js', 'js/net.js', 'js/trackers.js', 'js/safety.js', 'js/agent.js', 'js/app.js',
  'vendor/fonts/fonts.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))));
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    })));
  }
});
