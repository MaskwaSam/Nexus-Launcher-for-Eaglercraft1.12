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
const assets = ['index.html', 'manifest.json', 'gamefile.html', 'gamefilebetter.html'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expected = Object.fromEntries(assets.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const results = { checks: [], requests: [], limitations: [
    'Local Chromium automation, not an installed-PWA or physical-device acceptance test.',
    'Only the manifest start URL index.html and the existing core precache are covered offline; directory navigation, external styles/fonts and other uncached assets still need network.'
] };
const check = name => { results.checks.push({ name, status: 'pass' }); console.log('PASS ' + name); };
// Model v1's older layout and main's v2 cache, including their global lookup.
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
        return { preference, world, other: other && await other.text(), video: video && await video.text() };
    }, base);
    assert.deepEqual(actual, { preference: 'saved preference sentinel', world: 'saved world sentinel', other: 'unrelated cached index', video: 'keep video' });
}

async function candidateCache(page, base) {
    const actual = await page.evaluate(async base => {
        const cache = await caches.open('nexus-launcher-v3');
        const entries = {};
        for (const request of await cache.keys()) {
            const response = await cache.match(request);
            const bytes = await response.arrayBuffer();
            entries[new URL(request.url).pathname.slice(new URL(base).pathname.length)] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
        }
        return entries;
    }, base);
    assert.deepEqual(actual, expected);
}

async function offlineCore(context, page, base) {
    await context.setOffline(true);
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
        await page.evaluate(async base => {
            for (const version of [1, 2]) await (await caches.open('nexus-launcher-v' + version)).put(base + 'index.html', new Response('obsolete index'));
        }, base);
        await page.goto(base + 'index.html', { waitUntil: 'domcontentloaded' });
        await activated(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        assert.equal(await page.evaluate(() => navigator.serviceWorker.controller !== null), true);
        assert.equal(results.requests.filter(item => item.phase === phase && item.path.endsWith('/launcher.html')).length, 0);
        check(phase + ': precache installs and controls the launcher without requesting launcher.html');
        await candidateCache(page, base);
        assert.equal(await page.evaluate(() => caches.has('nexus-launcher-v1')), false);
        assert.equal(await page.evaluate(() => caches.has('nexus-launcher-v2')), false);
        check(phase + ': all four cached responses equal candidate bytes; obsolete cache removed');
        await preserved(page, base);
        assert.equal(await page.evaluate(async url => (await fetch(url)).text(), base + 'network-only.txt'), 'network fallback');
        check(phase + ': unrelated caches and saved-data sentinels survive; cache miss uses network');
        await offlineCore(context, page, base);
        check(phase + ': offline manifest-start navigation and both runtime responses equal candidate bytes');
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

async function upgrade(browser, version) {
    phase = 'upgrade-v' + version; distribution = 'legacy'; failAsset = false; legacyVersion = version;
    const oldCache = 'nexus-launcher-v' + version;
    const base = origin + '/classroom/';
    const context = await contextFor(browser);
    try {
        const page = await context.newPage();
        await page.goto(base + (version === 1 ? 'launcher.html' : 'index.html'), { waitUntil: 'domcontentloaded' });
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
        assert.deepEqual(await page.evaluate(async () => (await (await caches.open('nexus-launcher-v3')).keys()).map(request => request.url)), []);
        assert.equal(await runtimePrefix(), legacyRuntime);
        check(phase + ': failed precache rejects update and leaves active runtime usable');
        failAsset = false;
        assert.equal(await update(page), 'installed');
        assert.ok(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting?.state === 'installed' && navigator.serviceWorker.controller === window.oldController));
        assert.ok(await iframe.evaluate(() => navigator.serviceWorker.controller === window.oldController));
        await candidateCache(page, base);
        assert.equal(await runtimePrefix(), legacyRuntime);
        check(phase + ': candidate waits while existing page and iframe retain the old controller and runtime');
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
        assert.equal(await reopened.evaluate(oldCache => caches.has(oldCache), oldCache), false);
        await reopened.reload({ waitUntil: 'domcontentloaded' });
        assert.ok(await reopened.evaluate(() => navigator.serviceWorker.controller));
        await preserved(reopened, base);
        check(phase + ': normal activation removes only obsolete launcher cache and preserves saved-data sentinels');
        await offlineCore(context, reopened, base);
        check(phase + ': reopened offline launcher and runtimes use candidate bytes');
    } finally { await context.close(); }
}

(async () => {
    const server = http.createServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const relative = pathname.replace(/^\/classroom\//, '/').slice(1) || 'index.html';
        let bytes, status = 200;
        if (relative === 'sw.js') bytes = distribution === 'legacy' ? Buffer.from(legacy(legacyVersion)) : candidate;
        else if (relative === 'probe.html') bytes = Buffer.from('<!doctype html><title>Service worker probe</title>');
        else if (relative === 'network-only.txt') bytes = Buffer.from('network fallback');
        else if (relative === 'launcher.html' && distribution === 'legacy') bytes = Buffer.concat([legacyMarker, fs.readFileSync(path.join(root, 'index.html'))]);
        else if (failAsset && relative === 'gamefilebetter.html') { status = 503; bytes = Buffer.from('Deliberate update-precache failure'); }
        else {
            const filename = path.resolve(root, relative);
            if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { status = 404; bytes = Buffer.from('Not found'); }
            else {
                bytes = fs.readFileSync(filename);
                if (distribution === 'legacy' && relative.endsWith('.html')) bytes = Buffer.concat([legacyMarker, bytes]);
            }
        }
        results.requests.push({ phase, path: pathname, status });
        response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' })[path.extname(relative)] || 'text/plain' });
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
        await upgrade(browser, 1);
        await upgrade(browser, 2);
    } catch (error) { results.checks.push({ name: phase, status: 'fail', error: error.stack }); console.error(error); process.exitCode = 1; }
    finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
        fs.writeFileSync(path.join(output, 'service-worker-results.json'), JSON.stringify(results, null, 2));
        console.log('Evidence: ' + output);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
