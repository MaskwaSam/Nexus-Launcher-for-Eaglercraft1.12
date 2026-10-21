// Optional native service-worker checks; requires Playwright and Chromium.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.NEXUS_PLAYWRIGHT_MODULE || 'playwright');

const root = path.join(__dirname, '..');
const output = process.env.NEXUS_SW_BROWSER_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sw-'));
fs.mkdirSync(output, { recursive: true });
const candidate = fs.readFileSync(process.env.NEXUS_SW_FILE || path.join(root, 'sw.js'));
const candidateSource = candidate.toString('utf8');
const CACHE_VERSION = 5;
const precache = candidateSource.match(/const ASSETS_TO_CACHE\s*=\s*\[([\s\S]*?)\];/);
if (!precache) throw new Error('Candidate service worker has no recognizable ASSETS_TO_CACHE array');
const assets = [...precache[1].matchAll(/["']([^"']+)["']/g)].map(match => match[1].replace(/^\.\//, ''));
if (assets.length !== 16) throw new Error(`Expected 16 candidate precache assets, found ${assets.length}`);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expected = Object.fromEntries(assets.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const scopedCacheName = (base, version = CACHE_VERSION) => `nexus-launcher:${encodeURIComponent(new URL(base).pathname)}:v${version}`;
const results = { checks: [], requests: [], limitations: [
    'Local Chromium automation, not an installed-PWA or physical-device acceptance test.',
    'Offline checks cover the candidate service worker precache and exact navigation aliases; other uncached paths require network.'
] };
const check = name => { results.checks.push({ name, status: 'pass' }); console.log('PASS ' + name); };
// Model the legacy global-cache layouts, including the v1 launcher.html shell.
function legacy(version) {
    const files = [version === 1 ? './launcher.html' : './index.html', './manifest.json', './gamefile.html', './gamefilebetter.html'];
    const cleanup = version === 1 ? 'key !== CACHE_NAME' : "key.startsWith('nexus-launcher-') && key !== CACHE_NAME";
    return `const CACHE_NAME = 'nexus-launcher-v${version}';
const ASSETS_TO_CACHE = ${JSON.stringify(files)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE))));
 self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => ${cleanup}).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(response => response || fetch(event.request))));`;
}
const legacyMarker = Buffer.from('<!-- legacy layout fixture -->\n');
let phase = '', distribution = 'candidate', failAsset = false, legacyVersion = 1;
let origin;

function scopedV4() {
    return `const SCOPE_URL = new URL(self.registration.scope);
const START_URL = new URL('./index.html', SCOPE_URL).href;
const CACHE_PREFIX = 'nexus-launcher:' + encodeURIComponent(SCOPE_URL.pathname) + ':v';
const CACHE_NAME = CACHE_PREFIX + '4';
const ASSETS_TO_CACHE = ['./index.html', './manifest.json', './gamefile.html', './gamefilebetter.html', './assets/tailwind.css', './assets/fonts.css', './assets/fonts/inter-latin.woff2', './assets/fonts/orbitron-latin.woff2', './gamerz.png', './eagle192.png', './eagle512.png', './apple-touch-icon.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && /^[0-9]+$/.test(key.slice(CACHE_PREFIX.length)) && key !== CACHE_NAME).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
    const request = event.request, url = new URL(request.url);
    const isLauncherNavigation = request.method === 'GET' && request.mode === 'navigate' && url.origin === SCOPE_URL.origin && (url.pathname === SCOPE_URL.pathname || url.pathname === new URL(START_URL).pathname);
    const lookup = isLauncherNavigation ? START_URL : request;
    event.respondWith(caches.open(CACHE_NAME).then(cache => cache.match(lookup)).then(response => response || fetch(request)));
});`;
}

async function contextFor(browser) {
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    return context;
}

async function activated(page) {
    await page.evaluate(async () => {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            if ((await navigator.serviceWorker.getRegistration())?.active?.state === 'activated') return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Service worker did not activate');
    });
}

async function seedPreserved(page, base) {
    await page.evaluate(async base => {
        const other = await caches.open('teacher-offline-v5');
        await other.put(base + 'index.html', new Response('unrelated cached index'));
        await other.put(base + 'network-only.txt', new Response('unrelated cached network response'));
        await (await caches.open('nexus-launcher-videos')).put(base + 'video', new Response('keep video'));
        const scoped = `nexus-launcher:${encodeURIComponent(new URL(base).pathname)}:v`;
        for (const version of [1, 2, 3, 4]) await (await caches.open(scoped + version)).put(base + 'obsolete-scoped-' + version, new Response('obsolete scoped cache'));
        await (await caches.open('nexus-launcher:%2Fforeign%2F:v4')).put(base + 'foreign-scope', new Response('keep foreign scope'));
        for (const version of [1, 2, 3]) await (await caches.open('nexus-launcher-v' + version)).put(base + 'legacy-global-' + version, new Response('keep legacy global'));
        localStorage.setItem('nexus-sw-preservation', 'saved preference sentinel');
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('nexus-sw-world-sentinel', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('worlds');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction('worlds', 'readwrite');
                transaction.objectStore('worlds').put('saved world sentinel', 'world');
                transaction.oncomplete = () => { db.close(); resolve(); };
                transaction.onerror = () => { db.close(); reject(transaction.error); };
            };
        });
    }, base);
}

async function preserved(page, base) {
    const actual = await page.evaluate(async base => {
        const preference = localStorage.getItem('nexus-sw-preservation');
        const other = await (await caches.open('teacher-offline-v5')).match(base + 'index.html');
        const video = await (await caches.open('nexus-launcher-videos')).match(base + 'video');
        const scopedPrefix = `nexus-launcher:${encodeURIComponent(new URL(base).pathname)}:v`;
        const obsoleteScoped = {};
        const scopedCachePresent = {};
        for (const version of [1, 2, 3, 4]) {
            const name = scopedPrefix + version;
            scopedCachePresent[version] = await caches.has(name);
            obsoleteScoped[version] = scopedCachePresent[version] ? await (await caches.open(name)).match(base + 'obsolete-scoped-' + version) : null;
        }
        const foreign = await (await caches.open('nexus-launcher:%2Fforeign%2F:v4')).match(base + 'foreign-scope');
        const legacyGlobal = {};
        for (const version of [1, 2, 3]) legacyGlobal[version] = await (await caches.open('nexus-launcher-v' + version)).match(base + 'legacy-global-' + version);
        const world = await new Promise((resolve, reject) => {
            const request = indexedDB.open('nexus-sw-world-sentinel', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const read = db.transaction('worlds').objectStore('worlds').get('world');
                read.onsuccess = () => { db.close(); resolve(read.result); };
                read.onerror = () => { db.close(); reject(read.error); };
            };
        });
        return {
            preference, world, other: other && await other.text(), video: video && await video.text(),
            scopedCachePresent,
            obsoleteScoped: Object.fromEntries(await Promise.all(Object.entries(obsoleteScoped).map(async ([version, response]) => [version, response && await response.text()]))),
            foreign: foreign && await foreign.text(),
            legacyGlobal: Object.fromEntries(await Promise.all(Object.entries(legacyGlobal).map(async ([version, response]) => [version, response && await response.text()])))
        };
    }, base);
    assert.deepEqual(actual, {
        preference: 'saved preference sentinel', world: 'saved world sentinel', other: 'unrelated cached index', video: 'keep video',
        scopedCachePresent: { 1: false, 2: false, 3: false, 4: false },
        obsoleteScoped: { 1: null, 2: null, 3: null, 4: null }, foreign: 'keep foreign scope',
        legacyGlobal: { 1: 'keep legacy global', 2: 'keep legacy global', 3: 'keep legacy global' }
    });
}

async function candidateCache(page, base) {
    const actual = await page.evaluate(async ({ base, cacheName }) => {
        const cache = await caches.open(cacheName);
        const entries = {};
        const contentTypes = {};
        for (const request of await cache.keys()) {
            const response = await cache.match(request);
            const bytes = await response.arrayBuffer();
            const file = new URL(request.url).pathname.slice(new URL(base).pathname.length);
            entries[file] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
            contentTypes[file] = response.headers.get('content-type');
        }
        return { entries, contentTypes };
    }, { base, cacheName: scopedCacheName(base) });
    assert.deepEqual(actual.entries, expected);
    for (const [file, contentType] of Object.entries({
        'assets/tailwind.css': 'text/css', 'assets/fonts.css': 'text/css',
        'assets/world-backups.css': 'text/css',
        'assets/epk-import-guard.js': 'application/javascript',
        'assets/world-backups-ui.js': 'application/javascript',
        'assets/world-backups.js': 'application/javascript',
        'gamerz.png': 'image/png', 'eagle192.png': 'image/png', 'eagle512.png': 'image/png',
        'apple-touch-icon.png': 'image/png',
        'assets/fonts/inter-latin.woff2': 'font/woff2', 'assets/fonts/orbitron-latin.woff2': 'font/woff2'
    })) assert.match(actual.contentTypes[file], new RegExp('^' + contentType.replace('/', '\\/')));
}

async function offlineCore(context, page, base) {
    await context.setOffline(true);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#btn-js').count(), 1);
    await page.goto(base + 'index.html?launch', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#btn-wasm').count(), 1);
    await page.goto(base + 'index.html', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#btn-js').count(), 1);
    assert.equal(await page.locator('#btn-wasm').count(), 1);
    assert.ok(await page.evaluate(() => navigator.serviceWorker.controller));
    const actual = await page.evaluate(async ({ base, assets }) => {
        const entries = {};
        for (const file of assets) {
            const response = await fetch(base + file);
            if (!response.ok) throw new Error(file + ': ' + response.status);
            const bytes = await response.arrayBuffer();
            entries[file] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
        }
        return entries;
    }, { base, assets });
    assert.deepEqual(actual, expected);
    const misses = await page.evaluate(async base => {
        const result = {};
        for (const path of ['gamefile.html?offline-miss=1', 'not-cached.html']) {
            try { await fetch(base + path); result[path] = 'unexpected response'; }
            catch { result[path] = 'network failure'; }
        }
        return result;
    }, base);
    assert.deepEqual(misses, { 'gamefile.html?offline-miss=1': 'network failure', 'not-cached.html': 'network failure' });
    await context.setOffline(false);
}

async function fresh(browser, prefix) {
    phase = 'fresh' + prefix;
    distribution = 'candidate'; failAsset = false;
    const base = origin + prefix;
    const context = await contextFor(browser);
    try {
        const page = await context.newPage();
        await page.goto(base + 'probe.html');
        await seedPreserved(page, base);
        await page.goto(base + 'index.html', { waitUntil: 'domcontentloaded' });
        await activated(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        assert.equal(await page.evaluate(() => navigator.serviceWorker.controller !== null), true);
        assert.equal(results.requests.filter(item => item.phase === phase && item.path.endsWith('/launcher.html')).length, 0);
        check(phase + ': precache installs and controls the launcher without requesting launcher.html');
        await candidateCache(page, base);
        assert.equal(await page.evaluate(name => caches.has(name), scopedCacheName(base)), true);
        check(phase + ': all 16 source-listed cached responses equal candidate bytes; only obsolete same-scope caches removed');
        await preserved(page, base);
        assert.equal(await page.evaluate(async url => (await fetch(url)).text(), base + 'network-only.txt'), 'network fallback');
        check(phase + ': unrelated caches and saved-data sentinels survive; cache miss uses network');
        await offlineCore(context, page, base);
        check(phase + ': root, query, and index navigations plus 16 cached responses work offline; exact misses fail');
    } finally { await context.close(); }
}

async function coexist(browser) {
    phase = 'scope-coexistence'; distribution = 'candidate'; failAsset = false;
    const rootBase = origin + '/';
    const childBase = origin + '/classroom/';
    const context = await contextFor(browser);
    try {
        const rootPage = await context.newPage();
        await rootPage.goto(rootBase + 'probe.html');
        await seedPreserved(rootPage, rootBase);
        await rootPage.goto(rootBase + 'index.html', { waitUntil: 'domcontentloaded' });
        await activated(rootPage);
        await rootPage.reload({ waitUntil: 'domcontentloaded' });
        await rootPage.evaluate(async () => {
            await navigator.serviceWorker.register('/classroom/sw.js', { scope: '/classroom/' });
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                const registrations = await navigator.serviceWorker.getRegistrations();
                if (registrations.some(registration => registration.scope.endsWith('/classroom/') && registration.active?.state === 'activated')) return;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Subdirectory service worker did not activate');
        });
        const childPage = await context.newPage();
        await childPage.goto(childBase + 'index.html', { waitUntil: 'domcontentloaded' });
        await activated(childPage);
        await childPage.reload({ waitUntil: 'domcontentloaded' });
        assert.equal(new URL(await childPage.evaluate(() => navigator.serviceWorker.controller.scriptURL)).pathname, '/classroom/sw.js');
        await candidateCache(rootPage, rootBase);
        await candidateCache(childPage, childBase);
        assert.equal(await rootPage.evaluate(name => caches.has(name), scopedCacheName(rootBase)), true);
        assert.equal(await childPage.evaluate(name => caches.has(name), scopedCacheName(childBase)), true);
        await context.setOffline(true);
        await rootPage.goto(rootBase, { waitUntil: 'domcontentloaded' });
        await childPage.goto(childBase, { waitUntil: 'domcontentloaded' });
        assert.equal(await rootPage.locator('#btn-js').count(), 1);
        assert.equal(await childPage.locator('#btn-js').count(), 1);
        await context.setOffline(false);
        check('root and /classroom/ registrations keep distinct scoped caches and both navigate offline');
    } finally { await context.close(); }
}

async function update(page) {
    return page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Worker update did not settle')), 60000);
            registration.addEventListener('updatefound', () => {
                const installing = registration.installing;
                const settled = () => {
                    if (['installed', 'redundant'].includes(installing.state)) {
                        clearTimeout(timeout); resolve(installing.state);
                    }
                };
                installing.addEventListener('statechange', settled);
                settled();
            }, { once: true });
            registration.update().catch(error => { clearTimeout(timeout); reject(error); });
        });
    });
}

async function upgrade(browser, version, scoped = false) {
    phase = 'upgrade-' + (scoped ? 'scoped-v' : 'v') + version;
    distribution = scoped ? 'scoped-v4' : 'legacy'; failAsset = false; legacyVersion = version;
    const base = origin + '/classroom/';
    const oldCache = scoped ? scopedCacheName(base, version) : 'nexus-launcher-v' + version;
    const context = await contextFor(browser);
    try {
        const page = await context.newPage();
        await page.goto(base + (!scoped && version === 1 ? 'launcher.html' : 'index.html'), { waitUntil: 'domcontentloaded' });
        await activated(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.evaluate(() => { window.oldController = navigator.serviceWorker.controller; });
        assert.ok(await page.evaluate(() => window.oldController));
        await seedPreserved(page, base);
        await page.evaluate(base => new Promise(resolve => {
            const frame = document.createElement('iframe'); frame.onload = resolve;
            frame.id = 'sw-preservation-frame';
            frame.src = base + 'probe.html'; document.body.append(frame);
        }), base);
        const iframe = await (await page.locator('#sw-preservation-frame').elementHandle()).contentFrame();
        await iframe.evaluate(() => { window.oldController = navigator.serviceWorker.controller; });
        assert.ok(await iframe.evaluate(() => window.oldController));
        const runtimePrefix = () => page.evaluate(async ({ url, length }) => (await fetch(url)).text().then(text => text.slice(0, length)), { url: base + 'gamefile.html', length: legacyMarker.length });
        const legacyRuntime = await runtimePrefix();
        assert.equal(legacyRuntime, legacyMarker.toString());
        distribution = 'candidate'; failAsset = true;
        assert.equal(await update(page), 'redundant');
        assert.ok(await page.evaluate(async oldCache => (await navigator.serviceWorker.getRegistration()).active && await caches.has(oldCache), oldCache));
        assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting), null);
        assert.deepEqual(await page.evaluate(async name => ({
            exists: await caches.has(name),
            keys: await (await caches.open(name)).keys().then(requests => requests.map(request => request.url))
        }), scopedCacheName(base)), { exists: true, keys: [] });
        assert.equal(await page.evaluate(async ({ base, name }) => {
            if (!await caches.has(name)) return 'cache missing';
            const response = await (await caches.open(name)).match(base + 'obsolete-scoped-4');
            return response && await response.text();
        }, { base, name: scopedCacheName(base, 4) }), 'obsolete scoped cache');
        assert.equal(await runtimePrefix(), legacyRuntime);
        check(phase + ': failed precache rejects update and leaves active runtime usable');
        failAsset = false;
        assert.equal(await update(page), 'installed');
        assert.ok(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting?.state === 'installed' && navigator.serviceWorker.controller === window.oldController));
        assert.ok(await iframe.evaluate(() => navigator.serviceWorker.controller === window.oldController));
        await candidateCache(page, base);
        assert.equal(await page.evaluate(async ({ base, name }) => {
            if (!await caches.has(name)) return 'cache missing';
            const response = await (await caches.open(name)).match(base + 'obsolete-scoped-4');
            return response && await response.text();
        }, { base, name: scopedCacheName(base, 4) }), 'obsolete scoped cache');
        assert.equal(await runtimePrefix(), legacyRuntime);
        check(phase + ': candidate waits, retains scoped v4 while existing page and iframe retain the old controller and runtime');
        const holder = await context.newPage();
        await holder.goto(base + 'probe.html');
        await page.close();
        assert.ok(await holder.evaluate(async oldCache => (await navigator.serviceWorker.getRegistration()).waiting?.state === 'installed' && await caches.has(oldCache), oldCache));
        check(phase + ': another controlled tab continues to defer activation');
        await holder.close();
        await new Promise(resolve => setTimeout(resolve, 250));
        const reopened = await context.newPage();
        await reopened.goto(base + 'index.html', { waitUntil: 'domcontentloaded' });
        await activated(reopened);
        assert.equal(await reopened.evaluate(oldCache => caches.has(oldCache), oldCache), !scoped);
        await reopened.reload({ waitUntil: 'domcontentloaded' });
        assert.ok(await reopened.evaluate(() => navigator.serviceWorker.controller));
        await preserved(reopened, base);
        check(phase + ': activation preserves legacy globals and foreign scopes, removes only same-scope numeric caches, and preserves saved data');
        await offlineCore(context, reopened, base);
        check(phase + ': reopened offline launcher and runtimes use candidate bytes');
    } finally { await context.close(); }
}

(async () => {
    const server = http.createServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const relative = pathname.replace(/^\/classroom\//, '/').slice(1) || 'index.html';
        let bytes, status = 200;
        if (relative === 'sw.js') bytes = distribution === 'scoped-v4' ? Buffer.from(scopedV4()) : distribution === 'legacy' ? Buffer.from(legacy(legacyVersion)) : candidate;
        else if (relative === 'probe.html') bytes = Buffer.from('<!doctype html><title>Service worker probe</title>');
        else if (relative === 'network-only.txt') bytes = Buffer.from('network fallback');
        else if (relative === 'launcher.html' && distribution === 'legacy') bytes = Buffer.concat([legacyMarker, fs.readFileSync(path.join(root, 'index.html'))]);
        else if (failAsset && relative === 'gamefilebetter.html') { status = 503; bytes = Buffer.from('Deliberate update-precache failure'); }
        else {
            const filename = path.resolve(root, relative);
            if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { status = 404; bytes = Buffer.from('Not found'); }
            else {
                bytes = fs.readFileSync(filename);
                if (distribution !== 'candidate' && relative.endsWith('.html')) bytes = Buffer.concat([legacyMarker, bytes]);
            }
        }
        results.requests.push({ phase, path: pathname, status });
        response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': ({
            '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css',
            '.png': 'image/png', '.woff2': 'font/woff2'
        })[path.extname(relative)] || 'text/plain' });
        response.end(bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
    let browser;
    try {
        browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.NEXUS_BROWSER_EXECUTABLE ? { executablePath: process.env.NEXUS_BROWSER_EXECUTABLE } : {}) });
        results.browserVersion = browser.version(); results.expectedAssetHashes = expected;
        await fresh(browser, '/');
        await fresh(browser, '/classroom/');
        await coexist(browser);
        await upgrade(browser, 1);
        await upgrade(browser, 2);
        await upgrade(browser, 3);
        await upgrade(browser, 4, true);
    } catch (error) { results.checks.push({ name: phase, status: 'fail', error: error.stack }); console.error(error); process.exitCode = 1; }
    finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
        fs.writeFileSync(path.join(output, 'service-worker-results.json'), JSON.stringify(results, null, 2));
        console.log('Evidence: ' + output);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
