const CACHE_NAME = 'fusion-share-v1';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/manifest.json',
    '/icon.svg'
];

// Install event: cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

// Activate event: clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch event: Network first for navigation/API, Cache fallback for static
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 1. WebSocket / WebRTC signaling (Critical: Do not cache)
    if (url.protocol === 'ws:' || url.protocol === 'wss:' || url.pathname.includes('/socket.io') || url.pathname.includes('/signaling')) {
        return;
    }

    // 2. Navigation requests (HTML): Network first, fall back to cache
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(() => {
                return caches.match('/index.html');
            })
        );
        return;
    }

    // 3. Static assets: Cache first
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
