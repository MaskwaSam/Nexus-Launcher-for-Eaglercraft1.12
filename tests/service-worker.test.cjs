const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(process.env.NEXUS_SW_FILE || path.join(root, 'sw.js'), 'utf8');

function worker(caches, fetch = () => { throw new Error('Unexpected network request'); }) {
    const listeners = new Map();
    const context = vm.createContext({
        self: { addEventListener: (type, listener) => listeners.set(type, listener) },
        caches, fetch, console: { log() {} }
    });
    vm.runInContext(source, context, { filename: 'sw.js' });
    return (type, request) => {
        let operation;
        listeners.get(type)({ request, waitUntil: value => { operation = value; }, respondWith: value => { operation = value; } });
        assert.ok(operation instanceof Promise || typeof operation?.then === 'function');
        return operation;
    };
}

test('precache uses real distribution files and the manifest start URL in a new cache', async () => {
    let assets, name;
    const dispatch = worker({ open: async key => {
        name = key;
        return { addAll: async entries => { assets = Array.from(entries); } };
    } });
    await dispatch('install');
    assert.match(name, /^nexus-launcher-v[0-9]+$/);
    const scope = new URL('https://example.test/classroom/');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    assert.ok(assets.some(asset => new URL(asset, scope).href === new URL(manifest.start_url, scope).href));
    for (const asset of assets) {
        const url = new URL(asset, scope);
        assert.equal(url.origin, scope.origin);
        assert.ok(url.pathname.startsWith(scope.pathname));
        assert.ok(fs.statSync(path.join(root, url.pathname.slice(scope.pathname.length))).isFile(), asset);
    }
    assert.notEqual(name, 'nexus-launcher-v1', 'do not reuse potentially stale v1 responses');
    assert.notEqual(name, 'nexus-launcher-v2', 'main already uses v2 for a different distribution');
});

test('activation removes obsolete launcher versions while preserving unrelated caches', async () => {
    const deleted = [];
    const dispatch = worker({
        keys: async () => ['teacher-offline-v5', 'nexus-launcher-v0', 'nexus-launcher-v1', 'nexus-launcher-v2', 'nexus-launcher-v3', 'nexus-launcher-videos'],
        delete: async name => { deleted.push(name); return true; }
    });
    await dispatch('activate');
    assert.deepEqual(deleted, ['nexus-launcher-v0', 'nexus-launcher-v1', 'nexus-launcher-v2']);
});

test('fetch uses only the current launcher cache and preserves network fallback', async () => {
    const cached = {}, networkResponse = {}, unrelated = {};
    const hits = [], network = [];
    const dispatch = worker({
        match: async () => unrelated,
        open: async name => {
            assert.equal(name, 'nexus-launcher-v3');
            return { match: async request => { hits.push(request); return request.cached ? cached : undefined; } };
        }
    }, async request => { network.push(request); return networkResponse; });
    const hit = { url: 'https://example.test/classroom/index.html', cached: true };
    const miss = { url: 'https://example.test/classroom/custom?variant=1', cached: false };
    assert.equal(await dispatch('fetch', hit), cached);
    assert.equal(await dispatch('fetch', miss), networkResponse);
    assert.deepEqual(hits, [hit, miss]);
    assert.deepEqual(network, [miss]);
});

test('a failed precache rejects installation instead of pretending to succeed', async () => {
    const failure = new Error('Missing required asset');
    const dispatch = worker({ open: async () => ({ addAll: async () => { throw failure; } }) });
    await assert.rejects(dispatch('install'), error => error === failure);
});
