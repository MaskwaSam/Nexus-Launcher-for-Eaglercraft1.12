// Optional browser checks: requires Playwright and a Chromium browser.
// This file is deliberately outside the default *.test.cjs Node suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium, devices } = require(process.env.NEXUS_PLAYWRIGHT_MODULE || 'playwright');

const root = path.join(__dirname, '..');
const output = process.env.NEXUS_BROWSER_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-browser-'));
fs.mkdirSync(output, { recursive: true });
const results = { checks: [], limitations: ['Simulated controllers and emulated touch; no physical devices or gameplay.'], requests404: [] };
const check = (name, detail = {}) => { results.checks.push({ name, status: 'pass', ...detail }); console.log('PASS ' + name); };

function observeInputs() {
    const add = EventTarget.prototype.addEventListener;
    window.__bindings = [];
    window.__inputs = [];
    EventTarget.prototype.addEventListener = function(type, handler, options) {
        if (['keydown', 'mousemove'].includes(type)) window.__bindings.push({ type, canvas: this instanceof HTMLCanvasElement });
        return add.call(this, type, handler, options);
    };
    for (const type of ['keydown', 'keyup']) add.call(window, type, event => {
        if (!event.isTrusted) window.__inputs.push({ type, code: event.code, target: event.target === document ? 'document' : 'other' });
    }, true);
    if (window.top !== window) return;
    window.__pad = { id: 'Simulated integration controller', index: 1, connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
    Object.defineProperty(navigator, 'getGamepads', { value: () => window.__pad.connected ? [null, window.__pad] : [] });
    window.__connect = connected => {
        window.__pad.connected = connected;
        const event = new Event(connected ? 'gamepadconnected' : 'gamepaddisconnected');
        Object.defineProperty(event, 'gamepad', { value: window.__pad });
        window.dispatchEvent(event);
    };
}

async function ready(frame) {
    await frame.waitForFunction(() => window.__bindings.some(item => item.type === 'keydown') && window.__bindings.some(item => item.type === 'mousemove' && item.canvas), null, { timeout: 60000 });
    await frame.evaluate(() => {
        window.__moves = [];
        document.querySelector('canvas').addEventListener('mousemove', event => {
            if (!event.isTrusted) window.__moves.push({ x: event.movementX, y: event.movementY, target: event.target.tagName });
        }, true);
    });
}

async function desktop(browser, url, edition) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(observeInputs);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.locator(edition === 'js' ? '#btn-js' : '#btn-wasm').click();
        const game = await (await page.locator('#game-frame').elementHandle()).contentFrame();
        await ready(game);
        await game.evaluate(() => window.focus());
        await page.evaluate(() => { window.__connect(true); window.__pad.axes[1] = -1; window.__pad.axes[2] = 0.6; window.__pad.buttons[0].pressed = true; });
        await game.waitForFunction(() => window.__moves.length > 0 && window.__inputs.some(event => event.code === 'Space'));
        const input = await game.evaluate(() => ({ inputs: window.__inputs, moves: window.__moves }));
        for (const code of ['KeyW', 'Space']) assert.deepEqual(input.inputs.filter(event => event.code === code).map(event => event.type), ['keydown']);
        assert.ok(input.inputs.every(event => event.target === 'document'));
        assert.ok(input.moves.every(event => event.target === 'CANVAS' && event.x === 6 && event.y === 0));
        check(edition + ': sparse-slot controller delivers single bubbling keys and canvas look', { sampledMoves: input.moves.length });

        const blur = await page.evaluate(() => {
            document.getElementById('btn-js').focus();
            return document.getElementById('game-frame').contentWindow.__inputs.slice(-2);
        });
        assert.ok(blur.every(event => event.type === 'keyup'));
        assert.deepEqual(blur.map(event => event.code).sort(), ['KeyW', 'Space']);
        await game.evaluate(() => window.focus());
        await game.waitForFunction(() => window.__inputs.filter(event => event.code === 'Space' && event.type === 'keydown').length >= 2);
        check(edition + ': native iframe blur releases synchronously and refocus sends fresh downs');

        const background = await context.newPage();
        await background.goto('about:blank');
        await background.bringToFront();
        await page.waitForTimeout(150);
        const hidden = await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus() }));
        if (!hidden.focused) {
            const backgroundInput = await game.evaluate(() => window.__inputs.slice(-2));
            assert.ok(backgroundInput.every(event => event.type === 'keyup'));
        }
        await page.bringToFront();
        await game.evaluate(() => window.focus());
        await game.waitForFunction(() => window.__inputs.slice(-1)[0]?.type === 'keydown');
        if (!hidden.focused) check(edition + ': native background-tab blur releases and foreground recovers', hidden);
        else {
            results.checks.push({ name: edition + ': native background-tab blur', status: 'unavailable', reason: 'The headless browser kept document.hasFocus() true after bringing another tab forward.', ...hidden });
            console.log('UNAVAILABLE ' + edition + ': native background-tab focus transition');
        }
        await background.close();

        await page.evaluate(() => window.__connect(false));
        const disconnected = await game.evaluate(() => window.__inputs.slice(-2));
        assert.ok(disconnected.every(event => event.type === 'keyup'));
        await page.evaluate(() => window.__connect(true));
        await game.waitForFunction(() => window.__inputs.slice(-1)[0]?.type === 'keydown');
        check(edition + ': disconnect and reconnect release and re-press held input');

        await page.evaluate(() => { window.__pad.axes.fill(0); window.__pad.buttons.forEach(button => button.pressed = false); });
        await game.waitForFunction(() => window.__inputs.slice(-1)[0]?.type === 'keyup');
        await page.evaluate(() => new Promise(resolve => {
            const frame = document.getElementById('game-frame');
            window.__oldProxy = frame.contentWindow;
            frame.addEventListener('load', resolve, { once: true });
            frame.contentWindow.location.reload();
        }));
        await ready(game);
        assert.equal(await page.evaluate(() => window.__oldProxy === document.getElementById('game-frame').contentWindow), true);
        await game.evaluate(() => window.focus());
        await page.evaluate(() => { window.__pad.axes[1] = -1; window.__pad.buttons[0].pressed = true; });
        await game.waitForFunction(() => window.__inputs.some(event => event.code === 'Space' && event.type === 'keydown'));
        const reloadBlur = await page.evaluate(() => {
            document.getElementById('btn-js').focus();
            return document.getElementById('game-frame').contentWindow.__inputs.slice(-2);
        });
        assert.ok(reloadBlur.every(event => event.type === 'keyup'));
        check(edition + ': same-WindowProxy reload retains native blur cleanup');
        await game.evaluate(() => window.focus());
        await page.waitForFunction(() => document.fullscreenElement !== null);
        await page.evaluate(() => document.exitFullscreen());
        await page.waitForFunction(() => document.getElementById('game-frame').style.display === 'none');
        assert.equal(await page.evaluate(() => document.getElementById('game-frame').getAttribute('src')), '');
        await page.locator(edition === 'js' ? '#btn-js' : '#btn-wasm').click();
        const relaunched = await (await page.locator('#game-frame').elementHandle()).contentFrame();
        await ready(relaunched);
        await relaunched.evaluate(() => window.focus());
        await relaunched.waitForFunction(() => window.__inputs.some(event => event.code === 'Space' && event.type === 'keydown'));
        check(edition + ': native fullscreen exit returns to launcher and relaunch accepts input');
        await page.screenshot({ path: path.join(output, 'desktop-' + edition + '-relaunch.png') });
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
}

async function mobile(browser, url, edition, direct = false) {
    const mode = 'android-' + edition + (direct ? '-direct' : '-iframe');
    const context = await browser.newContext(devices['Pixel 7']);
    const page = await context.newPage();
    try {
        await page.goto(direct ? url + 'gamefile.html' : url, { waitUntil: 'domcontentloaded' });
        if (!direct) await page.locator(edition === 'js' ? '#btn-js' : '#btn-wasm').tap();
        const game = direct ? page.mainFrame() : await (await page.locator('#game-frame').elementHandle()).contentFrame();
        const launch = game.getByText(/Launch EaglercraftX/i);
        await launch.waitFor({ timeout: 60000 });
        await launch.evaluate(button => { window.__trustedLaunch = []; button.addEventListener('click', event => window.__trustedLaunch.push(event.isTrusted)); });
        await launch.tap();
        await launch.waitFor({ state: 'detached', timeout: 10000 });
        await game.locator('canvas').waitFor({ timeout: 60000 });
        await game.waitForFunction(() => document.querySelector('canvas')?.width > 0);
        await page.waitForTimeout(3000);
        assert.deepEqual(await game.evaluate(() => window.__trustedLaunch), [true]);
        await page.screenshot({ path: path.join(output, mode + '-profile.png'), scale: 'css' });
        check(mode + ': trusted launch tap dismisses prompt; canvas is present', { viewport: page.viewportSize() });
        await game.evaluate(() => {
            window.__trustedTouch = [];
            document.querySelector('canvas').addEventListener('touchstart', event => window.__trustedTouch.push(event.isTrusted), true);
        });
        await page.touchscreen.tap(206, 342);
        await page.waitForTimeout(800);
        const touches = await game.evaluate(() => window.__trustedTouch);
        assert.ok(touches.length > 0 && touches.every(Boolean));
        await page.screenshot({ path: path.join(output, mode + '-after-done-tap.png'), scale: 'css' });
        if (edition === 'wasm') {
            await page.mouse.click(206, 342);
            await page.waitForTimeout(800);
            await page.screenshot({ path: path.join(output, mode + '-after-mouse.png'), scale: 'css' });
            results.limitations.push('Visually compare WASM Done tap and identical-position mouse screenshots; canvas presence is not touch-menu acceptance.');
            results.checks.push({ name: mode + ': touch-menu acceptance', status: 'requires_visual_review', screenshots: [mode + '-after-done-tap.png', mode + '-after-mouse.png'] });
        }
    } finally { await context.close(); }
}

(async () => {
    const server = http.createServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            results.requests404.push(pathname); response.writeHead(404); response.end(); return;
        }
        const extension = path.extname(file);
        response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.png': 'image/png', '.json': 'application/json' }[extension] || 'application/octet-stream');
        fs.createReadStream(file).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    let browser;
    try {
        browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.NEXUS_BROWSER_EXECUTABLE ? { executablePath: process.env.NEXUS_BROWSER_EXECUTABLE } : {}) });
        results.browserVersion = browser.version();
        for (const [name, run] of [
            ['desktop-js', () => desktop(browser, url, 'js')],
            ['desktop-wasm', () => desktop(browser, url, 'wasm')],
            ['android-js-iframe', () => mobile(browser, url, 'js')],
            ['android-js-direct', () => mobile(browser, url, 'js', true)],
            ['android-wasm-iframe', () => mobile(browser, url, 'wasm')]
        ]) {
            try { await run(); }
            catch (error) { results.checks.push({ name, status: 'fail', error: error.message }); console.error('FAIL ' + name + ': ' + error.message); process.exitCode = 1; }
        }
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
        fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
        console.log('Evidence: ' + output);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
