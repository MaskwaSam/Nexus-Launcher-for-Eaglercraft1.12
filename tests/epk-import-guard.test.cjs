const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { gzipSync, deflateSync } = require('node:zlib');
const guard = require('../assets/epk-import-guard.js');
const backups = require('../assets/world-backups.js');
const { crc32 } = backups;
function archive({ paths = ['options.txt'], compression = '0', type = 'epk/profile188', corruptCRC = false, count, tail = '', tag = 'FILE' } = {}) {
    const b = value => Buffer.from(value, 'latin1');
    const number = n => { const out = Buffer.alloc(4); out.writeUInt32BE(n); return out; };
    const str = s => Buffer.concat([Buffer.from([s.length]), b(s)]);
    const records = [Buffer.concat([b('HEAD'), str('file-type'), number(type.length), b(type), b('>')])];
    paths.forEach((path, i) => { const data = b('native file ' + i); records.push(Buffer.concat([b(tag), str(path), number(data.length + 5), number((crc32(data) ^ (corruptCRC && i === paths.length - 1 ? 1 : 0)) >>> 0), data, b(':>')])); });
    let payload = Buffer.concat([...records, b('END$' + tail)]);
    if (compression === 'G') payload = gzipSync(payload);
    if (compression === 'Z') payload = deflateSync(payload);
    return Buffer.concat([b('EAGPKG$$'), str('ver2.0'), str('profile.epk'), Buffer.alloc(10), number(count ?? records.length), b(compression), payload, b(':::YEE:>')]);
}
for (const compression of ['0', 'G', 'Z']) test('fully validates native ' + compression + ' framing and non-world EPK', async () => {
    assert.deepEqual(await guard.validate(archive({ compression })), { version: 'ver2.0', compression, records: 2, files: 1 });
});
test('accepts launcher native world export with room for maximum snapshot framing', async () => {
    const exported = backups.encodeEpk({ id: 'guard-roundtrip', files: [{ path: 'level.dat', data: new Uint8Array([1, 2]) }, { path: 'DIM-1/region/r.0.0.mca', data: new Uint8Array([3]) }] });
    assert.equal((await guard.validate(exported.bytes)).files, 2);
    // Each Latin-1 name is at most 255 bytes, plus tag, name length,
    // length, CRC, two sentinels; outer framing/HEAD fits in 1 KiB.
    const maximumRaw = backups.LIMITS.totalBytes + backups.LIMITS.files * (4 + 1 + 255 + 4 + 4 + 2) + 1024;
    assert.ok(guard.LIMITS.inputBytes > maximumRaw + maximumRaw / 100);
    assert.ok(guard.LIMITS.payloadBytes >= maximumRaw);
});
test('File default names follow native extension stripping and UTF-16 truncation before reads', async () => {
    for (const name of ['   .epk', ' '.repeat(32) + 'Safe.epk', '\\\\.epk', '/.epk', '../.epk', ' safe.epk', 'safe .epk', 'a\0b.epk', 'a:b.epk', '.', '..']) {
        const chosen = file(archive(), false, name);
        await assert.rejects(guard.validate(chosen.value), /Unsafe/);
        assert.equal(chosen.value.reads, 0, name);
    }
    for (const name of ['native.epk', 'My World.epk', 'legacy.zip', 'Case.EPK', 'foo.bar.epk', '.epk', 'x'.repeat(32) + ' safe.epk']) {
        const chosen = file(archive(), false, name);
        assert.equal((await guard.validate(chosen.value)).files, 1, name);
        assert.equal(chosen.value.reads, 1);
    }
});
test('rejects every unsafe path, duplicate and late CRC before returning', async () => {
    for (const path of ['/absolute', '../worlds_list', 'a/../../other/level.dat', './level.dat', 'a/./b', 'a//b', 'a/', 'a\\b', 'C:world', 'a\0b', 'a\nb', 'a\x7fb', 'a\x85b', '', ' ../ExistingWorld/level.dat', '.. /ExistingWorld/level.dat', 'a/ ../level.dat', 'a/. /level.dat', 'a/ ./level.dat', 'a/ /level.dat', 'level.dat ', ' level.dat', 'a /level.dat']) await assert.rejects(guard.validate(archive({ paths: [path] })), /Unsafe/);
    await assert.rejects(guard.validate(archive({ paths: ['one', 'one'] })), /Duplicate/);
    await assert.rejects(guard.validate(archive({ paths: ['safe', 'also-safe'], corruptCRC: true })), /CRC32/);
});
test('rejects incomplete framing, count mismatch, corrupted compressed stream and resource growth', async () => {
    const data = archive();
    for (const length of [0, 8, 20, data.length - 1]) await assert.rejects(guard.validate(data.subarray(0, length)));
    for (const count of [0, 1, 3, 0xffffffff]) await assert.rejects(guard.validate(archive({ count })));
    await assert.rejects(guard.validate(archive({ tail: 'extra' })), /trailing/);
    await assert.rejects(guard.validate(archive({ tag: 'EVIL' })), /tag/);
    await assert.rejects(guard.validate(data, { limits: { inputBytes: 20 } }), /input size/);
    await assert.rejects(guard.validate(archive({ compression: 'G' }), { limits: { payloadBytes: 12 } }), /decompressed size/);
    await assert.rejects(guard.validate(data, { limits: { memberBytes: 2 } }), /member size/);
    for (const compression of ['G', 'Z']) { const damaged = archive({ compression }); damaged[damaged.length - 10] ^= 1; await assert.rejects(guard.validate(damaged)); }
    const terminator = archive(); terminator[terminator.length - 13] = 0; await assert.rejects(guard.validate(terminator), /framing/);
    const duplicateHeader = archive({ paths: ['file-type'], tag: 'HEAD' }); await assert.rejects(guard.validate(duplicateHeader), /Duplicate/);
});

// Minimal capture/bubble DOM: execute the real inherited native registrations
// and callbacks below, rather than simulating when the engine chooses to read.
class Event {
    constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles; }
    stopImmediatePropagation() { this.stopped = true; }
    preventDefault() { this.defaultPrevented = true; }
}
function environment() {
    let observers = [];
    function changed(record) { for (const observer of observers) queueMicrotask(() => observer.callback([record])); }
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.listeners = {}; this.classes = new Set(); this.classList = { add: c => this.classes.add(c) }; this.style = { setProperty() {} }; this.files = []; }
        get isConnected() { return this === doc.body || !!this.parentNode?.isConnected; }
        appendChild(node) { node.parentNode = this; this.children.push(node); changed({ addedNodes: [node], removedNodes: [] }); return node; }
        removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; changed({ addedNodes: [], removedNodes: [node] }); }
        remove() { this.parentNode?.removeChild(this); }
        contains(node) { return this === node || this.children.some(c => c.contains(node)); }
        closest(selector) { if (selector.startsWith('.') && this.classes.has(selector.slice(1))) return this; return this.parentNode?.closest(selector) || null; }
        querySelectorAll() { return this.children.flatMap(c => [ ...(c.tagName === 'INPUT' && c.type === 'file' ? [c] : []), ...c.querySelectorAll() ]); }
        querySelector(s) { return this.querySelectorAll(s)[0] || null; }
        setAttribute() {}
        set value(value) { if (value === '') this.files = []; }
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
        dispatchEvent(event) { event.target = this; for (const fn of doc.listeners[event.type] || []) { fn(event); if (event.stopped) return false; } for (const fn of this.listeners[event.type] || []) { fn(event); if (event.stopped) break; } return !event.defaultPrevented; }
        click() { this.dispatchEvent(new Event('click', { bubbles: true })); }
    }
    const doc = { listeners: {}, createElement: tag => new Element(tag), createTextNode: () => new Element('#text'), addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, removeEventListener(type, fn) { this.listeners[type] = this.listeners[type].filter(f => f !== fn); } };
    doc.body = new Element('body'); doc.documentElement = doc.body;
    class MutationObserver { constructor(callback) { this.callback = callback; } observe() { observers.push(this); } disconnect() { observers = observers.filter(o => o !== this); } }
    const win = { document: doc, Event, MutationObserver, setTimeout() {} };
    return { doc, win };
}
function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '('); assert.ok(start >= 0, name);
    const end = source.indexOf('\nfunction ', start + 1); assert.ok(end > start, name);
    return source.slice(start, end);
}
const jsSource = fs.readFileSync(require.resolve('../gamefile.html'), 'utf8');
let wasmSource;
function wasmHost() {
    if (!wasmSource) {
        const result = spawnSync('python3', ['-c', `import base64,lzma,re,struct,sys
s=open(sys.argv[1],'rb').read();p=base64.b64decode(re.search(rb'data:application/octet-stream;base64,(RUFHJFdBU0[A-Za-z0-9+/=]*)',s)[1]);at,size=struct.unpack_from('<II',p,212);sys.stdout.buffer.write(lzma.decompress(p[at:at+size]))`, require.resolve('../gamefilebetter.html')], { maxBuffer: 3 * 1024 * 1024 });
        assert.equal(result.status, 0, result.stderr?.toString()); wasmSource = result.stdout.toString();
    }
    return wasmSource;
}
function nativeChooser(engine, mobile, env) {
    const { doc, win } = env;
    if (engine === 'js') {
        const context = vm.createContext({ $rt_globals: win, FZ: () => false, B: () => false, LG() {}, Dr() {}, HCd: doc, HBi: doc.body, HG9: mobile, HG7: null, HG8: null, $rt_ustr: value => value });
        // Execute the real callbacks and File.arrayBuffer path. Only the
        // compiled suspension machinery and unrelated chooser reset are stubbed.
        vm.runInContext([extractFunction(jsSource, 'F2O'), extractFunction(jsSource, 'Gfi'), extractFunction(jsSource, 'DGO')].join('\n'), context);
        context.CQL = (input, callback) => context.F2O(input, callback); context.LIn = () => {};
        context.HuE = input => ({ handleEvent: event => context.Gfi({ cOC: input }, event) });
        context.HzI = (popup, input) => ({ handleEvent: event => context.DGO({ cNl: popup, d0A: input }, event) });
        context.HxC = popup => ({ handleEvent: () => { doc.body.removeChild(popup); context.HG8 = context.HG7 = null; } });
        context.C_ = (object, method) => object[method].bind(object); context.Hsj = input => ({ onTimer() {} });
        vm.runInContext(extractFunction(jsSource, 'Dnt'), context);
        const reset = extractFunction(jsSource, 'Dnt').match(/case 2:([A-Za-z0-9_$]+)\(\)/)[1]; context[reset] = () => {};
        context.Dnt('.epk', null);
    } else {
        const source = wasmHost(), start = source.indexOf('I.displayFileChooser=function('), end = source.indexOf(';I.fileChooserHasResult=', start);
        assert.ok(start > 0 && end > start);
        vm.runInNewContext('var t=false,G=null,x=null,z=null;function a(){if(z)Q.removeChild(z);else if(x)Q.removeChild(x);x=z=null;}\n' + source.slice(start, end) + ';I.displayFileChooser(".epk",null);', { I: {}, document: doc, window: win, Q: doc.body, Za: mobile });
    }
    const input = doc.body.querySelector('input[type="file"]'), popup = input.closest('._eaglercraftX_mobile_file_chooser_popup');
    const done = popup?.children.flatMap(c => c.children).find(c => c.classes.has('_eaglercraftX_mobile_file_chooser_btn_done'));
    const cancel = popup?.children.flatMap(c => c.children).find(c => c.classes.has('_eaglercraftX_mobile_file_chooser_btn_cancel'));
    return { input, popup, done, cancel };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate, message) {
    const deadline = Date.now() + 10000;
    while (!predicate() && Date.now() < deadline) await tick();
    assert.ok(predicate(), message);
}
function file(bytes, deferred = false, name = 'native.epk') {
    let resolve; const first = deferred ? new Promise(r => { resolve = r; }) : Promise.resolve(bytes);
    const value = { name, size: bytes.length, reads: 0, arrayBuffer() { this.reads++; return this.reads === 1 ? first : Promise.resolve(bytes); } };
    return { value, release: () => resolve(bytes) };
}
for (const engine of ['js', 'wasm']) for (const mobile of [false, true]) {
    const label = engine + (mobile ? ' mobile Done' : ' desktop change');
    test(label + ' blocks native read until complete validation, then reads once', async () => {
        const env = environment(), status = []; guard.install(env.win, { onStatus: s => status.push(s.state) });
        const chooser = nativeChooser(engine, mobile, env); await tick();
        const chosen = file(archive({ compression: 'G' }), true); chooser.input.files = [chosen.value];
        chooser.input.dispatchEvent(new Event('change', { bubbles: true })); if (mobile) { chooser.done.click(); chooser.done.click(); }
        assert.equal(chosen.value.reads, 1); await tick(); assert.equal(chosen.value.reads, 1);
        chosen.release(); await waitFor(() => chosen.value.reads === 2 && !chooser.input.isConnected, 'native read and chooser close must follow complete validation');
        assert.equal(chosen.value.reads, 2); assert.equal(chooser.input.isConnected, false); assert.deepEqual(status, ['pending', 'ready']);
    });
    test(label + ' late invalid CRC and traversal never reach native reader', async () => {
        for (const bytes of [archive({ paths: ['okay', 'late'], corruptCRC: true }), ...['../worlds_list', ' ../ExistingWorld/level.dat', '.. /ExistingWorld/level.dat', 'a/. /level.dat', 'a/ /level.dat', 'level.dat '].map(path => archive({ paths: ['level.dat', path] }))]) {
            const env = environment(); guard.install(env.win, { onStatus() {} }); const chooser = nativeChooser(engine, mobile, env); await tick();
            const chosen = file(bytes); chooser.input.files = [chosen.value]; chooser.input.dispatchEvent(new Event('change')); if (mobile) chooser.done.click(); await tick();
            assert.equal(chosen.value.reads, 1); assert.equal(chooser.input.files.length, 0); assert.equal(chooser.input.isConnected, false);
        }
    });
    test(label + ' unsafe default world names are blocked before any file read', async () => {
        for (const name of ['   .epk', ' '.repeat(32) + 'Safe.epk', '\\\\.epk', '/.epk', ' Safe.epk', 'Safe .epk']) {
            const env = environment(); guard.install(env.win, { onStatus() {} }); const chooser = nativeChooser(engine, mobile, env); await tick();
            const chosen = file(archive({ paths: ['ExistingWorld/level.dat'] }), false, name); chooser.input.files = [chosen.value];
            chooser.input.dispatchEvent(new Event('change')); if (mobile) chooser.done.click(); await tick();
            assert.equal(chosen.value.reads, 0, name); assert.equal(chooser.input.files.length, 0); assert.equal(chooser.input.isConnected, false);
        }
    });
    test(label + ' reselection, cancel and replacement cannot revive stale input', async () => {
        for (const action of ['reselect', 'cancel', 'replace', 'reopen']) {
            const env = environment(); guard.install(env.win, { onStatus() {} }); const chooser = nativeChooser(engine, mobile, env); await tick();
            const old = file(archive(), true); chooser.input.files = [old.value]; chooser.input.dispatchEvent(new Event('change')); if (mobile) chooser.done.click();
            if (action === 'reselect') { const next = file(archive()); chooser.input.files = [next.value]; chooser.input.dispatchEvent(new Event('change')); if (mobile) chooser.done.click(); }
            if (action === 'cancel') { if (mobile) chooser.cancel.click(); else chooser.input.dispatchEvent(new Event('cancel')); }
            if (action === 'replace') { (chooser.popup || chooser.input).remove(); nativeChooser(engine, mobile, env); }
            if (action === 'reopen') chooser.input.click();
            await tick(); old.release(); await tick(); assert.equal(old.value.reads, 1, action);
        }
    });
}
test('pending native callbacks never replay into a replaced or inaccessible iframe Document', async () => {
    for (const engine of ['js', 'wasm']) for (const mobile of [false, true]) for (const inaccessible of [false, true]) {
        const label = `${engine} ${mobile ? 'mobile' : 'desktop'} ${inaccessible ? 'cross-origin' : 'replaced Document'}`;
        const env = environment(), statuses = []; const control = guard.install(env.win, { onStatus: status => statuses.push(status.state) });
        const chooser = nativeChooser(engine, mobile, env); await tick();
        const chosen = file(archive(), true); chooser.input.files = [chosen.value];
        chooser.input.dispatchEvent(new Event('change')); if (mobile) chooser.done.click();
        assert.equal(chosen.value.reads, 1, label);
        // Deliberately retain the old Document and its connected input, just
        // as a parent-realm promise can retain them after WindowProxy changes.
        let documentChecks = 0;
        const nextDocument = environment().doc;
        Object.defineProperty(env.win, 'document', { get() {
            documentChecks++;
            if (inaccessible) { const error = new Error('Cross-origin Document access'); error.name = 'SecurityError'; throw error; }
            return nextDocument;
        } });
        chosen.release();
        await waitFor(() => documentChecks > 0, label + ' must recheck Document after validation');
        assert.equal(chosen.value.reads, 1, label + ': zero native reads');
        assert.equal(chooser.input.isConnected, true, label + ': old chooser was not replayed/removed');
        assert.equal(chooser.input.files[0], chosen.value, label + ': old selection unchanged');
        assert.deepEqual(statuses, ['pending'], label + ': no stale success/error presentation');
        control.dispose();
    }
});
test('other file pickers are untouched and install is idempotent/disposable', async () => {
    const env = environment(); const control = guard.install(env.win, { onStatus() {} }); assert.equal(guard.install(env.win), control);
    for (const accept of ['.png', '.zip', '.epk,.zip', '']) {
        const input = env.doc.createElement('input'); input.type = 'file'; input.accept = accept; env.doc.body.appendChild(input);
        let reads = 0; input.addEventListener('change', () => reads++); input.files = [file(archive()).value]; input.dispatchEvent(new Event('change')); assert.equal(reads, 1);
    }
    control.dispose(); assert.notEqual(guard.install(env.win, { onStatus() {} }), control);
});
