self.addEventListener('push', (event) => {
  let payload = { title: '약속 시간이에요', body: '복약 시간을 확인해주세요' };
  try {
    if (event.data) payload = event.data.json();
  } catch (e) { /* ignore parse error, use default */ }

  const targetUrl = (payload.data && payload.data.url) || payload.url || '/';
  const targetId = (payload.data && payload.data.target) || payload.target || '';

  const options = {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    requireInteraction: true,
    data: {
      url: targetUrl,
      target: targetId,
      ...(payload.data || {})
    },
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};
  const targetUrl = notifData.url || '/';
  const targetId = notifData.target || '';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 1. 이미 열려있는 창이 있으면 포커스 후 타겟 이동 메시지 전송
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({
            type: 'NAVIGATE_TARGET',
            url: targetUrl,
            target: targetId,
            data: notifData,
          });
          return;
        }
      }
      // 2. 열려있는 창이 없으면 타겟 URL로 새 창 열기
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
