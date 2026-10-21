// Optional browser checks: requires Playwright and a Chromium browser.
// This file is deliberately outside the default *.test.cjs Node suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, devices } = require(process.env.NEXUS_PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(process.env.NEXUS_BROWSER_ROOT || path.join(__dirname, '..'));
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
        await page.goto(direct ? url + (edition === 'wasm' ? 'gamefilebetter.html' : 'gamefile.html') : url, { waitUntil: 'domcontentloaded' });
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
            window.__menuMouse = [];
            for (const type of ['mousedown', 'mouseup', 'click']) window.addEventListener(type, event => {
                window.__menuMouse.push({ type, trusted: event.isTrusted, target: event.target.tagName });
            }, true);
        });
        const cdp = await context.newCDPSession(page);
        let contact = 0;
        async function screen(label, expected, footer = false) {
            await page.waitForTimeout(150);
            const filename = path.join(output, mode + '-' + label + '.png');
            await page.screenshot({ path: filename });
            const viewport = page.viewportSize();
            const crop = filename.replace(/\.png$/, footer ? '-footer.png' : '-heading.png');
            await page.screenshot({ path: crop, clip: { x: 0, y: footer ? viewport.height - 40 : 0, width: viewport.width, height: footer ? 40 : 110 } });
            const text = execFileSync(process.env.NEXUS_TESSERACT_EXECUTABLE || 'tesseract', [crop, 'stdout', '--psm', '11'], { encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
            fs.writeFileSync(crop + '.txt', text);
            const normalized = text.toLowerCase().replace(/[^a-z]/g, '');
            if (expected) assert.match(normalized, expected, label + ' must show the next rendered menu; OCR was: ' + text);
            return normalized;
        }
        async function tap(x, y) {
            await game.evaluate(() => { window.__menuMouse = []; });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: contact++ % 2, radiusX: 12, radiusY: 12, force: 1 }] });
            await page.waitForTimeout(160);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await page.waitForTimeout(350);
            const events = await game.evaluate(() => window.__menuMouse);
            assert.deepEqual(events.map(event => event.type), ['mousedown', 'mouseup', 'click'], 'one native mouse pair per trusted tap');
            assert.ok(events.every(event => event.trusted && event.target === 'CANVAS'), 'compatibility mouse events must come from the browser');
        }
        async function titleAfterProfile(label) {
            // Choose an explicit native profile name; never accept a generated
            // username warning as evidence that typing succeeded.
            await tap(337, 178);
            await page.waitForTimeout(100);
            await page.keyboard.press('End'); await page.waitForTimeout(50);
            for (let i = 0; i < 32; i++) await page.keyboard.press('Backspace');
            await page.keyboard.type('NexusQAUser', { delay: 20 }); await page.waitForTimeout(200);
            await tap(206, 342); // Profile Done.
            let heading = await screen(label + '-after-done');
            if (/defaultuserna[mn]edetected/.test(heading)) {
                assert.fail('Explicit profile entry must not fall back to the generated-username warning');
            }
            if (/(important|inportant)/.test(heading)) await tap(206, 465); // Existing first-load acknowledgement.
            await screen(label + '-title', /resourcescopyright/, true);
        }
        async function controls(label) {
            await tap(147, 371);
            await screen(label + '-options', /options/);
            await tap(298, 226);
            await screen(label + '-controls', /controls/);
        }
        const touchscreen = () => game.evaluate(() => /(?:^|\n)touchscreen:true(?:\n|$)/.test(atob(localStorage.getItem('_eaglercraft_1.12.g') || '')));
        await screen('initial-profile', /editprofile/);
        assert.equal(await touchscreen(), false);

        async function gestures(label) {
            // These gestures leave Profile open; the following fresh Done tap must work.
            for (const gesture of ['cancel', 'drag']) {
                await game.evaluate(() => { window.__menuMouse = []; });
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 206, y: 342, id: 11, radiusX: 12, radiusY: 12, force: 1 }] });
                await page.waitForTimeout(100);
                if (gesture === 'drag') await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 246, y: 342, id: 11, radiusX: 12, radiusY: 12, force: 1 }] });
                await cdp.send('Input.dispatchTouchEvent', { type: gesture === 'cancel' ? 'touchCancel' : 'touchEnd', touchPoints: [] });
                await page.waitForTimeout(350);
                assert.deepEqual(await game.evaluate(() => window.__menuMouse), [], gesture + ' must not activate a menu button');
                await screen(label + '-' + gesture + '-profile', /editprofile/);
            }
            const primary = { x: 10, y: 600, id: 0 };
            const secondary = { x: 50, y: 640, id: 1 };
            for (const staggered of [false, true]) {
                await game.evaluate(() => { window.__menuMouse = []; });
                if (staggered) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [primary] });
                    await page.waitForTimeout(80);
                }
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [primary, secondary] });
                await page.waitForTimeout(160);
                if (staggered) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [secondary] });
                    await page.waitForTimeout(80);
                }
                await cdp.send('Input.dispatchTouchEvent', { type: staggered ? 'touchCancel' : 'touchEnd', touchPoints: [] });
                await page.waitForTimeout(350);
                const multiple = await game.evaluate(() => window.__menuMouse);
                const count = type => multiple.filter(event => event.type === type).length;
                assert.equal(count('mousedown'), count('mouseup'));
                assert.ok(count('mousedown') <= 1 && count('click') <= 1, 'multitouch must not duplicate activation');
                assert.ok(multiple.every(event => event.trusted && event.target === 'CANVAS'));
                await screen(label + (staggered ? '-staggered' : '-simultaneous') + '-profile', /editprofile/);
            }
            check(mode + ': ' + label + ' cancel, drag and staggered/simultaneous multitouch preserve balanced input');
        }
        await gestures('mode-off');
        await titleAfterProfile('mode-off');
        await controls('mode-off');
        check(mode + ': trusted taps advance profile through title, Options and Controls with mode OFF');
        await tap(114, 60);
        assert.equal(await touchscreen(), true, 'one tap must turn Touchscreen Mode ON');
        await screen('touchscreen-on', /controls/);
        await tap(298, 818); // Controls Done.
        await screen('on-back-options', /options/);
        await tap(206, 342); // Options Done.
        await screen('on-back-title', /resourcescopyright/, true);
        await tap(263, 371); // Edit Profile.
        await screen('on-profile', /editprofile/);
        await gestures('mode-on');
        await titleAfterProfile('mode-on');
        await controls('mode-on');
        await tap(114, 60);
        assert.equal(await touchscreen(), false, 'restore Touchscreen Mode OFF with one tap');
        check(mode + ': repeated native taps work with mode ON and restore mode OFF');
        results.checks.push({ name: mode + ': rendered touch-menu acceptance', status: 'pass', method: 'trusted native mouse pairs plus OCR of rendered menu headings/footer', touchscreenModes: ['OFF', 'ON'], nativeTapCount: contact });
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
        response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }[extension] || 'application/octet-stream');
        fs.createReadStream(file).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    let browser;
    try {
        browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.NEXUS_BROWSER_EXECUTABLE ? { executablePath: process.env.NEXUS_BROWSER_EXECUTABLE } : {}) });
        results.browserVersion = browser.version();
        const scenarios = [
            ['desktop-js', () => desktop(browser, url, 'js')],
            ['desktop-wasm', () => desktop(browser, url, 'wasm')],
            ['android-js-iframe', () => mobile(browser, url, 'js')],
            ['android-js-direct', () => mobile(browser, url, 'js', true)],
            ['android-wasm-iframe', () => mobile(browser, url, 'wasm')],
            ['android-wasm-direct', () => mobile(browser, url, 'wasm', true)]
        ];
        const selected = process.env.NEXUS_BROWSER_SCENARIOS?.split(',');
        if (selected) assert.ok(selected.every(name => scenarios.some(([known]) => known === name)), 'unknown selected browser scenario');
        results.selectedScenarios = selected || scenarios.map(([name]) => name);
        for (const [name, run] of scenarios.filter(([name]) => !selected || selected.includes(name))) {
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
