const SCOPE_URL = new URL(self.registration.scope);
const START_URL = new URL('./index.html', SCOPE_URL).href;
const CACHE_PREFIX = `nexus-launcher:${encodeURIComponent(SCOPE_URL.pathname)}:v`;
const CACHE_NAME = CACHE_PREFIX + '4';
const ASSETS_TO_CACHE = [
    './index.html',
    './manifest.json',
    './gamefile.html',
    './gamefilebetter.html',
    './assets/tailwind.css',
    './assets/fonts.css',
    './assets/fonts/inter-latin.woff2',
    './assets/fonts/orbitron-latin.woff2',
    './gamerz.png',
    './eagle192.png',
    './eagle512.png',
    './apple-touch-icon.png'
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
                // Legacy global caches may still serve another installed scope.
                keys.filter(key => key.startsWith(CACHE_PREFIX) && /^[0-9]+$/.test(key.slice(CACHE_PREFIX.length)) && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        })
    );
});

// Fetch Event (Offline Support)
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    // Only launcher navigations share the canonical shell; other requests stay exact.
    const isLauncherNavigation = request.method === 'GET' && request.mode === 'navigate' &&
        url.origin === SCOPE_URL.origin &&
        (url.pathname === SCOPE_URL.pathname || url.pathname === new URL(START_URL).pathname);
    const lookup = isLauncherNavigation ? START_URL : request;
    event.respondWith(
        caches.open(CACHE_NAME)
            .then((cache) => cache.match(lookup))
            .then((cachedResponse) => {
                return cachedResponse || fetch(request);
            })
    );
});
