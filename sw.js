/* NT账本 · Service Worker
   策略：网络优先（在线时永远拿最新版本），失败再回退缓存 —— 断网也能打开。
   改了 index.html 只需重新上传，用户下次联网打开就会自动更新。 */
const CACHE = 'ledger-v268';
const ASSETS = ['./', './index.html', './manifest.json',
  './nt-splash-512.png', './nt-192.png', './nt-512.png',
  './nt-maskable-192.png', './nt-maskable-512.png',
  './nt-light-192.png', './nt-light-512.png',
  './nt-mono-192.png', './nt-mono-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    // cache: 'no-store' —— GitHub Pages 给 index.html 的 Cache-Control 是 max-age=600，
    // 不加这句，SW 的「网络优先」拿到的仍是 CDN 里最多 10 分钟前的旧页面。
    fetch(req, { cache: 'no-store' })
      .then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit => hit || caches.match('./index.html'))
      )
  );
});
