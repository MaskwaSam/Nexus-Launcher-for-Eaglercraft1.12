const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function deferredUi(currentDocument, guardAvailable = true, options = {}) {
    const frame = new EventTarget(), installs = [], errors = [], states = new WeakMap();
    let foreground = options.foreground !== false, currentWindow;
    frame.style = { display: options.display || 'none' };
    Object.defineProperty(frame, 'contentWindow', {
        get() { return currentWindow; },
        set(win) {
            const doc = win.document;
            const state = { focused: Boolean(options.childFocused), focusCalls: 0, handlers: new Map() };
            states.set(doc, state);
            doc.hasFocus = () => state.focused;
            doc.addEventListener = (type, handler, capture) => {
                assert.equal(capture, true);
                const handlers = state.handlers.get(type) || [];
                handlers.push(handler); state.handlers.set(type, handlers);
            };
            win.focus = () => { state.focused = true; state.focusCalls++; };
            currentWindow = win;
        }
    });
    const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
    const buttons = Object.fromEntries(['btn-js', 'btn-wasm'].map(id => {
        assert.match(html, new RegExp('<button[^>]*id="' + id + '"[^>]* disabled[ >]'));
        return [id, { disabled: true }];
    }));
    const launcherStatus = { hidden: false, textContent: 'Loading launcher…' };
    frame.contentWindow = { document: currentDocument };
    Object.defineProperty(frame, 'contentDocument', { get() { return frame.contentWindow.document; } });
    const context = {
        document: {
            hasFocus() { return foreground; },
            getElementById(id) { return id === 'game-frame' ? frame : id === 'launcher-ready-status' ? launcherStatus : buttons[id] || null; }
        },
        window: { EpkImportGuard: guardAvailable ? { install(win) { installs.push(win.document); } } : undefined },
        console: { error(...args) { errors.push(args); } }
    };
    // Deliberately omit backup controls/core. Frame protection is independent.
    vm.runInNewContext(fs.readFileSync(require.resolve('../assets/world-backups-ui.js'), 'utf8'), context);
    return {
        frame, installs, errors, buttons, launcherStatus, state: doc => states.get(doc),
        setForeground(value) { foreground = value; },
        pointer(doc, target = 'CANVAS', trusted = true) {
            for (const handler of states.get(doc).handlers.get('pointerdown') || []) handler({ target: { tagName: target }, isTrusted: trusted });
        }
    };
}

test('delayed deferred UI installs import protection on an already loaded game', () => {
    const loadedGame = { readyState: 'complete', documentElement: {} };
    const { installs, errors, buttons, launcherStatus } = deferredUi(loadedGame);
    assert.ok(Object.values(buttons).every(button => button.disabled === false));
    assert.equal(launcherStatus.hidden, true);
    assert.deepEqual(installs, [loadedGame]);
    assert.deepEqual(errors, []);
});

test('current blank document and later navigations each receive import protection', () => {
    const blank = { readyState: 'complete', documentElement: {} };
    const { frame, installs, errors } = deferredUi(blank);
    const firstGame = { readyState: 'complete', documentElement: {} };
    frame.contentWindow = { document: firstGame };
    frame.dispatchEvent(new Event('load'));
    const reloadedGame = { readyState: 'complete', documentElement: {} };
    frame.contentWindow = { document: reloadedGame };
    frame.dispatchEvent(new Event('load'));
    assert.deepEqual(installs, [blank, firstGame, reloadedGame]);
    assert.deepEqual(errors, []);
});

test('an initial document without a root waits for its load before installation', () => {
    const loading = { readyState: 'loading', documentElement: null };
    const { frame, installs, errors } = deferredUi(loading);
    assert.deepEqual(installs, []);
    loading.documentElement = {};
    loading.readyState = 'complete';
    frame.dispatchEvent(new Event('load'));
    assert.deepEqual(installs, [loading]);
    assert.deepEqual(errors, []);
});


test('launches remain disabled if the import guard dependency is unavailable', () => {
    const { installs, errors, buttons, launcherStatus } = deferredUi({ readyState: 'complete', documentElement: {} }, false);
    assert.deepEqual(installs, []);
    assert.deepEqual(errors, []);
    assert.ok(Object.values(buttons).every(button => button.disabled === true));
    assert.equal(launcherStatus.hidden, false);
    assert.match(launcherStatus.textContent, /could not load.*Reload/);
});


test('game load focuses only an active visible child that needs keyboard focus', () => {
    for (const [display, foreground, childFocused, expected] of [
        ['block', true, false, 1], ['none', true, false, 0],
        ['block', false, false, 0], ['block', true, true, 0]
    ]) {
        const doc = { documentElement: {} };
        const app = deferredUi(doc, true, { display, foreground, childFocused });
        assert.equal(app.state(doc).focusCalls, expected);
        assert.deepEqual(app.errors, []);
    }
});

test('trusted canvas pointer focuses a foreground game while file inputs and synthetic events stay native', () => {
    const doc = { documentElement: {} };
    const app = deferredUi(doc, true, { display: 'block', foreground: false });
    app.pointer(doc); assert.equal(app.state(doc).focusCalls, 0);
    app.setForeground(true);
    app.pointer(doc, 'INPUT'); app.pointer(doc, 'CANVAS', false);
    assert.equal(app.state(doc).focusCalls, 0);
    app.pointer(doc); assert.equal(app.state(doc).focusCalls, 1);
    app.frame.dispatchEvent(new Event('load'));
    assert.equal(app.state(doc).handlers.get('pointerdown').length, 1);
    app.state(doc).focused = false;
    app.frame.style.display = 'none'; app.pointer(doc);
    assert.equal(app.state(doc).focusCalls, 1);
});

test('a replaced game document cannot focus its replacement through a stale pointer event', () => {
    const oldDoc = { documentElement: {} }, newDoc = { documentElement: {} };
    const app = deferredUi(oldDoc, true, { display: 'block', foreground: false });
    app.frame.contentWindow = { document: newDoc };
    app.frame.dispatchEvent(new Event('load'));
    app.setForeground(true); app.pointer(oldDoc);
    assert.equal(app.state(oldDoc).focusCalls, 0);
    assert.equal(app.state(newDoc).focusCalls, 0);
    app.pointer(newDoc);
    assert.equal(app.state(newDoc).focusCalls, 1);
});
