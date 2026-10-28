// 金融データやAPIレスポンスはキャッシュしない。通信できないときは保存済みと表示しない。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
