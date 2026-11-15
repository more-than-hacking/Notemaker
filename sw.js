/* Notemaker service worker — cache-first app shell so the app works offline.
   Bump CACHE when shipping changes to any file below. */
const CACHE = 'notemaker-shell-v2.1.0';
const SHELL = [
    './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
    'js/vault-core.js', 'js/native.js', 'js/vault-store.js', 'js/ui-vault.js',
    'js/core.js', 'js/store.js', 'js/ui-common.js', 'js/ui-day.js', 'js/ui-notes.js', 'js/ui-detail.js', 'js/ui-calendar.js',
    'js/ui-planner.js', 'js/ui-board.js', 'js/ui-habits.js', 'js/ui-insights.js', 'js/ui-settings.js', 'js/ui-overlays.js',
    'js/focus.js', 'js/reminders.js',
    'web-icons/favicon.svg', 'web-icons/icon-32.png', 'web-icons/icon-180.png', 'web-icons/icon-192.png', 'web-icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('notemaker-') && k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // never touch third-party requests (e.g. note images)
    event.respondWith(
        caches.match(req, { ignoreSearch: true }).then((hit) => {
            if (hit) return hit;
            return fetch(req).then((res) => {
                if (res && res.ok && res.type === 'basic') {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                }
                return res;
            }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
        for (const c of list) if ('focus' in c) return c.focus();
        return self.clients.openWindow ? self.clients.openWindow('./') : undefined;
    }));
});
