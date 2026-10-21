// Focused native profile acceptance. Uses only temporary browser storage,
// trusted GUI input and read-only inspection of the native gzip/NBT profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium, devices } = require(process.env.NEXUS_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.NEXUS_SHARP_MODULE || 'sharp');
const root = path.resolve(process.env.NEXUS_BROWSER_ROOT || path.join(__dirname, '..'));
const output = process.env.NEXUS_PROFILE_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profile-evidence-'));
fs.mkdirSync(output, { recursive: true });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const results = { checks: [], errors: [], scenarios: [], nativeEvents: [], nodeVersion: process.version,
    limitations: ['Desktop Chrome and Android-emulated trusted native input; no physical Android keyboard/device acceptance.', 'Only disposable test profiles are read; no profile or world storage is injected.'] };
let context, page, game, current, mobile, number = 0, base;
const profiles = [];
const persist = () => fs.writeFileSync(path.join(output, 'profile-results.json'), JSON.stringify(results, null, 2));
const pass = (name, details = {}) => { results.checks.push({ scenario: current, name, status: 'pass', ...details }); console.log('PASS ' + current + ': ' + name); };
const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, base).pathname); } catch { response.writeHead(400).end(); return; }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(response);
});
server.on('connection', socket => socket.on('error', () => socket.destroy()));

async function browser(profile) {
    context = await chromium.launchPersistentContext(profile, {
        executablePath: process.env.NEXUS_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, chromiumSandbox: true,
        ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1280, height: 900 } })
    });
    page = context.pages()[0] || await context.newPage(); await page.bringToFront();
    page.on('pageerror', error => results.errors.push({ scenario: current, name: error.name, message: error.message, stack: error.stack }));
    await page.exposeBinding('profileAcceptanceEvent', (_source, event) => results.nativeEvents.push({ scenario: current, ...event }));
    await page.addInitScript(() => {
        for (const type of ['keydown', 'keyup', 'mousedown', 'click']) window.addEventListener(type, event => window.profileAcceptanceEvent({ type, url: location.href, trusted: event.isTrusted, code: event.code, key: event.key, focus: document.hasFocus(), target: event.target?.tagName }), true);
    });
    results.browserVersion ||= context.browser().version();
}
async function ocr(label, clip) {
    const stem = current + '-' + String(++number).padStart(3, '0') + '-' + label;
    const file = path.join(output, stem + '.png'), prepared = path.join(output, stem + '-ocr.png');
    await page.screenshot({ path: file, scale: clip ? 'css' : 'device', ...(clip ? { clip } : {}) });
    const ratio = clip ? 1 : (await sharp(file).metadata()).width / page.viewportSize().width;
    await sharp(file).grayscale().threshold(180).negate().toFile(prepared);
    const words = [];
    for (const [source, suffix] of [[file, ''], [prepared, '-prepared']]) {
        const tsv = execFileSync(process.env.NEXUS_TESSERACT_EXECUTABLE || 'tesseract', [source, 'stdout', '--psm', clip ? '7' : '11', 'tsv'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        fs.writeFileSync(path.join(output, stem + suffix + '.tsv'), tsv);
        words.push(...tsv.trim().split('\n').slice(1).map(line => line.split('\t')).filter(row => row.length >= 12 && Number(row[10]) >= 0).map(row => ({ text: row.slice(11).join('\t'), x: (Number(row[6]) + Number(row[8]) / 2) / ratio, y: (Number(row[7]) + Number(row[9]) / 2) / ratio })));
    }
    const result = { text: words.map(word => word.text).join(' '), words, screenshot: path.basename(file) };
    fs.writeFileSync(path.join(output, stem + '.json'), JSON.stringify(result, null, 2)); return result;
}
async function screen(label, pattern, timeout = 30000) {
    const deadline = Date.now() + timeout; let result;
    while (Date.now() < deadline) {
        result = await ocr(label);
        assert.doesNotMatch(normalize(result.text), /crashreport|runtimeexception|defaultusernamedetected/, 'No native crash or generated-username fallback is accepted');
        if (pattern.test(normalize(result.text))) return result;
        await page.waitForTimeout(1000);
    }
    assert.fail(label + ' rendered menu missing: ' + result?.text);
}
const coords = () => mobile ? { name: [337, 178], done: [206, 342], field: { x: 188, y: 170, width: 150, height: 18 } } : { name: [970, 252], done: [640, 683], field: { x: 590, y: 239, width: 390, height: 32 } };
async function click(x, y) { if (mobile) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); await page.waitForTimeout(150); }
async function edit(value) {
    await click(...coords().name); await page.keyboard.press('End'); await page.waitForTimeout(50);
    for (let i = 0; i < 32; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(100); await page.keyboard.type(value, { delay: 30 }); await page.waitForTimeout(200);
}
async function launch(edition) {
    await page.goto(base, { waitUntil: 'load' }); await page.bringToFront();
    const button = page.locator(edition === 'js' ? '#btn-js' : '#btn-wasm');
    if (mobile) await button.tap(); else await button.click();
    game = await (await page.locator('#game-frame').elementHandle()).contentFrame();
    if (mobile) {
        const launchButton = game.getByText(/Launch EaglercraftX/i);
        await launchButton.waitFor({ timeout: 60000 }); await launchButton.tap();
    }
    await screen('startup-edit-profile', /e[du]itprofile/, 120000);
    assert.equal(await game.evaluate(() => document.hasFocus()), true, 'Native profile must own keyboard focus');
}
const inspectCode = `import sys,importlib.util,base64,json\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('world_inspector',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ndef convert(v):\n if isinstance(v,bytes): return {'base64':base64.b64encode(v).decode()}\n if isinstance(v,dict): return {k:convert(x) for k,x in v.items()}\n if isinstance(v,list): return [convert(x) for x in v]\n return v\nprint(json.dumps(convert(m.read_nbt(base64.b64decode(sys.stdin.read(),validate=True))),sort_keys=True))`;
async function profile(label) {
    const raw = await game.evaluate(() => localStorage.getItem('_eaglercraft_1.12.p'));
    const semantic = raw === null ? null : JSON.parse(execFileSync(process.env.NEXUS_PYTHON_EXECUTABLE || 'python3', ['-c', inspectCode, path.join(root, 'scripts/inspect-world-export.py')], { input: raw, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
    const appearance = semantic === null ? null : Object.fromEntries(Object.entries(semantic).filter(([key]) => key !== 'username'));
    const snapshot = { raw, rawSha256: raw === null ? null : hash(raw), semantic, appearanceSha256: appearance === null ? null : hash(JSON.stringify(appearance)) };
    fs.writeFileSync(path.join(output, current + '-' + label + '-profile.json'), JSON.stringify(snapshot, null, 2)); return snapshot;
}
async function fieldPixels(label) {
    const field = await ocr(label, coords().field);
    // OCR invents words on a uniformly black crop. Inspect its actual rendered
    // pixels instead: the only permitted bright shape is a short native caret.
    const { data, info } = await sharp(path.join(output, field.screenshot)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let count = 0, minX = info.width, minY = info.height, maxX = -1, maxY = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        const offset = (y * info.width + x) * info.channels;
        if (Math.max(...data.subarray(offset, offset + info.channels)) > 180) { count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    }
    return { count, width: maxX - minX + 1, height: maxY - minY + 1, screenshot: field.screenshot };
}
async function blankField(label) {
    const pixels = await fieldPixels(label);
    assert.ok(pixels.count === 0 || pixels.count <= 144 && pixels.height <= 6 && pixels.width <= 24, 'Fresh rendered username field must be blank, allowing only the native caret');
}
async function blocked(label, before, value) {
    await edit(value); await click(...coords().done); await screen(label + '-done-blocked', /e[du]itprofile/);
    await page.keyboard.press('Enter'); await page.waitForTimeout(200); await screen(label + '-enter-blocked', /e[du]itprofile/);
    assert.deepEqual(await profile(label), before, 'Invalid input must not save a generated, padded or replacement username');
}
async function finish(label, allowLegacyWarning = false, requireLegacyWarning = false) {
    await click(...coords().done);
    const deadline = Date.now() + 30000; let last, legacyWarnings = 0;
    while (Date.now() < deadline) {
        last = await ocr(label);
        const text = normalize(last.text);
        if (/defaultuserna[mn]edetected/.test(text)) {
            assert.equal(allowLegacyWarning, true, 'Ordinary explicit names must not trigger a generated-name warning');
            assert.equal(++legacyWarnings, 1, 'A deliberate legacy-looking name may acknowledge its warning only once');
            const button = last.words.find(word => /^continue$/i.test(word.text));
            assert.ok(button, 'Native legacy-name warning must offer Continue'); await click(button.x, button.y);
            continue;
        }
        if (/singleplayer|resourcescopyright/.test(text)) {
            if (requireLegacyWarning) assert.equal(legacyWarnings, 1, 'Deliberately typed old-generator name must preserve the native warning');
            return;
        }
        if (/important|inportant/.test(text)) {
            const button = last.words.find(word => /^(understand|continue)$/i.test(word.text));
            assert.ok(button, 'Existing warning acknowledgement must be visible'); await click(button.x, button.y);
        }
        await page.waitForTimeout(300);
    }
    assert.fail('Native title missing after explicit name: ' + last?.text);
}
async function cosmetics(label, character) {
    // Built-in preset menus only. No custom files or injected profile state.
    await click(970, 430);
    const list = await ocr(label + '-skin-options');
    const option = list.words.find(word => (character === 'Alex' ? /^a(?:lex|lles|les)$/i : /^steve$/i).test(word.text) && word.y > 450);
    assert.ok(option, 'A rendered built-in ' + character + ' skin must be visible'); await click(option.x, option.y);
    const edit = await screen(label + '-skin-selected', /e[du]itprofile/);
    const capes = edit.words.find(word => /^capes$/i.test(word.text));
    assert.ok(capes, 'Selected built-in skin must expose the native Capes control'); await click(capes.x, capes.y);
    await screen(label + '-cape-editor', /editcape/); await click(640, 683);
    await screen(label + '-cape-return', /e[du]itprofile/);
}
async function scenario(edition, android) {
    mobile = android; current = (mobile ? 'android-' : 'desktop-') + edition;
    const other = edition === 'js' ? 'wasm' : 'js', legacy = !mobile && edition === 'js';
    const chosen = legacy ? 'YeeYee1234' : !mobile ? 'A_3' : edition === 'wasm' ? 'Touch_WASM_QA_16' : 'Touch_JS_QA';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profile-' + current + '-')); profiles.push(directory);
    const record = { scenario: current, edition, oppositeEdition: other, chosen, startedAt: new Date().toISOString() }; results.scenarios.push(record);
    await browser(directory); await launch(edition); await blankField('fresh-blank-field');
    const fresh = await profile('fresh'); assert.ok(fresh.semantic === null || fresh.semantic.username === '', 'Fresh profile must not contain any username');
    await blocked('blank', fresh, ''); await blocked('short', fresh, 'Ab'); await blocked('invalid-only', fresh, '!!!'); await ocr('invalid-only-visible-unsubmittable', coords().field);
    pass('blank, short and invalid-only names cannot advance or persist replacement names', { feedback: 'Native Done stays disabled; Done/Enter remain on Edit Profile' });
    if (!mobile) {
        await cosmetics('invalid-name', 'Steve');
        const afterMenu = await profile('invalid-name-menu-return');
        assert.ok(afterMenu.semantic === null || afterMenu.semantic.username === '', 'Native cosmetic transitions must not generate a username');
        await click(...coords().done); await screen('invalid-menu-done-blocked', /e[du]itprofile/);
        pass('native skin selection and Cape editor return without generating a valid fallback name');
    }
    await edit(chosen); await finish('chosen-name-title', legacy, legacy);
    let saved = await profile('chosen-name'); assert.equal(saved.semantic?.username, chosen);
    pass(legacy ? 'deliberately typed legacy-looking name preserves native warning and saves exactly' : 'trusted explicit name including underscore reaches native title and saves exactly', { username: chosen, rawSha256: saved.rawSha256, appearanceSha256: saved.appearanceSha256 });
    await context.close(); context = null; await browser(directory); await launch(edition);
    const cold = await profile('cold-restart'); assert.deepEqual(cold, saved, 'Cold restart must retain the entire native profile including skin/cape data');
    const prefilled = await fieldPixels('cold-prefilled-name');
    assert.ok(prefilled.height > 6 && prefilled.count > 144, 'Saved name must be visibly present beyond a native caret; exact username is independently asserted from NBT');
    record.prefilledNameScreenshot = prefilled.screenshot;
    pass('cold browser restart always shows Profile with exact saved name and unchanged profile bytes');
    if (!mobile) {
        await cosmetics('saved-name', 'Alex'); await finish('cosmetic-change-title', legacy);
        const changed = await profile('cosmetic-change'); assert.equal(changed.semantic.username, chosen);
        assert.notEqual(changed.semantic.presetSkin, saved.semantic.presetSkin, 'Choosing an Alex preset after Steve must change the saved skin');
        assert.equal(changed.semantic.presetCape, saved.semantic.presetCape, 'Visiting the Cape editor without a selection must preserve the cape');
        saved = changed; await context.close(); context = null; await browser(directory); await launch(edition);
        assert.deepEqual(await profile('cosmetic-cold-restart'), saved, 'The deliberately changed appearance and chosen name must survive a full browser restart');
        pass('native skin change persists through Cape editor and cold restart with chosen name intact', { presetSkin: saved.semantic.presetSkin, presetCape: saved.semantic.presetCape });
    }
    await launch(other); const cross = await profile('cross-edition'); assert.deepEqual(cross, saved, 'Other edition must preserve the same complete native profile');
    await finish('cross-edition-title', legacy); const after = await profile('cross-edition-done'); assert.deepEqual(after.semantic, saved.semantic, 'Confirming saved name must preserve all profile fields');
    pass('opposite edition starts at Profile and retains exact name, skins and capes', { appearanceSha256: cross.appearanceSha256 });
    const nativeKeys = results.nativeEvents.filter(event => event.scenario === current && event.type === 'keydown' && event.trusted && event.focus && /gamefile(?:better)?\.html$/.test(event.url));
    assert.ok(nativeKeys.some(event => event.code === 'Enter') && nativeKeys.some(event => event.code === 'Backspace'), 'Assertions must exercise trusted focused native editing');
    record.status = 'pass'; record.finishedAt = new Date().toISOString(); persist(); await context.close(); context = null;
}
(async () => {
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port + '/';
        results.base = base; results.sourceHashes = Object.fromEntries(['gamefile.html', 'gamefilebetter.html', 'index.html', 'assets/world-backups-ui.js', 'tests/profile.integration.cjs'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
        const selected = process.env.NEXUS_PROFILE_SCENARIOS?.split(',');
        const scenarios = ['desktop-js', 'desktop-wasm', 'android-js', 'android-wasm'];
        if (selected) assert.ok(selected.every(value => scenarios.includes(value)), 'Unknown profile scenario');
        for (const mode of scenarios.filter(value => !selected || selected.includes(value))) await scenario(mode.endsWith('-wasm') ? 'wasm' : 'js', mode.startsWith('android-'));
    } catch (error) {
        results.errors.push({ scenario: current, message: error.message, stack: error.stack }); results.checks.push({ scenario: current, name: 'native profile acceptance', status: 'fail', reason: error.message });
        if (page && !page.isClosed()) await ocr('failure').catch(() => {}); console.error(error); process.exitCode = 1;
    } finally {
        if (context) await context.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
        for (const directory of profiles) fs.rmSync(directory, { recursive: true, force: true });
        results.cleanup = { profilesRemoved: profiles.every(directory => !fs.existsSync(directory)), serverClosed: !server.listening }; persist(); console.log('Profile evidence: ' + output);
    }
})();
