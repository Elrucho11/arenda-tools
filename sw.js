/* Service worker ОТКЛЮЧЁН.
   Раньше он кэшировал файлы и подсовывал старые версии. Теперь он самоудаляется
   и чистит все кэши — чтобы устройства всегда получали свежую версию приложения. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => c.navigate(c.url));
    } catch (e) { /* ignore */ }
  })());
});

// Никакого кэширования — всегда из сети.
self.addEventListener('fetch', () => {});
