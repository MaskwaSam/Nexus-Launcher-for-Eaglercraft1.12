const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(process.env.NEXUS_SW_FILE || path.join(root, 'sw.js'), 'utf8');
const scope = 'https://example.test/classroom/';
const cacheName = 'nexus-launcher:%2Fclassroom%2F:v4';

function worker(caches, fetch = () => { throw new Error('Unexpected network request'); }, registrationScope = scope) {
    const listeners = new Map();
    const context = vm.createContext({
        self: { registration: { scope: registrationScope }, addEventListener: (type, listener) => listeners.set(type, listener) },
        caches, fetch, URL, console: { log() {} }
    });
    vm.runInContext(source, context, { filename: 'sw.js' });
    return (type, request) => {
        let operation;
        listeners.get(type)({ request, waitUntil: value => { operation = value; }, respondWith: value => { operation = value; } });
        assert.ok(operation instanceof Promise || typeof operation?.then === 'function');
        return operation;
    };
}

async function installed(registrationScope = scope) {
    let assets, name;
    const dispatch = worker({ open: async key => {
        name = key;
        return { addAll: async entries => { assets = Array.from(entries); } };
    } }, undefined, registrationScope);
    await dispatch('install');
    return { name, assets };
}

test('precache uses real distribution files and the unchanged manifest start URL', async () => {
    const { name, assets } = await installed();
    assert.equal(name, cacheName);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    assert.ok(assets.some(asset => new URL(asset, scope).href === new URL(manifest.start_url, scope).href));
    for (const asset of assets) {
        const url = new URL(asset, scope);
        assert.equal(url.origin, new URL(scope).origin);
        assert.ok(url.pathname.startsWith(new URL(scope).pathname));
        assert.ok(fs.statSync(path.join(root, url.pathname.slice(new URL(scope).pathname.length))).isFile(), asset);
    }
    for (const runtime of ['./gamefile.html', './gamefilebetter.html']) assert.ok(assets.includes(runtime));
});

test('all launcher styles, fonts, images and manifest icons are local and precached', async () => {
    const { assets } = await installed();
    const cached = new Set(assets.map(asset => new URL(asset, scope).href));
    const document = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const dependencies = [];
    for (const tag of document.matchAll(/<(?:link|script|img)\b[^>]*>/gi)) {
        const attribute = tag[0].match(/\b(?:src|href)=["']([^"']+)["']/i);
        if (attribute) dependencies.push(new URL(attribute[1], scope));
    }
    for (const css of document.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        assert.doesNotMatch(css[1], /@import\b/);
    }
    const styles = dependencies.filter(url => url.pathname.endsWith('.css'));
    assert.ok(styles.length >= 2, 'utility and font stylesheets must be present');
    for (const stylesheet of styles) {
        const css = fs.readFileSync(path.join(root, stylesheet.pathname.slice(new URL(scope).pathname.length)), 'utf8');
        assert.doesNotMatch(css, /@import\b/);
        for (const match of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) dependencies.push(new URL(match[1], stylesheet));
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    for (const icon of manifest.icons) dependencies.push(new URL(icon.src, scope));
    for (const url of dependencies) {
        assert.equal(url.origin, new URL(scope).origin, 'runtime dependency must be local: ' + url.href);
        assert.ok(cached.has(url.href), 'dependency must be precached: ' + url.href);
    }
});

test('cache identity separates installations at different paths and avoids legacy cleanup prefixes', async () => {
    const rootCache = await installed('https://example.test/');
    const classroomCache = await installed();
    const nestedCache = await installed('https://example.test/classroom/nexus/');
    assert.equal(rootCache.name, 'nexus-launcher:%2F:v4');
    assert.equal(classroomCache.name, cacheName);
    assert.equal(new Set([rootCache.name, classroomCache.name, nestedCache.name]).size, 3);
    for (const { name } of [rootCache, classroomCache, nestedCache]) assert.equal(name.startsWith('nexus-launcher-'), false);
});

test('activation removes only obsolete numeric versions owned by this scope', async () => {
    const deleted = [];
    const dispatch = worker({
        keys: async () => ['teacher-offline-v5', 'nexus-launcher-v1', 'nexus-launcher-v2', 'nexus-launcher-v3',
            'nexus-launcher:%2F:v3', 'nexus-launcher:%2F:v4', 'nexus-launcher:%2Fclassroom%2F:v3',
            cacheName, 'nexus-launcher:%2Fclassroom%2F:v5-preview', 'nexus-launcher-videos'],
        delete: async name => { deleted.push(name); return true; }
    });
    await dispatch('activate');
    assert.deepEqual(deleted, ['nexus-launcher:%2Fclassroom%2F:v3']);
});

test('fetch uses only the current scope cache and preserves exact network fallback', async () => {
    const cached = {}, networkResponse = {}, unrelated = {};
    const hits = [], network = [];
    const dispatch = worker({
        match: async () => unrelated,
        open: async name => {
            assert.equal(name, cacheName);
            return { match: async request => { hits.push(request); return request.cached ? cached : undefined; } };
        }
    }, async request => { network.push(request); return networkResponse; });
    const hit = { url: scope + 'gamefile.html', method: 'GET', mode: 'cors', cached: true };
    const miss = { url: scope + 'custom?variant=1', method: 'GET', mode: 'cors' };
    assert.equal(await dispatch('fetch', hit), cached);
    assert.equal(await dispatch('fetch', miss), networkResponse);
    assert.deepEqual(hits, [hit, miss]);
    assert.deepEqual(network, [miss]);
});

test('only same-origin GET launcher navigations use the canonical cached shell', async () => {
    const hit = {}, lookups = [], network = [];
    const dispatch = worker({ open: async () => ({ match: async lookup => {
        lookups.push(lookup); return typeof lookup === 'string' ? hit : undefined;
    } }) }, async request => { network.push(request); return request; });
    for (const url of [scope, scope + '?launch=1', scope + 'index.html', scope + 'index.html?launch=installed']) {
        assert.equal(await dispatch('fetch', { url, method: 'GET', mode: 'navigate' }), hit);
    }
    assert.deepEqual(lookups, Array(4).fill(scope + 'index.html'));
    const exact = [
        { url: scope + 'gamefile.html?variant=1', method: 'GET', mode: 'navigate' },
        { url: scope + 'unknown', method: 'GET', mode: 'navigate' },
        { url: 'https://example.test/index.html', method: 'GET', mode: 'navigate' },
        { url: 'https://other.test/classroom/index.html', method: 'GET', mode: 'navigate' },
        { url: scope + 'index.html', method: 'POST', mode: 'navigate' },
        { url: scope + 'index.html?api=1', method: 'GET', mode: 'cors' }
    ];
    for (const request of exact) assert.equal(await dispatch('fetch', request), request);
    assert.deepEqual(lookups.slice(4), exact);
    assert.deepEqual(network, exact);
});

test('a failed precache rejects installation instead of pretending to succeed', async () => {
    const failure = new Error('Missing required asset');
    const dispatch = worker({ open: async () => ({ addAll: async () => { throw failure; } }) });
    await assert.rejects(dispatch('install'), error => error === failure);
});
