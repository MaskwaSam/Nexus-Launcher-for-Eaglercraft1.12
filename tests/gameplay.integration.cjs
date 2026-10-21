// Optional native-browser gameplay acceptance, excluded from *.test.cjs.
// Requires Playwright, Chrome, Sharp, Tesseract and Python 3. No engine instrumentation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.NEXUS_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.NEXUS_SHARP_MODULE || require.resolve('sharp', { paths: [path.dirname(require.resolve(process.env.NEXUS_PLAYWRIGHT_MODULE || 'playwright'))] }));

const root = path.resolve(process.env.NEXUS_BROWSER_ROOT || path.join(__dirname, '..'));
const output = process.env.NEXUS_GAMEPLAY_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-gameplay-evidence-'));
fs.mkdirSync(output, { recursive: true });
const selected = (process.env.NEXUS_GAMEPLAY_SCENARIOS || process.env.NEXUS_GAMEPLAY_SCENARIO || 'js,wasm').split(',').map(value => value.trim()).filter(Boolean);
assert.ok(selected.length && selected.every(value => ['js', 'wasm'].includes(value)), 'Scenarios must be js, wasm or js,wasm');
const scenarios = [...new Set(selected)];
const evidence = { nodeVersion: process.version, pythonVersion: execFileSync(process.env.NEXUS_PYTHON_EXECUTABLE || 'python3', ['--version'], { encoding: 'utf8' }).trim(), checks: [], scenarios: [], network: [], errors: [], limitations: [
    'Native desktop Chrome with trusted Playwright keyboard/mouse input and temporary isolated profiles; no physical controller, phone or classroom-device acceptance.',
    'Native Eaglercraft EPK backups only; Java/Mineways conversion is unverified.',
    'Saved-state assertions come from the independent Python archive/NBT inspector, never injected engine state.'
] };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/manifest+json', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
let context, page, base, offline = false, currentScenario, activeEdition, imageNumber = 0;
const profiles = [];
const expectedManifests = new Map();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pass = (name, detail = {}) => { evidence.checks.push({ scenario: currentScenario, ...detail, name, status: 'pass' }); console.log('PASS ' + currentScenario + ': ' + name); };
const persist = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { if (!server.listening) return resolve(); server.close(resolve); server.closeAllConnections?.(); });

const backend = http.createServer((req, res) => {
    evidence.network.push({ surface: 'backend', url: req.url, offline });
    if (offline) { res.writeHead(503).end('Offline backend guard'); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, base).pathname); } catch { res.writeHead(400).end(); return; }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.stat(file, (error, stat) => {
        if (error || !stat.isFile()) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    });
});
const proxy = http.createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    const allowed = !offline && target.origin === new URL(base).origin;
    const record = { surface: 'proxy', method: req.method, url: target.href, offline, action: allowed ? 'forwarded' : 'blocked' };
    evidence.network.push(record);
    if (!allowed) { res.writeHead(502).end('Test proxy blocks network'); return; }
    const upstream = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, response => {
        record.status = response.statusCode; res.writeHead(response.statusCode, response.headers); response.pipe(res);
        response.on('error', error => { record.error = error.message; res.destroy(); });
    });
    upstream.on('error', error => { record.error = error.message; if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
});
proxy.on('connect', (req, socket) => {
    evidence.network.push({ surface: 'proxy', method: 'CONNECT', url: req.url, offline, action: 'blocked' });
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
});
for (const server of [backend, proxy]) {
    server.on('connection', socket => socket.on('error', () => socket.destroy()));
    server.on('clientError', (_error, socket) => socket.destroy());
}

async function browser(profile) {
    context = await chromium.launchPersistentContext(profile, {
        executablePath: process.env.NEXUS_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, chromiumSandbox: true, acceptDownloads: true,
        viewport: { width: 1280, height: 900 },
        proxy: { server: 'http://127.0.0.1:' + proxy.address().port, bypass: '<-loopback>' },
        args: ['--proxy-bypass-list=<-loopback>']
    });
    page = context.pages()[0] || await context.newPage();
    // A persistent Chrome startup tab can report hasFocus() while its native
    // root is inactive for pointer lock. Activate the actual tab normally.
    await page.bringToFront();
    page.on('pageerror', error => evidence.errors.push({ scenario: currentScenario, pageerror: error.message, name: error.name, stack: error.stack }));
    page.on('framenavigated', frame => { evidence.navigation ||= []; evidence.navigation.push({ scenario: currentScenario, at: new Date().toISOString(), main: frame === page.mainFrame(), url: frame.url() }); });
    await page.exposeBinding('nexusAcceptanceFullscreenEvent', (_source, detail) => { evidence.fullscreen ||= []; evidence.fullscreen.push({ scenario: currentScenario, at: new Date().toISOString(), ...detail }); });
    await page.exposeBinding('nexusAcceptanceNativeEvent', (_source, detail) => { evidence.nativeEvents ||= []; if (evidence.nativeEvents.length < 10000) evidence.nativeEvents.push({ scenario: currentScenario, at: new Date().toISOString(), ...detail }); });
    await page.addInitScript(() => {
        for (const type of ['mousedown', 'click', 'mousemove', 'keydown', 'keyup', 'pointerlockchange', 'pointerlockerror', 'unhandledrejection']) window.addEventListener(type, event => window.nexusAcceptanceNativeEvent({ type, url: location.href, target: event.target?.tagName, trusted: event.isTrusted, key: event.key, code: event.code, keyCode: event.keyCode, activeTag: document.activeElement?.tagName, movementX: event.movementX, movementY: event.movementY, clientX: event.clientX, clientY: event.clientY, path: event.composedPath().map(node => node.tagName || node.constructor.name).slice(0, 8), name: event.reason?.name, message: event.reason?.message, stack: event.reason?.stack, focus: document.hasFocus(), visibility: document.visibilityState, lock: document.pointerLockElement?.tagName }), true);
        document.addEventListener('fullscreenchange', () => window.nexusAcceptanceFullscreenEvent({ url: location.href, fullscreenTag: document.fullscreenElement?.tagName || null }));
    });
    const cdp = await context.newCDPSession(page);
    evidence.browserVersion ||= await cdp.send('Browser.getVersion');
    await cdp.detach();
}
async function launcher() {
    await page.goto(base, { waitUntil: 'load', timeout: 120000 });
    await page.locator('#btn-js').waitFor();
    await page.evaluate(async () => {
        await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker did not become ready')), 120000))
        ]);
    });
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload({ waitUntil: 'load' });
    assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
}
const normalized = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');
async function ocr(label) {
    const stem = currentScenario + '-' + String(++imageNumber).padStart(3, '0') + '-' + label.replace(/[^a-z0-9-]/gi, '-');
    const screenshot = path.join(output, stem + '.png'), prepared = path.join(output, stem + '-ocr.png');
    await page.screenshot({ path: screenshot });
    await sharp(screenshot).grayscale().threshold(180).negate().toFile(prepared);
    const words = [];
    for (const [source, suffix] of [[screenshot, ''], [prepared, '-prepared']]) {
        const tsv = execFileSync(process.env.NEXUS_TESSERACT_EXECUTABLE || 'tesseract', [source, 'stdout', '--psm', '11', 'tsv'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        fs.writeFileSync(path.join(output, stem + suffix + '.tsv'), tsv);
        words.push(...tsv.trim().split('\n').slice(1).map(line => line.split('\t')).filter(row => row.length >= 12 && Number(row[10]) >= 0).map(row => ({ text: row.slice(11).join('\t'), x: Number(row[6]) + Number(row[8]) / 2, y: Number(row[7]) + Number(row[9]) / 2 })));
    }
    const result = { words, text: words.map(word => word.text).join(' '), screenshot: path.basename(screenshot) };
    fs.writeFileSync(path.join(output, stem + '.json'), JSON.stringify(result, null, 2));
    return result;
}
async function waitOCR(label, pattern, timeout = 30000, tick) {
    const deadline = Date.now() + timeout; let screen, attempts = 0;
    while (Date.now() < deadline) {
        screen = await ocr(label);
        if (/crashreport|runtimeexception|accesseditemsbeforebootstrap/.test(normalized(screen.text))) throw new Error(label + ' native engine crash: ' + screen.text);
        if (pattern.test(normalized(screen.text))) return screen;
        if (tick) await tick(screen, attempts++);
        await page.waitForTimeout(2000);
    }
    throw new Error(label + ' OCR timed out: ' + screen?.text);
}
async function clickWord(pattern, label, screen) {
    screen ||= await ocr(label);
    const word = screen.words.find(value => pattern.test(value.text));
    assert.ok(word, label + ' OCR target missing: ' + screen.text);
    await page.mouse.click(word.x, word.y); await page.waitForTimeout(350);
}
async function clearType(x, y, text, count = 32) {
    assert.match(text, /^[\x20-\x7e]{1,32}$/);
    await page.mouse.click(x, y);
    // Native canvas mouse and keyboard queues drain separately. Let the click
    // establish its caret before sending navigation or editing keys.
    await page.waitForTimeout(100); await page.keyboard.press('End'); await page.waitForTimeout(50);
    // Ctrl+A and Meta+A insert "A" in this runtime. Use ordinary native editing.
    for (let i = 0; i < count; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    await page.keyboard.type(text, { delay: 20 });
    // The native canvas text field commits on its next game tick.
    await page.waitForTimeout(200);
}
async function title(timeout = 120000) {
    return waitOCR('title', /singleplayer/, timeout, async screen => {
        if (/editprofile/.test(normalized(screen.text))) {
            await clearType(750, 252, 'NexusQAUser', 16); await page.mouse.click(640, 683);
        } else if (/defaultuserna[mn]e/.test(normalized(screen.text))) await clickWord(/^continue$/i, 'default-name-continue', screen);
        else if (/important|inportant/.test(normalized(screen.text))) await clickWord(/^(understand|continue)$/i, 'warning-understand', screen);
    });
}
async function launchEdition(edition) {
    activeEdition = edition;
    await page.bringToFront();
    await page.locator(edition === 'js' ? '#btn-js' : '#btn-wasm').click();
    const frame = await (await page.locator('#game-frame').elementHandle()).contentFrame();
    assert.ok(frame, 'Native game iframe must exist');
    await waitOCR('runtime-startup', /editprofile|singleplayer|important/, 120000, async () => {
        const prompt = frame.getByText(/Launch EaglercraftX/i);
        if (await prompt.isVisible().catch(() => false)) await prompt.click();
    });
    await title();
    assert.equal(await frame.evaluate(() => document.hasFocus()), true, 'Native runtime must own keyboard focus at its title');
    pass(edition + ' runtime reaches OCR-confirmed native title');
}
async function selectWorldScreen() {
    await clickWord(/^singleplayer$/i, 'singleplayer');
    return waitOCR('select-world', /selectworld/, 120000);
}
async function createWorld(name, seed) {
    await selectWorldScreen();
    await page.mouse.click(880, 774);
    await waitOCR('world-action-chooser', /create|loadepkfile/);
    await page.mouse.click(640, 374);
    await waitOCR('create-world', /worldname|worldhare|moreworldoptions/);
    await clearType(620, 209, name);
    await page.mouse.click(640, 375); await page.waitForTimeout(200); await page.mouse.click(640, 375);
    await waitOCR('creative-mode', /creative/);
    await page.mouse.click(640, 591);
    await waitOCR('world-options', /seedfortheworldgenerator|seed/);
    await clearType(620, 210, seed);
    await page.mouse.click(420, 330); await page.mouse.click(910, 330);
    const options = await waitOCR('superflat-options', /super[ft]lat/);
    assert.match(normalized(options.text), /structuresoff|generateoff/);
    await page.mouse.click(640, 591); await waitOCR('creative-options-confirmed', /creative/); await page.mouse.click(400, 845);
    await gameplay();
    pass('created native Creative Superflat world', { worldName: name, seed });
}
async function gameplay() {
    // Both observed native overlays establish in-world rendering. WASM can show
    // FPS/XYZ without Biome; do not confuse that visible world with a menu.
    const screen = await waitOCR('native-world-ready', /biome|fps.*x.*y.*z/, 120000, async (_screen, attempt) => {
        if (attempt % 6 === 0) await page.keyboard.press('F3');
    });
    evidence.worldReady ||= [];
    evidence.worldReady.push({ scenario: currentScenario, edition: activeEdition, overlay: /biome/.test(normalized(screen.text)) ? 'biome' : 'fps-xyz', screenshot: screen.screenshot });
}
async function command(text) {
    await page.keyboard.press('Slash'); await page.waitForTimeout(50);
    await page.keyboard.type(text, { delay: 5 }); await page.waitForTimeout(100); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
}
async function exerciseGameplay() {
    for (const text of ['time set day', 'gamerule doDaylightCycle false', 'replaceitem entity @s slot.hotbar.0 minecraft:gold_block 16', 'give @s minecraft:emerald 7']) await command(text);
    await page.keyboard.press('KeyE');
    await waitOCR('inventory-open', /inventory|searchitems|buildingblocks|crafting/, 30000);
    await page.keyboard.press('KeyE');
    const frame = await (await page.locator('#game-frame').elementHandle()).contentFrame();
    const locked = () => frame.evaluate(() => Boolean(document.pointerLockElement));
    if (!await locked()) {
        await page.mouse.click(640, 450); await page.waitForTimeout(150);
    }
    evidence.pointerLockState ||= [];
    evidence.pointerLockState.push({ scenario: currentScenario, frames: await Promise.all(page.frames().map(frame => frame.evaluate(() => ({ url: location.href, focus: document.hasFocus(), visibility: document.visibilityState, pointerLock: document.pointerLockElement?.tagName, fullscreen: document.fullscreenElement?.tagName, canvases: [...document.querySelectorAll('canvas')].map(canvas => ({ connected: canvas.isConnected, ownerIsDocument: canvas.ownerDocument === document, defaultViewIsWindow: canvas.ownerDocument.defaultView === window, rootIsDocument: canvas.getRootNode() === document })) })))) });
    assert.equal(await locked(), true, 'Gameplay mouse input must acquire native pointer lock');
    // A focus click can also attack. Establish the fixture only after that click,
    // including its supporting grass, then use exactly one break and one place.
    await command('tp @s 0.5 4 0.5 0 45');
    // setblock rejects unloaded origin chunks while the seeded spawn is far
    // away. Wait for the real client ray target after teleport before fixtures.
    await waitOCR('teleported-chunks-loaded', /lookingat|fps.*x.*y.*z/, 30000);
    await page.waitForTimeout(2000);
    for (const text of ['setblock 0 3 2 minecraft:grass', 'setblock 0 4 2 minecraft:stone', 'setblock 3 4 3 minecraft:diamond_block']) await command(text);
    await page.keyboard.press('Digit1');
    assert.equal(await locked(), true, 'Closing native chat must restore pointer lock before block actions');
    await ocr('trusted-chat-setup');
    // click(x,y) would first move the pointer and rotate the locked camera.
    // Button-only trusted input keeps the established crosshair on the fixture.
    await page.mouse.down({ button: 'left' }); await page.waitForTimeout(75); await page.mouse.up({ button: 'left' }); await page.waitForTimeout(250);
    await page.mouse.down({ button: 'right' }); await page.waitForTimeout(75); await page.mouse.up({ button: 'right' }); await page.waitForTimeout(250);
    await waitOCR('native-break-and-place', /g[oa]ldblo[ac]*k/, 30000);
    await page.keyboard.down('KeyW'); await page.waitForTimeout(350); await page.keyboard.up('KeyW');
    // Pointer-locked native mouse events exercise the actual camera path.
    assert.equal(await locked(), true, 'Native camera movement must retain pointer lock');
    // Space real mouse events across game ticks, rather than collapsing a burst
    // into one poll. No synthetic movement fields or engine state are supplied.
    for (const [x, y] of [[700, 465], [760, 480], [820, 495]]) { await page.mouse.move(x, y); await page.waitForTimeout(150); }
    await ocr('native-camera-after');
    await page.keyboard.down('Space'); await page.waitForTimeout(150); await page.keyboard.up('Space');
    await page.keyboard.press('Escape'); await waitOCR('paused-after-jump', /gamemenu/, 30000);
    const runtimeFile = activeEdition === 'js' ? '/gamefile.html' : '/gamefilebetter.html';
    const keys = evidence.nativeEvents.filter(event => event.scenario === currentScenario && event.type === 'keydown' && event.url.endsWith(runtimeFile) && event.trusted && event.focus);
    for (const code of ['KeyE', 'KeyW', 'Space']) assert.ok(keys.some(event => event.code === code), 'Focused native runtime must receive trusted ' + code);
    pass('native inventory, mouse block actions, movement, camera and jump inputs executed; archive assertions pending');
}
async function saveQuit(alreadyPaused = false, returnToLauncher = true) {
    if (!alreadyPaused) {
        const frame = await (await page.locator('#game-frame').elementHandle()).contentFrame();
        assert.equal(await frame.evaluate(() => document.hasFocus()), true, 'Native runtime must own keyboard focus before Escape');
        await page.keyboard.press('Escape'); await waitOCR('pause-menu', /gamemenu/, 30000); }
    await page.mouse.click(640, 567); await title(30000);
    if (returnToLauncher) { await page.goto(base, { waitUntil: 'load' }); await page.locator('#btn-world-backups').waitFor(); }
}
async function fingerprints() {
    return page.evaluate(async () => {
        const name = '_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_12_2_';
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Expected existing native save database')); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        const rows = await new Promise((resolve, reject) => {
            const collected = [], tx = db.transaction('filesystem', 'readonly');
            tx.oncomplete = () => resolve(collected); tx.onabort = tx.onerror = () => reject(tx.error || new Error('Fingerprint transaction failed'));
            const request = tx.objectStore('filesystem').openCursor();
            request.onsuccess = () => { const cursor = request.result; if (cursor) { const record = cursor.value; collected.push({ path: record.path, data: record.data }); cursor.continue(); } };
        }).finally(() => db.close());
        return (await Promise.all(rows.map(async row => ({ path: row.path, bytes: row.data.byteLength, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', row.data)), byte => byte.toString(16).padStart(2, '0')).join('') })))).sort((a, b) => a.path.localeCompare(b.path));
    });
}
const descriptorsHash = rows => hash(Buffer.from(JSON.stringify(rows)));
function receipt(label, value) {
    const file = currentScenario + '-' + label + '.json';
    fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2));
    return file;
}
async function worldIds() { return page.evaluate(async () => (await window.NexusWorldBackups.listWorlds()).map(world => world.id)); }
async function backup(id, label) {
    const before = await fingerprints();
    await page.locator('#btn-world-backups').click(); await page.locator('#world-backups-dialog').waitFor({ state: 'visible' });
    await page.locator('#world-backups-world').selectOption(id);
    const pending = page.waitForEvent('download', { timeout: 120000 });
    await page.locator('#world-backups-download').click(); const download = await pending;
    assert.equal(await download.failure(), null); assert.match(download.suggestedFilename(), /\.epk$/);
    const destination = path.join(output, currentScenario + '-' + label + '.epk'); await download.saveAs(destination);
    await page.bringToFront();
    const prefix = 'eaglercraft/worlds/' + id + '/';
    const expected = before.filter(row => row.path.startsWith(prefix)).map(row => ({ ...row, path: row.path.slice(prefix.length) })).sort(asciiPaths);
    assert.ok(expected.length, 'Selected world must have saved files');
    expectedManifests.set(destination, expected);
    fs.writeFileSync(path.join(output, currentScenario + '-' + label + '-expected-members.json'), JSON.stringify(expected, null, 2));
    await page.locator('#world-backups-close').click();
    const after = await fingerprints();
    assert.deepEqual(after, before, 'Export must preserve every native IndexedDB record');
    const preservationReceipt = receipt(label + '-database-preservation', { worldId: id, before, after, beforeSha256: descriptorsHash(before), afterSha256: descriptorsHash(after), unchanged: true });
    const bytes = fs.readFileSync(destination);
    pass(label + ' UI download preserves all native database bytes', { filename: download.suggestedFilename(), archive: path.basename(destination), bytes: bytes.length, sha256: hash(bytes), records: before.length, preservationReceipt });
    return destination;
}
function asciiPaths(a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }
function assertMembers(result, archive) {
    assert.ok(Array.isArray(result.member_hashes), 'Independent inspector must report every raw member hash');
    assert.deepEqual([...result.member_hashes].sort(asciiPaths), expectedManifests.get(archive), 'Every exported file must match the selected native database path, length and SHA-256, including padding');
}
function activeSavedPlayer(result) {
    const player = result.players['level.dat'];
    assert.ok(player && Array.isArray(player.Pos) && Array.isArray(player.Rotation), 'Active level.dat player must have saved position and rotation');
    assert.ok(player.inventory?.some(item => item.id === 'minecraft:emerald' && item.Count === 7), 'Active level.dat player must retain seven emeralds');
    assert.ok(Object.entries(result.players).some(([name, value]) => name.startsWith('playerdata/') && JSON.stringify(value.Pos) === JSON.stringify(player.Pos) && JSON.stringify(value.Rotation) === JSON.stringify(player.Rotation) && value.inventory?.some(item => item.id === 'minecraft:emerald' && item.Count === 7)), 'A playerdata file must agree with the active player state and inventory');
    return player;
}
function inspect(archive, name, seed, label) {
    const json = path.join(output, currentScenario + '-' + label + '-inspection.json');
    const stdout = execFileSync(process.env.NEXUS_PYTHON_EXECUTABLE || 'python3', [path.join(root, 'scripts/inspect-world-export.py'), archive, '--expect-name', name, '--expect-seed', seed, '--block=0,4,2', '--block=3,4,3', '--json-output', json], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'ok'); assert.equal(result.format, 'epk-world1122');
    assertMembers(result, archive);
    assert.equal(result.world.GameType, 1, 'Saved world must be Creative');
    assert.deepEqual(result.block_queries.map(query => query.block_id), [41, 57], 'Native mouse-placed gold and command marker diamond must persist');
    assert.equal(result.validation.file_crcs, result.archive.members, 'Every exported file CRC must be checked');
    const player = activeSavedPlayer(result);
    assert.ok(player.Pos[2] > 0.7 && player.Pos[1] > 4.1, 'Active saved player must show forward movement and paused jump height');
    assert.ok(Math.abs(player.Rotation[0]) > 0.1 || Math.abs(player.Rotation[1] - 45) > 0.1, 'Native mouse camera must change saved rotation');
    pass(label + ' independent EPK/NBT inspection proves seed, blocks, inventory, movement, camera and jump', { inspection: path.basename(json), world: result.world, player: 'level.dat', state: player, validation: result.validation });
    return { result, player };
}
function worldRows(rows, id) { return rows.filter(row => row.path.startsWith('eaglercraft/worlds/' + id + '/')); }
// Minecraft font OCR substitutes H/N, 5/S and G/Q. Permit one OCR edit
// per displayed name token; exact folder IDs and saved metadata remain asserted.
function nearWord(actual, expected) {
    actual = normalized(actual); expected = normalized(expected);
    if (actual === expected) return true;
    if (Math.abs(actual.length - expected.length) > 1 || actual.length > 32) return false;
    let i = 0, j = 0, edits = 0;
    while (i < actual.length && j < expected.length) {
        if (actual[i] === expected[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (actual.length >= expected.length) i++;
        if (actual.length <= expected.length) j++;
    }
    return edits + actual.length - i + expected.length - j <= 1;
}
async function openSavedWorld(name) {
    const screen = await selectWorldScreen();
    const candidates = screen.words.filter(word => nearWord(word.text, name.split(' ')[0]));
    const row = candidates.find(candidate => {
        const line = screen.words.filter(word => Math.abs(word.y - candidate.y) < 8);
        return name.split(' ').every(token => line.some(word => nearWord(word.text, token)));
    });
    assert.ok(row, 'Saved-world OCR row missing: ' + name + ': ' + screen.text);
    await page.mouse.click(row.x, row.y); await page.mouse.click(400, 774);
    await gameplay();
}
async function chooseNativeEpk(file, label) {
    await waitOCR(label, /loadep[kr]file/);
    const chosen = page.waitForEvent('filechooser', { timeout: 30000 });
    await page.mouse.click(640, 449); await (await chosen).setFiles(file);
    await page.bringToFront();
}
async function importBackup(archive, restoredName) {
    await selectWorldScreen(); await page.mouse.click(880, 774);
    await waitOCR('import-action-chooser', /loadep[kr]file/);
    const before = await fingerprints();
    evidence.importAttempts ||= [];
    const attempt = { scenario: currentScenario, edition: activeEdition, restoredName, before, worldsListBefore: before.find(row => row.path === 'worlds_list.txt'), rejected: [] };
    evidence.importAttempts.push(attempt);
    async function captureAfter(stable = false) {
        attempt.after = await fingerprints();
        if (stable) {
            await page.waitForTimeout(250);
            const later = await fingerprints();
            attempt.afterStable = descriptorsHash(attempt.after) === descriptorsHash(later);
            attempt.after = later;
        }
        attempt.worldsListAfter = attempt.after.find(row => row.path === 'worlds_list.txt');
        attempt.worldsListUnchanged = attempt.worldsListBefore?.sha256 === attempt.worldsListAfter?.sha256;
        attempt.databaseUnchanged = descriptorsHash(attempt.before) === descriptorsHash(attempt.after);
        attempt.targetRecords = attempt.after.filter(row => row.path.startsWith('eaglercraft/worlds/' + restoredName));
        attempt.worldIdsAfter = await worldIds();
    }
    try {
        const invalid = [
            { name: 'bad.epk', buffer: Buffer.from('not an EPK archive'), reason: 'Invalid EPK framing' },
            { name: ' .epk', buffer: fs.readFileSync(archive), reason: 'Unsafe EPK default world name' }
        ];
        for (const fixture of invalid) {
            await chooseNativeEpk({ name: fixture.name, mimeType: 'application/octet-stream', buffer: fixture.buffer }, 'blocked-picker-' + fixture.name.trim());
            const frame = await (await page.locator('#game-frame').elementHandle()).contentFrame();
            const status = frame.getByRole('status').filter({ hasText: 'EPK import blocked: ' + fixture.reason });
            await status.waitFor({ state: 'visible', timeout: 30000 });
            await waitOCR('blocked-import-return', /loadep[kr]file/, 30000);
            const after = await fingerprints();
            assert.deepEqual(after, before, 'Blocked native file selection must preserve every save record');
            attempt.rejected.push({ filename: fixture.name, expectedReason: fixture.reason, actualStatus: await status.innerText(), beforeSha256: descriptorsHash(before), afterSha256: descriptorsHash(after), unchanged: true });
        }
        pass('native file picker blocks corrupt EPK and unsafe default File.name without changing saves', { cases: attempt.rejected });
        await chooseNativeEpk(archive, 'valid-import-picker');
        await waitOCR('native-import-name', /worldname|worldhare|import[wh]orld|nameyourworld/, 120000);
        // Click the empty right side of the native field, beyond the default
        // basename, so its caret starts at the end even across runtime mappings.
        await clearType(900, 266, restoredName, 64);
        await ocr('native-import-name-edited');
        assert.deepEqual(await fingerprints(), before, 'Selecting a valid archive must not write saves before native confirmation');
        await page.mouse.click(640, 578);
        await waitOCR('native-import-complete', /selectworld|singleplayer/, 120000);
        await captureAfter();
    } catch (error) {
        await captureAfter(true).catch(capture => { attempt.captureError = capture.message; });
        throw error;
    }
}

function inspectRestored(archive, restoredName, seed, label = 'restored-backup') {
    const restoredJson = path.join(output, currentScenario + '-' + label + '-inspection.json');
    const restored = JSON.parse(execFileSync(process.env.NEXUS_PYTHON_EXECUTABLE || 'python3', [path.join(root, 'scripts/inspect-world-export.py'), archive, '--expect-name', restoredName, '--expect-seed', seed, '--block=0,4,2', '--block=3,4,3', '--json-output', restoredJson], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
    assert.equal(restored.status, 'ok'); assert.equal(restored.world.GameType, 1, 'Restored world must retain Creative mode'); assertMembers(restored, archive); assert.deepEqual(restored.block_queries.map(query => query.block_id), [41, 57]);
    activeSavedPlayer(restored);
    assert.equal(restored.validation.file_crcs, restored.archive.members);
    return { restored, restoredJson };
}

async function focusedRestoreDiagnostic(archive) {
    currentScenario = 'restore-wasm'; offline = false;
    evidence.mode = 'same-worker-restore-diagnostic';
    evidence.limitations.push('This diagnostic bootstraps a disposable native world before importing in the SAME worker. A separate fresh-worker import crashed before bootstrap; this diagnostic does not repair it.');
    const inputJson = path.join(output, 'validated-input-inspection.json');
    const input = JSON.parse(execFileSync(process.env.NEXUS_PYTHON_EXECUTABLE || 'python3', [path.join(root, 'scripts/inspect-world-export.py'), archive, '--expect-name', 'Nexus JS QA', '--expect-seed', '123456789', '--block=0,4,2', '--block=3,4,3', '--json-output', inputJson], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
    assert.equal(input.status, 'ok'); assert.deepEqual(input.block_queries.map(query => query.block_id), [41, 57]);
    evidence.restoreInput = { archive, sha256: hash(fs.readFileSync(archive)), inspection: path.basename(inputJson) };
    const bootstrapName = 'Nexus Restore Bootstrap', restoredName = 'Nexus JS QA Restored';
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-focused-restore-')); profiles.push(profile);
    const record = { edition: currentScenario, startedAt: new Date().toISOString() }; evidence.scenarios.push(record);
    await browser(profile); await launcher(); await launchEdition('wasm'); await createWorld(bootstrapName, '1'); await saveQuit(false, false);
    const beforeIds = await worldIds(), original = worldRows(await fingerprints(), bootstrapName);
    await importBackup(archive, restoredName);
    const afterIds = await worldIds(), newIds = afterIds.filter(id => !beforeIds.includes(id));
    record.nativeWorldIds = afterIds; record.restoredId = newIds[0];
    assert.equal(newIds.length, 1, 'Same-worker import must create exactly one restored copy');
    assert.deepEqual(worldRows(await fingerprints(), bootstrapName), original, 'Import must preserve the bootstrap world');
    await clickWord(/^cancel$/i, 'import-list-cancel'); await title(30000);
    await openSavedWorld(restoredName); await saveQuit();
    const restoredArchive = await backup(newIds[0], 'restored-backup');
    const { restored, restoredJson } = inspectRestored(restoredArchive, restoredName, '123456789');
    assert.deepEqual(worldRows(await fingerprints(), bootstrapName), original, 'Restored-copy gameplay must preserve the bootstrap world');
    pass('same-worker native restore compatibility; separate fresh-worker failure is not repaired', { restoredId: newIds[0], inspection: path.basename(restoredJson), world: restored.world });
    record.status = 'pass'; record.finishedAt = new Date().toISOString();
}

// Final guard regression: native imports only, with a fresh worker for each
// import. The first imported archive supplies real durable source data; no world
// creation/opening bootstraps either import worker.
async function freshImportDiagnostic(sourceEdition, directory) {
    currentScenario = 'fresh-import-' + sourceEdition; offline = false;
    evidence.mode = 'fresh-worker-import-diagnostic';
    const name = sourceEdition === 'js' ? 'Nexus JS QA' : 'Nexus WASM QA';
    const seed = sourceEdition === 'js' ? '123456789' : '987654321';
    const target = sourceEdition === 'js' ? 'wasm' : 'js', restoredName = name + ' Restored';
    const archive = path.resolve(directory, sourceEdition + '-cold-offline-backup.epk');
    const inputJson = path.join(output, currentScenario + '-validated-input-inspection.json');
    const input = JSON.parse(execFileSync(process.env.NEXUS_PYTHON_EXECUTABLE || 'python3', [path.join(root, 'scripts/inspect-world-export.py'), archive, '--expect-name', name, '--expect-seed', seed, '--block=0,4,2', '--block=3,4,3', '--json-output', inputJson], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
    assert.equal(input.status, 'ok'); assert.deepEqual(input.block_queries.map(query => query.block_id), [41, 57]); activeSavedPlayer(input);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fresh-import-' + target + '-')); profiles.push(profile);
    const record = { edition: currentScenario, sourceEdition, targetEdition: target, name, seed, archive, archiveSha256: hash(fs.readFileSync(archive)), startedAt: new Date().toISOString(), workerInitializedBy: 'fresh runtime launch; no created or opened world' };
    evidence.scenarios.push(record);
    await browser(profile); await launcher(); await launchEdition(target);
    assert.deepEqual(await worldIds(), [], 'Fresh profile must contain no complete native world before import');
    await importBackup(archive, name);
    await page.goto(base, { waitUntil: 'load' });
    assert.deepEqual(await worldIds(), [name], 'First fresh-worker import must create the exact source world');
    const sourceBefore = worldRows(await fingerprints(), name); assert.ok(sourceBefore.length);
    const importedArchive = await backup(name, 'source-imported-backup');
    inspectRestored(importedArchive, name, seed, 'source-imported-backup');
    pass('fresh worker imports validated archive into an empty profile without world bootstrap', { inputArchive: archive, importedArchive: path.basename(importedArchive), targetEdition: target });
    // Relaunch from the parent creates a second independent native worker. The
    // already imported source remains closed while a separate copy is restored.
    await launchEdition(target); await importBackup(archive, restoredName);
    await page.goto(base, { waitUntil: 'load' });
    const ids = await worldIds(), newIds = ids.filter(id => id !== name);
    assert.equal(newIds.length, 1, 'Second fresh-worker import must create exactly one separate copy');
    const sourceAfterImport = worldRows(await fingerprints(), name);
    assert.deepEqual(sourceAfterImport, sourceBefore, 'Fresh-worker copy import must preserve all original world files');
    await launchEdition(target); await openSavedWorld(restoredName); await saveQuit();
    const restoredArchive = await backup(newIds[0], 'restored-backup');
    const { restored, restoredJson } = inspectRestored(restoredArchive, restoredName, seed);
    const sourceAfterRestore = worldRows(await fingerprints(), name);
    assert.deepEqual(sourceAfterRestore, sourceBefore, 'Restored-copy gameplay must preserve every original world file');
    record.sourcePreservationReceipt = receipt('original-world-preservation', { id: name, beforeImport: sourceBefore, afterImport: sourceAfterImport, afterRestore: sourceAfterRestore, unchanged: true });
    record.restoredId = newIds[0]; record.finishedAt = new Date().toISOString(); record.status = 'pass';
    pass('final guard fresh-worker import, native reopen and exact re-export preserve source data', { targetEdition: target, restoredId: newIds[0], inspection: path.basename(restoredJson), world: restored.world, preservationReceipt: record.sourcePreservationReceipt });
    persist(); await context.close(); context = null;
}

async function scenario(edition) {
    currentScenario = edition; offline = false;
    const name = edition === 'js' ? 'Nexus JS QA' : 'Nexus WASM QA', seed = edition === 'js' ? '123456789' : '987654321';
    const other = edition === 'js' ? 'wasm' : 'js', restoredName = name + ' Restored';
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-gameplay-' + edition + '-')); profiles.push(profile);
    const record = { edition, oppositeEdition: other, name, seed, startedAt: new Date().toISOString() }; evidence.scenarios.push(record);
    await browser(profile); await launcher();
    assert.ok(evidence.network.some(request => request.surface === 'proxy' && request.action === 'forwarded' && request.status === 200), 'Initial loopback traffic must demonstrably traverse the configured proxy');
    await launchEdition(edition); await createWorld(name, seed); await exerciseGameplay(); await saveQuit(true);
    const ids = await worldIds(); record.nativeWorldIds = ids;
    assert.ok(ids.includes(name), 'Native folder ID must match the trusted ASCII world name: ' + JSON.stringify(ids));
    const savedBeforeRestart = await fingerprints();
    // Both network guards are active before clearing HTTP cache and before the
    // original browser process exits, preventing cache refills during shutdown.
    offline = true; const deniedAt = evidence.network.length;
    const cdp = await context.newCDPSession(page); await cdp.send('Network.clearBrowserCache'); await cdp.detach();
    await context.close(); context = null; await browser(profile); await launcher();
    const afterRestart = await fingerprints();
    assert.deepEqual(afterRestart, savedBeforeRestart, 'Cold restart must retain all native saved bytes');
    record.coldRestartReceipt = receipt('cold-restart-preservation', { before: savedBeforeRestart, after: afterRestart, unchanged: true });
    const archive = await backup(name, 'cold-offline-backup'), original = inspect(archive, name, seed, 'cold-offline-backup');
    assert.ok(evidence.network.slice(deniedAt).every(request => request.surface !== 'backend' && request.action === 'blocked'), 'Cold offline backup must use service-worker bytes with no successful backend or proxy traffic');
    record.coldOfflineNetwork = { startIndex: deniedAt, endIndex: evidence.network.length, backendRequests: evidence.network.slice(deniedAt).filter(request => request.surface === 'backend').length, forwardedRequests: evidence.network.slice(deniedAt).filter(request => request.action === 'forwarded').length };
    pass('cold browser restart and actual backup UI work offline with an unchanged save database', { preservationReceipt: record.coldRestartReceipt, network: record.coldOfflineNetwork });
    offline = false; await launchEdition(other); await openSavedWorld(name); await saveQuit();
    pass('opposite edition reopens the saved source world after a cold browser restart');
    const sourceBeforeImport = worldRows(await fingerprints(), name); assert.ok(sourceBeforeImport.length);
    const beforeImportIds = await worldIds();
    // Deliberately relaunch: this is the fresh-worker bootstrap regression,
    // distinct from the separately labeled same-worker diagnostic.
    await launchEdition(other); await importBackup(archive, restoredName);
    await page.goto(base, { waitUntil: 'load' });
    const afterImportIds = await worldIds(), newIds = afterImportIds.filter(id => !beforeImportIds.includes(id));
    assert.equal(newIds.length, 1, 'Native import must create one separate saved-world folder');
    assert.notEqual(newIds[0], name, 'Native import must never overwrite the original saved world');
    const sourceAfterImport = worldRows(await fingerprints(), name);
    assert.deepEqual(sourceAfterImport, sourceBeforeImport, 'Native import must preserve all source-world file hashes');
    await launchEdition(other); await openSavedWorld(restoredName);
    // Opening a restored world resumes time and settles a paused jump; compare
    // persistent semantic markers/inventory rather than demanding identical ticks.
    await page.keyboard.press('Escape'); await waitOCR('restored-paused', /gamemenu/, 30000); await saveQuit(true);
    const restoredArchive = await backup(newIds[0], 'restored-backup');
    const { restored, restoredJson } = inspectRestored(restoredArchive, restoredName, seed);
    const sourceAfterRestore = worldRows(await fingerprints(), name);
    assert.deepEqual(sourceAfterRestore, sourceBeforeImport, 'Restored-copy gameplay must preserve every original world file');
    record.sourcePreservationReceipt = receipt('original-world-preservation', { id: name, beforeImport: sourceBeforeImport, afterImport: sourceAfterImport, afterRestore: sourceAfterRestore, unchanged: true });
    pass('fresh-worker native EPK import in the opposite edition restores a separately saved copy and preserves the source', { workerInitializedBy: 'fresh runtime launch after source-world reopen', originalId: name, restoredId: newIds[0], inspection: path.basename(restoredJson), originalSeed: original.result.world.RandomSeedDecimal, restoredSeed: restored.world.RandomSeedDecimal, preservationReceipt: record.sourcePreservationReceipt });
    record.finishedAt = new Date().toISOString(); record.status = 'pass'; persist();
    await context.close(); context = null;
}
(async () => {
    try {
        await listen(backend); base = 'http://127.0.0.1:' + backend.address().port + '/'; await listen(proxy);
        evidence.base = base; evidence.sourceHashes = Object.fromEntries(['index.html', 'gamefile.html', 'gamefilebetter.html', 'assets/world-backups.js', 'assets/world-backups-ui.js', 'assets/epk-import-guard.js', 'scripts/inspect-world-export.py', 'tests/gameplay.integration.cjs', 'sw.js'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
        if (process.env.NEXUS_GAMEPLAY_FRESH_IMPORT_SOURCE) {
            for (const edition of scenarios) await freshImportDiagnostic(edition, path.resolve(process.env.NEXUS_GAMEPLAY_FRESH_IMPORT_SOURCE));
        } else if (process.env.NEXUS_GAMEPLAY_RESTORE_ARCHIVE) await focusedRestoreDiagnostic(path.resolve(process.env.NEXUS_GAMEPLAY_RESTORE_ARCHIVE));
        else for (const edition of scenarios) await scenario(edition);
    } catch (error) {
        evidence.errors.push({ scenario: currentScenario, message: error.message, stack: error.stack });
        evidence.checks.push({ scenario: currentScenario, name: 'Native gameplay acceptance', status: 'fail', reason: error.message });
        const record = evidence.scenarios.find(value => value.edition === currentScenario); if (record) record.status = 'fail';
        if (page && !page.isClosed()) await ocr('failure').catch(capture => evidence.errors.push({ screenshot: capture.message }));
        console.error(error); process.exitCode = 1;
    } finally {
        if (context) await context.close().catch(error => { evidence.errors.push({ close: error.message }); process.exitCode = 1; });
        await Promise.all([close(proxy), close(backend)]);
        for (const profile of profiles) fs.rmSync(profile, { recursive: true, force: true });
        evidence.cleanup = { profilesRemoved: profiles.every(profile => !fs.existsSync(profile)), backendClosed: !backend.listening, proxyClosed: !proxy.listening };
        persist(); console.log('Gameplay evidence: ' + output);
    }
})();
