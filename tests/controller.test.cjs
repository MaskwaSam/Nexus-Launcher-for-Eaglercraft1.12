const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1]).filter((source) => source.trim());

function eventTarget() {
    const listeners = new Map();
    return {
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        dispatchEvent(event) {
            for (const listener of listeners.get(event.type) || []) listener(event);
            return true;
        }
    };
}

function launcher() {
    const events = [];
    const operations = [];
    const frames = new Map();
    let nextFrame = 0;
    let gamepads = [];
    function gameWindow() {
        const received = [];
        return {
            events: received,
            dispatchEvent() {},
            document: {
                dispatchEvent(event) {
                    received.push(event);
                    events.push(event);
                    operations.push(event.type);
                }
            }
        };
    }
    const frame = Object.assign(eventTarget(), {
        style: { display: 'none' },
        contentWindow: gameWindow()
    });
    Object.defineProperty(frame, 'src', {
        set(url) { operations.push(`navigate:${url}`); }
    });
    const elements = {
        'game-frame': frame,
        'btn-js': eventTarget(),
        'btn-wasm': eventTarget()
    };
    const document = Object.assign(eventTarget(), {
        body: { style: {} },
        documentElement: {},
        fullscreenElement: null,
        getElementById(id) { return elements[id]; },
        exitFullscreen() { this.fullscreenElement = null; }
    });
    class Event {
        constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
    }
    const window = Object.assign(eventTarget(), { scrollTo() {} });
    const context = vm.createContext({
        window, document,
        navigator: { getGamepads: () => gamepads },
        Event, KeyboardEvent: Event, MouseEvent: Event,
        requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame(id) { frames.delete(id); },
        console: { log() {}, warn() {} }
    });
    scripts.forEach((source) => new vm.Script(source).runInContext(context));
    return {
        events, operations, frame, document, gameWindow,
        setGamepads(pads) { gamepads = pads; },
        connect(pad) {
            gamepads = [pad];
            window.dispatchEvent({ type: 'gamepadconnected', gamepad: pad });
        },
        disconnect() {
            gamepads = [];
            window.dispatchEvent({ type: 'gamepaddisconnected' });
        },
        tick() {
            assert.equal(frames.size, 1, 'only one controller polling loop should be scheduled');
            const [id, callback] = frames.entries().next().value;
            frames.delete(id);
            callback();
        },
        pendingFrames() { return frames.size; },
        launch(url = 'gamefile.html') { context.launchGame(url); },
        exit() { context.exitGame(); },
        fullscreenExit() { document.dispatchEvent({ type: 'fullscreenchange' }); },
        keyEvents(code) { return events.filter((event) => event.code === code).map((event) => event.type); }
    };
}

function gamepad() {
    return {
        id: 'Test standard controller',
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 16 }, () => ({ pressed: false }))
    };
}

test('launcher inline scripts and service worker parse', () => {
    assert.equal(scripts.length, 2, 'both launcher and controller scripts are exercised');
    scripts.forEach((source) => new vm.Script(source));
    new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'));
});

for (const button of [8, 9]) {
    test(`holding menu button ${button} sends one Escape down and one up`, () => {
        const app = launcher();
        const pad = gamepad();
        pad.buttons[button].pressed = true;
        app.connect(pad);
        app.launch();
        app.tick();
        app.tick();
        assert.deepEqual(app.keyEvents('Escape'), ['keydown']);
        pad.buttons[button].pressed = false;
        app.tick();
        assert.deepEqual(app.keyEvents('Escape'), ['keydown', 'keyup']);
    });
}

test('Escape remains held while either Back or Start is pressed', () => {
    const app = launcher();
    const pad = gamepad();
    app.connect(pad);
    app.launch();
    pad.buttons[8].pressed = true;
    app.tick();
    pad.buttons[9].pressed = true;
    app.tick();
    pad.buttons[8].pressed = false;
    app.tick();
    assert.deepEqual(app.keyEvents('Escape'), ['keydown']);
    pad.buttons[9].pressed = false;
    app.tick();
    assert.deepEqual(app.keyEvents('Escape'), ['keydown', 'keyup']);
});

test('disconnect releases held movement and buttons, then reconnect sends fresh downs', () => {
    const app = launcher();
    const pad = gamepad();
    pad.axes[0] = -1;
    pad.axes[1] = -1;
    pad.buttons[0].pressed = true;
    app.connect(pad);
    app.launch();
    app.tick();
    app.disconnect();
    assert.equal(app.pendingFrames(), 0);
    for (const code of ['KeyW', 'KeyA', 'Space']) {
        assert.deepEqual(app.keyEvents(code), ['keydown', 'keyup']);
    }
    app.disconnect();
    app.connect(pad);
    app.tick();
    for (const code of ['KeyW', 'KeyA', 'Space']) {
        assert.deepEqual(app.keyEvents(code), ['keydown', 'keyup', 'keydown']);
    }
});

for (const action of ['exit', 'fullscreenExit', 'replace']) {
    test(`${action} releases keys before navigating and allows fresh input`, () => {
        const app = launcher();
        const pad = gamepad();
        pad.axes[1] = -1;
        pad.buttons[0].pressed = true;
        app.connect(pad);
        app.launch();
        app.tick();
        app.operations.length = 0;
        if (action === 'replace') app.launch('gamefilebetter.html');
        else app[action]();
        assert.deepEqual(app.operations.slice(0, 2), ['keyup', 'keyup']);
        assert.match(app.operations[2], /^navigate:/);
        for (const code of ['KeyW', 'Space']) {
            assert.deepEqual(app.keyEvents(code), ['keydown', 'keyup']);
        }
        if (action !== 'replace') {
            assert.equal(app.frame.style.display, 'none');
            app.tick();
            assert.deepEqual(app.keyEvents('KeyW'), ['keydown', 'keyup']);
            app.launch();
        }
        app.frame.contentWindow = app.gameWindow();
        app.tick();
        assert.deepEqual(app.keyEvents('KeyW'), ['keydown', 'keyup', 'keydown']);
        assert.deepEqual(app.keyEvents('Space'), ['keydown', 'keyup', 'keydown']);
    });
}

for (const unavailable of ['gamepad', 'game', 'window']) {
    test(`loss of ${unavailable} releases keys and recovery resets their state`, () => {
        const app = launcher();
        const pad = gamepad();
        pad.buttons[1].pressed = true;
        app.connect(pad);
        app.launch();
        app.tick();
        if (unavailable === 'gamepad') app.setGamepads([]);
        if (unavailable === 'game') app.frame.style.display = 'none';
        if (unavailable === 'window') app.frame.contentWindow = null;
        app.tick();
        app.tick();
        assert.deepEqual(app.keyEvents('ShiftLeft'), ['keydown', 'keyup']);
        app.setGamepads([pad]);
        app.frame.style.display = 'block';
        app.frame.contentWindow = app.gameWindow();
        app.tick();
        assert.deepEqual(app.keyEvents('ShiftLeft'), ['keydown', 'keyup', 'keydown']);
    });
}

test('a replaced game window gets fresh downs after old-window releases', () => {
    const app = launcher();
    const pad = gamepad();
    pad.buttons[3].pressed = true;
    app.connect(pad);
    app.launch();
    app.tick();
    const oldWindow = app.frame.contentWindow;
    const newWindow = app.gameWindow();
    app.frame.contentWindow = newWindow;
    app.tick();
    assert.deepEqual(app.keyEvents('KeyE'), ['keydown', 'keyup', 'keydown']);
    assert.deepEqual(oldWindow.events.map((event) => event.type), ['keydown', 'keyup']);
    assert.deepEqual(newWindow.events.map((event) => event.type), ['keydown']);
});

test('iframe load resets held input even when its window reference stays the same', () => {
    const app = launcher();
    const pad = gamepad();
    pad.buttons[0].pressed = true;
    app.connect(pad);
    app.launch();
    app.tick();
    app.frame.dispatchEvent({ type: 'load' });
    app.tick();
    assert.deepEqual(app.keyEvents('Space'), ['keydown', 'keyup', 'keydown']);
});

test('repeated connection events keep one polling loop and disconnect cancels it', () => {
    const app = launcher();
    const pad = gamepad();
    app.connect(pad);
    app.connect(pad);
    app.tick();
    assert.equal(app.pendingFrames(), 1);
    app.disconnect();
    assert.equal(app.pendingFrames(), 0);
    app.connect(pad);
    app.tick();
    assert.equal(app.pendingFrames(), 1);
});

test('movement deadzone, other buttons and mouse look retain their mappings', () => {
    const app = launcher();
    const pad = gamepad();
    pad.axes = [0.25, -0.25, 0.6, -0.8];
    for (const button of [0, 1, 2, 3, 4, 5, 12, 13, 14, 15]) pad.buttons[button].pressed = true;
    app.connect(pad);
    app.launch();
    app.tick();
    assert.deepEqual(app.events.filter((event) => event.type === 'keydown').map((event) => event.code),
        ['Space', 'ShiftLeft', 'KeyQ', 'KeyE', 'Digit1', 'Digit2', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    const mouse = app.events.find((event) => event.type === 'mousemove');
    assert.equal(mouse.movementX, 6);
    assert.equal(mouse.movementY, -8);
    pad.axes = [1, 1, 0, 0];
    pad.buttons.forEach((button) => { button.pressed = false; });
    app.tick();
    assert.deepEqual(app.keyEvents('KeyD'), ['keydown']);
    assert.deepEqual(app.keyEvents('KeyS'), ['keydown']);
    assert.deepEqual(app.keyEvents('Space'), ['keydown', 'keyup']);
});
