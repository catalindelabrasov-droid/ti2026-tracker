/* Service worker for dota2tileague.com.
 *
 * The job here is modest on purpose: make the app open instantly and survive a
 * dead connection on the train, without ever showing somebody a stale score.
 *
 * So the rule is split by what the thing is:
 *   - the page itself and the results file go to the network first, because a
 *     result from twenty minutes ago is worse than a spinner;
 *   - icons and other static files come from the cache first, because they
 *     never change without the cache version changing too;
 *   - anything cross-origin (Supabase, Google Fonts) is left alone entirely.
 *     Tournaments, the ladder and sign-in are all live data — caching them
 *     would mean a captain reporting a result against a bracket that has
 *     already moved.
 */

const VERSION = 'v4';
const SHELL   = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      // One bad URL must not fail the whole install, or the app silently never
      // becomes installable.
      .then(cache => Promise.allSettled(PRECACHE.map(u => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Let the page tell a waiting worker to take over immediately.
self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // An offline navigation with nothing cached still has to render something.
    if (request.mode === 'navigate') {
      const shell = await caches.match('/index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const cache = await caches.open(cacheName);
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

/* ------------------------------------------------------------------ push --
 * This is the part that works with the app shut. The page cannot do it: a
 * notification fired from the page only exists while the page does, which is
 * precisely when you do not need telling that a match started.
 */
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data && event.data.text() }; }

  const title = d.title || 'Dota 2 TI League';
  const options = {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    // Same tag replaces rather than stacks, so a phone left alone all evening
    // does not come back to forty separate notifications.
    tag: d.tag || 'ti',
    renotify: true,
    data: { url: d.url || '/' },
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse a window that is already open rather than piling up new ones.
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ('navigate' in c) await c.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// The browser can retire a subscription on its own; re-register silently so
// the user does not quietly stop receiving anything.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription || await self.registration.pushManager.getSubscription();
      const key = old && old.options && old.options.applicationServerKey;
      if (!key) return;
      const fresh = await self.registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: key,
      });
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach(c => c.postMessage({ type: 'resubscribe', sub: fresh.toJSON() }));
    } catch (e) { /* nothing useful to do here */ }
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // Supabase, fonts: hands off

  if (request.mode === 'navigate' || url.pathname === '/index.html') {
    event.respondWith(networkFirst(request, SHELL));
    return;
  }
  if (url.pathname === '/data.json') {
    event.respondWith(networkFirst(request, RUNTIME));
    return;
  }
  event.respondWith(cacheFirst(request, RUNTIME));
});
