// عامل الخدمة: يخلي التطبيق يفتح بدون نت، ويجيب الأسعار من الشبكة أولاً
const VERSION = 'mahfazti-v1';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'data/tickers.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // الأسعار والكود: الشبكة أولاً، والنسخة المحفوظة لو ما فيه نت
  const networkFirst = url.pathname.endsWith('/data/market.json') || url.origin === location.origin;
  if (networkFirst) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          const key = url.pathname.endsWith('/data/market.json') ? new Request(url.origin + url.pathname) : e.request;
          caches.open(VERSION).then((c) => c.put(key, copy));
        }
        return res;
      }).catch(() => caches.match(url.pathname.endsWith('/data/market.json') ? url.origin + url.pathname : e.request))
    );
    return;
  }

  // الخطوط: من الكاش ثم تحديث بالخلفية
  if (url.host.includes('fonts.g')) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
