const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = process.env.NEXUS_RUNTIME_DIR || path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'gamefile.html'), 'utf8');
const wasm = fs.readFileSync(path.join(root, 'gamefilebetter.html'), 'utf8');
const payload = Buffer.from(wasm.match(/data:application\/octet-stream;base64,(RUFHJFdBU00[A-Za-z0-9+/=]*)/)[1], 'base64');
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

test('WASM repair preserves the customized payload, not just a valid checksum', () => {
    assert.equal(crypto.createHash('sha256').update(payload.subarray(16)).digest('hex'),
        'e49035f76b3ba96f674f8f4bc97a096199a257d03f0e2e93a83ad2d07a9c1400');
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
