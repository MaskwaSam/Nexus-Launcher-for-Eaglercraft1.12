const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = process.env.NEXUS_RUNTIME_DIR || path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'gamefile.html'), 'utf8');
const wasm = fs.readFileSync(path.join(root, 'gamefilebetter.html'), 'utf8');
const payload = Buffer.from(wasm.match(/data:application\/octet-stream;base64,(RUFHJFdBU0[A-Za-z0-9+/=]*)/)[1], 'base64');
const crcTable = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    return crc >>> 0;
});

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
}

async function decodeEPW(data) {
    const pool = [null];
    const logs = [];
    let native;
    let failure = null;
    let loaded = false;
    const heap = () => new Uint8Array(native.o.buffer);
    const readString = (pointer) => {
        const bytes = heap();
        return Buffer.from(bytes.subarray(pointer, bytes.indexOf(0, pointer))).toString();
    };
    const push = (value) => { pool.push(value); return pool.length - 1; };
    const imports = { a: {
        a: (pointer) => { failure = readString(pointer); },
        b: (pointer) => { logs.push(readString(pointer)); },
        c: (pointer) => { logs.push(readString(pointer)); },
        d: (target, source, length) => { heap().set(data.subarray(source, source + length), target); },
        e: (length) => push(new Uint8Array(length)),
        f: (source, length) => push(data.subarray(source, source + length).toString()),
        g: (target, offset, source, length) => { pool[target].set(data.subarray(source, source + length), offset); },
        h: () => { failure = 'JSPI unavailable'; },
        // Container-decoder tests model a JSPI-capable host; they do not test browser support.
        i: () => 1,
        j: (size) => {
            if (size > 67108864) return 0;
            native.o.grow(Math.max(0, Math.ceil((size - native.o.buffer.byteLength) / 65536)));
            return 1;
        },
        k: (target, source, length) => { heap().copyWithin(target, source, source + length); },
        l: (target, source, offset, length) => { pool[target].set(heap().subarray(source, source + length), offset); },
        m: () => { loaded = true; },
        n: () => data.length
    } };
    const start = data.readUInt32LE(180);
    const size = data.readUInt32LE(184);
    native = (await WebAssembly.instantiate(data.subarray(start, start + size), imports)).instance.exports;
    native.p();
    native.q(0, 0);
    return { failure, loaded, logs, decoded: pool.filter((value) => value instanceof Uint8Array) };
}

const nativeDecode = decodeEPW(payload);
const wasmHost = nativeDecode.then((result) => {
    assert.equal(result.failure, null, result.logs.join('\n'));
    const source = result.decoded.map((bytes) => Buffer.from(bytes).toString('utf8'))
        .find((source) => source.includes('async function Vb(){'));
    assert.ok(source, 'The native decoder must return the actual browser host component');
    return source;
});

async function wasmCanvasInput() {
    const source = await wasmHost;
    const inputStart = source.indexOf('async function Vb(){');
    const mapperStart = source.indexOf('function b(m){const A=m.length', inputStart);
    const mapperEnd = source.indexOf('function d(m,A){', mapperStart);
    const handlersStart = source.indexOf('R.addEventListener("mousedown",ua=', mapperEnd);
    const handlersEnd = source.indexOf('window.addEventListener("blur",Cb=', handlersStart);
    assert.ok(inputStart >= 0 && mapperStart > inputStart && mapperEnd > mapperStart && handlersStart > mapperEnd && handlersEnd > handlersStart);
    const listeners = new Map();
    const records = [];
    const locks = [];
    let keyboardCloses = 0;
    const context = vm.createContext({
        R: { addEventListener: (type, handler) => { listeners.set(type, handler); } },
        document: { pointerLockElement: null }, Ba: false, wa: false, W: 10, da: 20,
        U: (group, type, eventObj) => { records.push({ group, type, eventObj }); },
        z: () => { keyboardCloses++; }, t: (value) => { locks.push(value); }
    });
    vm.runInContext(source.slice(mapperStart, mapperEnd) + source.slice(handlersStart, handlersEnd), context);
    const touchList = (points) => ({ length: points.length, item: (index) => points[index] });
    return {
        context, locks,
        get records() { return JSON.parse(JSON.stringify(records)); },
        get keyboardCloses() { return keyboardCloses; },
        send(type, extra = {}) {
            const event = { prevented: 0, stopped: 0,
                preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...extra };
            listeners.get(type)(event);
            return event;
        },
        touch(type, changed, target = []) {
            return this.send(type, { changedTouches: touchList(changed), targetTouches: touchList(target) });
        }
    };
}

for (const [edition, source] of [['JS', runtime], ['WASM', wasm]]) {
    test(`${edition} launch options preserve upstream warning defaults and stored settings`, () => {
        const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
        const writes = [];
        const context = vm.createContext({ window: { localStorage: {
            getItem() { throw new Error('launch options must not read or rewrite saved settings'); },
            setItem(...args) { writes.push(args); }
        } }, Math });
        vm.runInContext(script, context);
        assert.equal(context.window.eaglercraftXOpts.worldsDB, 'worlds');
        assert.equal(context.window.eaglercraftXOpts.container, 'game_frame');
        assert.deepEqual(writes, []);
        assert.doesNotMatch(script, /hasHiddenPhishWarning|hideDefaultUsernameWarning|suppressEagler/);
    });
}

function runtimeFunction(name) {
    const match = runtime.match(new RegExp('function ' + name + '\\([\\s\\S]*?(?=\\n(?:function |var ))'));
    return match ? match[0] : '';
}

function mobileStartup({ mobile = true, suspendDisplay = false, failPrompt = false } = {}) {
    const children = [];
    const buttons = [];
    const completed = [];
    const javaThread = {};
    let restoredThread = null;
    let displayResume = null;
    let displayPending = suspendDisplay;
    const context = vm.createContext({
        $rt_globals: { Error },
        $rt_getThread: () => javaThread,
        $rt_setThread: (thread) => { restoredThread = thread; },
        HIF: 0, HIE: 0, HIG: null, HIH: null, HG9: mobile ? 1 : 0,
        HIC: {}, HID: {},
        HIe: {
            appendChild: (node) => { children.push(node); },
            removeChild: (node) => {
                assert.ok(children.includes(node));
                children.splice(children.indexOf(node), 1);
            }
        },
        HId: { document: { createElement: () => {
            if (failPrompt) throw new Error('prompt creation failed');
            const listeners = new Map();
            const button = {
                addEventListener: (type, listener) => { listeners.set(type, listener); },
                click: () => { listeners.get('click')({ type: 'click' }); }
            };
            buttons.push(button);
            return { classList: { add() {} }, setAttribute() {}, querySelector: () => button };
        } } },
        BBQ: function () {},
        C_: (instance, method) => {
            assert.equal(method, 'handleEvent');
            return (event) => context.GYg(instance, event);
        },
        CU8() {}, F4s() {}, E3q: () => false,
        Da9: () => {
            const thread = context.$rt_nativeThread();
            if (thread.isResuming()) { thread.status = 0; return; }
            if (displayPending) {
                displayPending = false;
                thread.suspend((resume) => { displayResume = resume; });
            }
        },
        F: (error) => error,
        I: (error) => { throw error; },
        FV: () => { throw new Error('invalid startup state'); }
    });
    const threadStart = runtime.indexOf('function TeaVMThread(');
    const threadEnd = runtime.indexOf('function $rt_invalidPointer()', threadStart);
    assert.ok(threadStart >= 0 && threadEnd > threadStart);
    vm.runInContext(runtime.slice(threadStart, threadEnd), context);
    context.B = context.$rt_suspending;
    context.FZ = context.$rt_resuming;
    context.Ds = context.$rt_nativeThread;
    vm.runInContext(['waitForMobileLaunch', 'DJt', 'FK3', 'GYg'].map(runtimeFunction).join('\n'), context);
    function start() {
        const thread = new context.TeaVMThread(() => context.DJt());
        thread.start((result) => { completed.push(result); });
        return thread;
    }
    const thread = start();
    return { context, children, buttons, completed, thread, start,
        resumeDisplay: () => displayResume(),
        restoredJavaThread: () => restoredThread === javaThread };
}

test('CRC32 implementation matches the standard check vector', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('bundled WASM EPW checksum matches its payload', () => {
    assert.equal(payload.subarray(0, 8).toString(), 'EAG$WASM');
    assert.equal(payload.readUInt32LE(8), payload.length);
    assert.equal(payload.readUInt32LE(12), crc32(payload.subarray(16)));
});

test('the actual bundled WASM loader validates and decompresses the entire EPW', async () => {
    const result = await nativeDecode;
    assert.equal(result.failure, null, result.logs.join('\n'));
    assert.equal(result.loaded, true);
});

test('the native loader preserves components and the reviewed bootstrap and debug repairs', async () => {
    const result = await nativeDecode;
    const hashes = result.decoded.map((bytes) => crypto.createHash('sha256').update(bytes).digest('hex'));
    for (const hash of [
        '1413de7cea72222962784280a248c638b056426a23d2d20a85dbd53789e2f78c',
        '0a69472bdb4b2353a7069327d48a2a89751a033d2dad2b8b575dee5048c66b53',
        '4fcb9bc840ae4bbaebed8658e8a505d73a7f5b82d1b820b7da960ebde5957678',
        'e341684f4c42e0a115498040ef357d1ede36c446f72a6d85c6bedc93e4d03490',
        '02e8a6157a8d944f79641c871fd6912cefd8f7cae87e0761c5a5c09a53e57e0a',
        '2f67c8f737c0fb6d00c208169c396fac9fa608fff189a7d5621ccef524ab4c7e'
    ]) assert.ok(hashes.includes(hash), 'Missing preserved component ' + hash);
    const start = payload.readUInt32LE(196);
    const size = payload.readUInt32LE(200);
    assert.equal(crypto.createHash('sha256').update(payload.subarray(start, start + size)).digest('hex'),
        '9b4fc6f96b5f0d4825c40460302c1ecdd426a384e66129a182e417f271eaeff0');
});

test('WASM native-tap repair removes only two canvas cancellation calls', async () => {
    let source = await wasmHost;
    for (const prefix of ['R.addEventListener("touchstart",pb=function(m){', 'R.addEventListener("touchend",qb=function(m){']) {
        const repaired = prefix + 'm.stopPropagation();';
        assert.equal(source.split(repaired).length - 1, 1);
        source = source.replace(repaired, prefix + 'm.preventDefault();m.stopPropagation();');
    }
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'),
        'af9165310c1abb4ab3a9b77f954f52703cb3b5ae9c4b763a0457f4358b6d8b7a',
        'Restoring the two calls must recover the complete original host bytes');
});

test('WASM canvas taps allow native mouse compatibility while retaining touch records', async () => {
    const input = await wasmCanvasInput();
    const point = { identifier: 0, pageX: 40.5, pageY: 90, radiusX: 6, radiusY: 10, force: 0.5 };
    const start = input.touch('touchstart', [point], [point]);
    const end = input.touch('touchend', [point]);
    assert.equal(start.prevented, 0, 'touchstart must permit browser-native mouse events');
    assert.equal(end.prevented, 0, 'touchend must permit browser-native mouse events');
    assert.equal(start.stopped, 1);
    assert.equal(end.stopped, 1);
    assert.equal(input.keyboardCloses, 1);
    const converted = { pointX: 30.5, pointY: 70, radius: 8, force: 0.5, pointUID: 0 };
    assert.deepEqual(input.records, [
        { group: 0, type: 2, eventObj: { eventType: 0, changedTouches: [converted], targetTouches: [converted] } },
        { group: 0, type: 2, eventObj: { eventType: 2, changedTouches: [converted], targetTouches: [] } }
    ], 'Handlers retain native touch records without fabricating mouse queue entries');
});

test('WASM touch movement and cancellation retain their existing behavior', async () => {
    const input = await wasmCanvasInput();
    const point = { identifier: 7, pageX: 18, pageY: 29, radiusX: 2, radiusY: 4, force: 1 };
    const move = input.touch('touchmove', [point], [point]);
    const cancel = input.touch('touchcancel', [point]);
    assert.equal(move.prevented, 1, 'drag cancellation must remain enabled');
    assert.equal(move.stopped, 1);
    assert.equal(cancel.prevented, 0);
    assert.equal(cancel.stopped, 0);
    assert.deepEqual(input.records.map((record) => record.eventObj.eventType), [1, 2]);
    assert.deepEqual(input.records[0].eventObj.changedTouches, [{ pointX: 8, pointY: 9, radius: 3, force: 1, pointUID: 7 }]);
});

test('WASM desktop mouse and wheel handlers retain their event mappings', async () => {
    const input = await wasmCanvasInput();
    const events = ['mousedown', 'mouseup', 'mousemove', 'wheel'].map((type) =>
        input.send(type, { offsetX: 120, offsetY: 80, button: 2, movementX: 6, movementY: -8, deltaY: 120 }));
    assert.ok(events.every((event) => event.prevented === 1 && event.stopped === 1));
    assert.deepEqual(input.records, [
        { group: 0, type: 0, eventObj: { eventType: 0, posX: 120, posY: 80, button: 2 } },
        { group: 0, type: 0, eventObj: { eventType: 1, posX: 120, posY: 80, button: 2 } },
        { group: 0, type: 0, eventObj: { eventType: 2, posX: 120, posY: 80, movementX: 6, movementY: -8 } },
        { group: 0, type: 0, eventObj: { eventType: 3, posX: 120, posY: 80, wheel: 120 } }
    ]);
});

test('WASM mouse pointer-lock activation behavior remains unchanged', async () => {
    const input = await wasmCanvasInput();
    input.context.Ba = true;
    input.context.wa = true;
    input.send('mousedown', { offsetX: 2, offsetY: 3, button: 0 });
    assert.deepEqual(input.locks, [1]);
    assert.deepEqual(input.records, []);
    input.context.document.pointerLockElement = input.context.R;
    input.send('mousedown', { offsetX: 2, offsetY: 3, button: 0 });
    assert.equal(input.records[0].eventObj.eventType, 0);
});

test('the actual WASM loader still rejects an invalid EPW checksum', async () => {
    const corrupt = Buffer.from(payload);
    corrupt[corrupt.length - 1] ^= 1;
    const result = await decodeEPW(corrupt);
    assert.equal(result.failure, 'EPW file has an invalid checksum');
    assert.equal(result.loaded, false);
});

test('EPW checksum still detects a corrupted payload', () => {
    const corrupt = Buffer.from(payload);
    corrupt[corrupt.length - 1] ^= 1;
    assert.notEqual(corrupt.readUInt32LE(12), crc32(corrupt.subarray(16)));
});

test('mobile startup stays suspended with a live launch callback before input', () => {
    const app = mobileStartup();
    assert.equal(app.completed.length, 0);
    assert.equal(app.context.HIE, 0);
    assert.equal(app.context.HIF, 1);
    assert.equal(typeof app.context.HIH.ei9, 'function');
    assert.equal(app.children.length, 1);
    assert.equal(app.thread.isSuspending(), true);
});

test('mobile launch click removes the prompt and resumes startup exactly once', () => {
    const app = mobileStartup();
    const button = app.buttons[0];
    button.click();
    assert.equal(app.completed.length, 1);
    assert.equal(app.completed[0], undefined);
    assert.equal(app.context.HIE, 1);
    assert.equal(app.context.HIF, 0);
    assert.equal(app.context.HIH, null);
    assert.equal(app.context.HIG, null);
    assert.equal(app.children.length, 0);
    assert.equal(app.thread.stack.length, 0);
    assert.equal(app.restoredJavaThread(), true);
    button.click();
    assert.equal(app.completed.length, 1);
});

test('the existing keyboard callback can also resume mobile startup', () => {
    const app = mobileStartup();
    assert.notEqual(app.context.HIH, null);
    app.context.HIH.ei9(1);
    assert.equal(app.completed.length, 1);
    assert.equal(app.context.HIE, 1);
    assert.equal(app.children.length, 0);
});

test('mobile launch waits for asynchronous display initialization first', () => {
    const app = mobileStartup({ suspendDisplay: true });
    assert.equal(app.buttons.length, 0);
    assert.equal(app.completed.length, 0);
    app.resumeDisplay();
    assert.equal(app.buttons.length, 1);
    assert.equal(app.completed.length, 0);
    app.buttons[0].click();
    assert.equal(app.completed.length, 1);
    assert.equal(app.context.HIE, 1);
});

test('a second mobile launch has a fresh callback and can resume again', () => {
    const app = mobileStartup();
    const firstCallback = app.context.HIH;
    app.buttons[0].click();
    app.start();
    assert.equal(app.completed.length, 1);
    assert.notEqual(app.context.HIH, firstCallback);
    app.buttons[1].click();
    assert.equal(app.completed.length, 2);
    assert.equal(app.context.HIH, null);
});

test('desktop startup is unchanged and creates no mobile prompt', () => {
    const app = mobileStartup({ mobile: false });
    assert.equal(app.completed.length, 1);
    assert.equal(app.completed[0], undefined);
    assert.equal(app.context.HIE, 1);
    assert.equal(app.buttons.length, 0);
    assert.equal(app.context.HIF, 0);
});

test('prompt creation errors do not leave the mobile gate active', () => {
    const app = mobileStartup({ failPrompt: true });
    assert.equal(app.completed.length, 1);
    assert.match(app.completed[0].message, /prompt creation failed/);
    assert.equal(app.context.HIF, 0);
    assert.equal(app.context.HIE, 0);
    assert.equal(app.context.HIH, null);
});
