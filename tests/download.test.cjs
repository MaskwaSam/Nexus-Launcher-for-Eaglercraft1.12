const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).find(script => script.includes('async function downloadGame('));
assert.ok(source, 'exercise the actual launcher download handler');
const base = 'https://example.test/classroom/';
function launcher(fetch, controlled = true) {
    const saves = [], blobs = [], timers = [], revoked = [];
    const context = vm.createContext({
        navigator: controlled ? { serviceWorker: { controller: {} } } : {},
        fetch,
        URL: {
            createObjectURL(blob) { blobs.push(blob); return 'blob:isolated-test-' + blobs.length; },
            revokeObjectURL(url) { revoked.push(url); }
        },
        setTimeout(callback, delay) { timers.push({ callback, delay }); },
        console: { warn() {} },
        window: { addEventListener() {} },
        document: {
            body: { appendChild(anchor) { anchor.attached = true; } },
            getElementById() { return { addEventListener() {} }; },
            addEventListener() {},
            createElement(tag) {
                assert.equal(tag, 'a');
                return {
                    click() { assert.equal(this.attached, true); saves.push({ href: this.href, filename: this.download }); },
                    remove() { this.attached = false; }
                };
            }
        }
    });
    vm.runInContext(source, context);
    return { download: context.downloadGame, saves, blobs, timers, revoked };
}
function event(overrides = {}) {
    return { button: 0, preventDefault() { this.defaultPrevented = true; }, ...overrides };
}
const link = (file = 'gamefile.html', download = 'Nexus_JS_Edition.html') => ({ href: base + file, download, dataset: {} });

test('controlled downloads use the exact fetched blob, original filenames and delayed URL cleanup', async () => {
    for (const [file, filename] of [['gamefile.html', 'Nexus_JS_Edition.html'], ['gamefilebetter.html', 'Nexus_WASM_GC.html']]) {
        const blob = new Blob(['unchanged bundle bytes']);
        const requested = [];
        const app = launcher(async url => { requested.push(url); return { ok: true, blob: async () => blob }; });
        const click = event(), anchor = link(file, filename);
        await app.download(click, anchor);
        assert.equal(click.defaultPrevented, true);
        assert.deepEqual(requested, [base + file]);
        assert.equal(app.blobs[0], blob);
        assert.deepEqual(app.saves, [{ href: 'blob:isolated-test-1', filename }]);
        assert.equal(anchor.dataset.downloading, undefined);
        assert.equal(app.timers.length, 1);
        assert.equal(app.timers[0].delay, 60000);
        assert.deepEqual(app.revoked, []);
        app.timers[0].callback();
        assert.deepEqual(app.revoked, ['blob:isolated-test-1']);
    }
});

test('uncontrolled and modified clicks retain the native link behavior', async () => {
    const unexpected = () => { throw new Error('Native link must not fetch'); };
    const uncontrolled = launcher(unexpected, false), click = event();
    await uncontrolled.download(click, link());
    assert.equal(click.defaultPrevented, undefined);
    assert.deepEqual(uncontrolled.saves, []);
    const app = launcher(unexpected);
    for (const override of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }]) {
        const click = event(override);
        await app.download(click, link());
        assert.equal(click.defaultPrevented, override.defaultPrevented);
    }
    assert.deepEqual(app.saves, []);
});

test('network and HTTP failures release pending state and fall back to the original native link', async () => {
    for (const fetch of [async () => { throw new Error('Network unavailable'); }, async () => ({ ok: false, status: 503, blob() { throw new Error('Error body must not download'); } })]) {
        const app = launcher(fetch), anchor = link();
        await app.download(event(), anchor);
        assert.deepEqual(app.saves, [{ href: anchor.href, filename: anchor.download }]);
        assert.equal(anchor.dataset.downloading, undefined);
        assert.deepEqual(app.blobs, []);
        assert.deepEqual(app.timers, []);
    }
});

test('repeated clicks during a pending fetch produce one download and permit a later retry', async () => {
    let resolve, requests = 0;
    const pending = new Promise(done => { resolve = done; });
    const app = launcher(async () => { requests++; return pending; }), anchor = link();
    const first = app.download(event(), anchor);
    const secondClick = event();
    await app.download(secondClick, anchor);
    assert.equal(secondClick.defaultPrevented, true);
    assert.equal(requests, 1);
    assert.equal(anchor.dataset.downloading, 'true');
    resolve({ ok: true, blob: async () => new Blob(['bundle']) });
    await first;
    assert.equal(app.saves.length, 1);
    await app.download(event(), anchor);
    assert.equal(requests, 2);
    assert.equal(app.saves.length, 2);
});
