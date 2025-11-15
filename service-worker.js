const CACHE_NAME = 'chaterly-cache-v1';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './auth.js',
  './chat.js',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); })
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Try cache first, then network
  event.respondWith(
    caches.match(event.request).then((resp) => {
      return resp || fetch(event.request).catch(() => {
        // Fallback to cached index.html for navigation requests
        if (event.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});

// Handle incoming push messages (if configured server-side)
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'New message', body: event.data ? event.data.text() : 'You have a new message' };
  }

  const title = payload.title || 'New message';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon.png',
    badge: payload.badge || '/icon.png',
    data: payload.data || {}
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const chatRoomId = data.chatRoomId;
  const friendId = data.friendId;

  // Try to focus an existing client, otherwise open a new window
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          client.focus();
          // Send message to client to open the chat
          client.postMessage({ action: 'openChat', friendId });
          return;
        }
      }
      // No client found, open a new window
      if (self.clients.openWindow) {
        const url = chatRoomId ? `/?openChat=${chatRoomId}` : '/';
        return self.clients.openWindow(url);
      }
    })
  );
});

self.addEventListener('notificationclose', (event) => {
  // Could handle analytics here
});
