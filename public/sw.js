const CACHE = 'tradesignal-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => cached))
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'TradeSignal AI';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    tag: data.tag || 'signal',
    renotify: true,
    requireInteraction: data.important || false,
    data: { url: data.url || '/', signal: data.signal },
    actions: [
      { action: 'view', title: 'Grafiği Gör' },
      { action: 'dismiss', title: 'Kapat' }
    ]
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'view' || !e.action) {
    e.waitUntil(clients.openWindow(e.notification.data.url || '/'));
  }
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, important, signal } = e.data;
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: tag || 'signal',
      renotify: true,
      requireInteraction: important || false,
      data: { signal },
      actions: [
        { action: 'view', title: 'Grafiği Gör' },
        { action: 'dismiss', title: 'Kapat' }
      ]
    });
  }
});
