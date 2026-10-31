// HelioPV Background Service Worker for Native Web Push Notifications
// Wakes up in background even when browser/app is closed or minimized

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Solar String Alert', body: event.data.text() };
    }
  }

  const title = data.title || '🚨 Solar String Fault Detected!';
  const options = {
    body: data.body || 'A disconnection or wire break was detected.',
    icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
    badge: data.badge || 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
    vibrate: data.vibrate || [300, 150, 300, 150, 300],
    tag: 'solar-fault-' + Date.now(),
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.url || '/?view=monitor'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/?view=monitor';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          if ('navigate' in client) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
