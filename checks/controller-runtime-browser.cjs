// Actual bundled mouse handlers in Chromium; simulated pad, no physical controller.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'gamefile.html'), 'utf8');
const wasm = fs.readFileSync(path.join(root, 'gamefilebetter.html'), 'utf8');
const payload = Buffer.from(wasm.match(/data:application\/octet-stream;base64,(RUFHJFdBU0[A-Za-z0-9+/=]*)/)[1], 'base64');
const runtimeTests = fs.readFileSync(path.join(root, 'tests/runtime.test.cjs'), 'utf8');
const decoder = runtimeTests.slice(runtimeTests.indexOf('async function decodeEPW('), runtimeTests.indexOf('const nativeDecode ='));
const ctx = vm.createContext({ Buffer, Uint8Array, WebAssembly, Math });
vm.runInContext(decoder, ctx);
const controller = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(s => s.trim())[1];

(async () => {
    const decoded = await ctx.decodeEPW(payload);
    assert.equal(decoded.failure, null);
    const glue = decoded.decoded.map(bytes => Buffer.from(bytes).toString()).find(s => s.startsWith('(function(){'));
    assert.ok(glue);
    const jsHandler = js.match(/function FWm\([\s\S]*?(?=\nvar FmU=)/)[0];
    const wasmRegistration = glue.match(/R\.addEventListener\("mousemove",mb=function\(m\)\{[\s\S]*?\}\);/)[0];
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
        for (const edition of ['JS', 'WASM']) {
            const page = await browser.newPage();
            await page.setContent('<iframe id="game-frame" style="display:block" srcdoc="<canvas></canvas>"></iframe>');
            const result = await page.evaluate(async ({ controller, jsHandler, wasmRegistration, edition }) => {
                const frame = document.querySelector('iframe');
                if (!frame.contentDocument.querySelector('canvas')) await new Promise(resolve => frame.onload = resolve);
                const win = frame.contentWindow;
                const canvas = win.document.querySelector('canvas');
                const received = [];
                if (edition === 'JS') {
                    // Execute the actual camera accumulator, with pointer lock enabled.
                    win.eval('var FZ=()=>false,HJe=true,HIE=0,HBp=1,HFn=100,HIR=0,HIS=0,HIK=0,HIL=0; var AMR=e=>e.offsetX,AI7=e=>e.offsetY;' + jsHandler);
                    canvas.addEventListener('mousemove', event => { win.FWm(null, event); received.push([win.HIK, win.HIL]); });
                } else {
                    // Execute the actual canvas registration and runtime event payload.
                    win.R = canvas;
                    win.U = (a, b, event) => received.push([event.movementX, -event.movementY]);
                    win.eval(wasmRegistration);
                }
                const pad = { index: 0, id: 'Simulated', connected: true, axes: [0, -1, 1, -0.5], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
                let poll;
                let focused = true;
                Object.defineProperty(navigator, 'getGamepads', { value: () => [pad] });
                Object.defineProperty(document, 'hasFocus', { value: () => focused });
                window.requestAnimationFrame = callback => (poll = callback, 1);
                window.cancelAnimationFrame = () => {};
                eval(controller);
                const connected = new Event('gamepadconnected'); connected.gamepad = pad;
                window.dispatchEvent(connected);
                poll();
                const first = received.length;
                focused = false;
                win.dispatchEvent(new Event('blur'));
                poll();
                const iframeBlur = received.length;
                focused = true; poll();
                const recovered = received.length;
                focused = false; window.dispatchEvent(new Event('blur')); poll();
                const rootBlur = received.length;
                focused = true; poll();
                const rootRecovered = received.length;
                // Missing canvas during startup/navigation must be harmless.
                canvas.remove(); poll();
                return { first, iframeBlur, recovered, rootBlur, rootRecovered, received };
            }, { controller, jsHandler, wasmRegistration, edition });
            assert.deepEqual([result.first, result.iframeBlur, result.recovered, result.rootBlur, result.rootRecovered], [1, 1, 2, 2, 3]);
            assert.deepEqual(result.received[0], [10, 5]);
            if (edition === 'JS') assert.deepEqual(result.received[2], [30, 15]);
            console.log(edition, JSON.stringify(result));
            await page.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
