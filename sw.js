const CACHE_NAME = 'nexus-launcher-v3';
const ASSETS_TO_CACHE = [
    './index.html',
    './manifest.json',
    './gamefile.html',
    './gamefilebetter.html'
];

// Install Event
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Caching essential assets');
                return cache.addAll(ASSETS_TO_CACHE);
            })
    );
});

// Activate Event
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(key => /^nexus-launcher-v[0-9]+$/.test(key) && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        })
    );
});

// Fetch Event (Offline Support)
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.open(CACHE_NAME)
            .then((cache) => cache.match(event.request))
            .then((cachedResponse) => {
                return cachedResponse || fetch(event.request);
            })
    );
});
