/* NT账本 · Service Worker
   策略：**缓存优先**（用本地版本启动，快且离线可用）。
   想换新版时，去「校验」页点「检查更新」，由页面发 SKIP_WAITING 让新 SW 接管。 */
const CACHE = 'ledger-v274';
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
    // 先看本地：命中就直接用，秒开，也不再每次启动去拉网络
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req, { cache: 'no-store' }).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

// 页面点「检查更新」时会发这条消息，让新 SW 立刻接管
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
