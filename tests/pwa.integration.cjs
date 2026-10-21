// Optional native Chrome acceptance; deliberately excluded from *.test.cjs.
// Requires Chrome with the experimental CDP PWA domain, Playwright, Sharp and Tesseract.
// Uses only an isolated temporary profile and loopback test application IDs.
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
const output = process.env.NEXUS_PWA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pwa-evidence-'));
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pwa-profile-'));
const evidence = {
    checks: [], proxy: [], backend: [], errors: [],
    limitations: ['Installed desktop Chrome in an isolated headless persistent profile; no install dialog, phone, physical controller, classroom hardware or gameplay acceptance.', 'CDP installs and launches real applications; display-mode is never emulated.']
};
let context, browserCDP, offline = false, base;
const installed = [];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pass = (name, detail = {}) => { evidence.checks.push({ name, status: 'pass', ...detail }); console.log('PASS ' + name); };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/manifest+json', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

const backend = http.createServer((req, res) => {
    evidence.backend.push({ url: req.url, offline });
    if (offline) { res.writeHead(503).end('Offline backend guard'); return; }
    const url = new URL(req.url, base);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    // Both installations serve the exact same project bytes at distinct scopes.
    if (pathname.startsWith('/classroom/')) pathname = pathname.slice('/classroom'.length);
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
    const allowed = !offline && target.origin === base.slice(0, -1);
    const record = { method: req.method, url: target.href, offline, action: allowed ? 'forwarded' : 'blocked' };
    evidence.proxy.push(record);
    if (!allowed) { res.writeHead(502).end('Test proxy blocks network'); return; }
    const upstream = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, response => {
        record.status = response.statusCode;
        response.on('error', error => { record.error = error.message; res.destroy(); });
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
    });
    upstream.on('error', error => { record.error = error.message; if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
});
proxy.on('connect', (req, socket) => {
    evidence.proxy.push({ method: 'CONNECT', url: req.url, offline, action: 'blocked' });
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
});
for (const server of [proxy, backend]) {
    server.on('connection', socket => socket.on('error', () => socket.destroy()));
    server.on('clientError', (_error, socket) => socket.destroy());
}

async function openChrome() {
    context = await chromium.launchPersistentContext(profile, {
        executablePath: process.env.NEXUS_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, chromiumSandbox: true, acceptDownloads: true,
        viewport: { width: 1280, height: 900 },
        proxy: { server: 'http://127.0.0.1:' + proxy.address().port, bypass: '<-loopback>' },
        args: ['--proxy-bypass-list=<-loopback>']
    });
    browserCDP = await context.browser().newBrowserCDPSession();
    // Playwright owns download destination/policy (acceptDownloads:true); changing
    // Browser.setDownloadBehavior here would desynchronize download.path().
    evidence.downloadEvents ||= [];
    browserCDP.on('Browser.downloadWillBegin', event => evidence.downloadEvents.push({ type: 'begin', ...event }));
    browserCDP.on('Browser.downloadProgress', event => evidence.downloadEvents.push({ type: 'progress', ...event }));
    evidence.browserVersion = await browserCDP.send('Browser.getVersion');
}

async function controlled(page) {
    // Await the Promise in evaluate: waitForFunction(async ...) can accept it early.
    await page.evaluate(async () => {
        await Promise.race([
            (async () => {
                const registration = await navigator.serviceWorker.ready;
                while (!registration.active) await new Promise(resolve => setTimeout(resolve, 100));
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Active controlling service worker timed out')), 120000))
        ]);
    });
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload({ waitUntil: 'load' });
    assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
}

async function launchedPage(manifestId) {
    const before = new Set(context.pages());
    const pending = context.waitForEvent('page', { timeout: 30000 });
    const { targetId } = await browserCDP.send('PWA.launch', { manifestId });
    evidence.launches ||= [];
    const diagnostic = { manifestId, targetId, targets: await browserCDP.send('Target.getTargets') };
    evidence.launches.push(diagnostic);
    // Chrome's PWA domain can return an ID different from the final page target.
    // Attach the newly created page and prove its URL and native standalone mode.
    const page = context.pages().find(page => !before.has(page)) || await pending;
    await page.waitForLoadState('domcontentloaded');
    assert.equal(page.url(), manifestId);
    const session = await context.newCDPSession(page);
    diagnostic.pageTarget = await session.send('Target.getTargetInfo');
    await session.detach();
    return page;
}

async function storage(page, write) {
    return page.evaluate(async write => {
        const marker = 'isolated-native-pwa-sentinel';
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('nexus-pwa-acceptance', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('sentinels');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        if (write) localStorage.setItem(marker, marker);
        const value = await new Promise((resolve, reject) => {
            const tx = db.transaction('sentinels', write ? 'readwrite' : 'readonly');
            const request = write ? tx.objectStore('sentinels').put(marker, marker) : tx.objectStore('sentinels').get(marker);
            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => resolve(write ? marker : request.result);
        });
        db.close();
        return { local: localStorage.getItem(marker), indexed: value };
    }, write);
}

async function launcher(page, label) {
    await page.locator('#btn-js').waitFor();
    assert.equal(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), true);
    const assets = await page.evaluate(async () => {
        await document.fonts.ready;
        return {
            images: [...document.images].map(img => ({ src: img.getAttribute('src'), complete: img.complete, width: img.naturalWidth })),
            fonts: [...document.fonts].map(font => ({ family: font.family, status: font.status })),
            bodyFont: getComputedStyle(document.body).fontFamily,
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            buttons: ['btn-js', 'btn-wasm'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { width: r.width, height: r.height }; })
        };
    });
    assert.ok(assets.images.length && assets.images.every(img => img.complete && img.width > 0));
    for (const family of ['Inter', 'Orbitron']) assert.ok(assets.fonts.some(font => font.family.replace(/["']/g, '') === family && font.status === 'loaded'), family + ' must load offline');
    assert.equal(assets.horizontalOverflow, false);
    assert.ok(assets.buttons.every(button => button.width > 100 && button.height > 20));
    await page.getByRole('link', { name: 'About', exact: true }).click();
    await page.locator('#about-page').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await page.locator('#about-page').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, label + '-launcher.png') });
    pass(label + ': installed standalone layout, local assets/fonts and About/back', assets);
}

async function worldBackups(page, label) {
    const databaseName = '_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_12_2_';
    const databaseExists = () => page.evaluate(async name =>
        (await indexedDB.databases()).some(database => database.name === name), databaseName);
    assert.equal(await databaseExists(), false, label + ': world database should be absent before opening backups');

    await page.locator('#btn-world-backups').click();
    const dialog = page.locator('#world-backups-dialog');
    await dialog.waitFor({ state: 'visible' });
    await page.waitForFunction(expected =>
        document.getElementById('world-backups-status')?.textContent === expected,
        'No saved worlds yet. Create one in either edition and Save and Quit to Title.');
    assert.equal(await page.locator('#world-backups-status').innerText(),
        'No saved worlds yet. Create one in either edition and Save and Quit to Title.');
    assert.equal(await page.locator('#world-backups-world').isDisabled(), true);
    assert.equal(await page.locator('#world-backups-download').isDisabled(), true);
    if (label === 'root') {
        assert.equal(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), true);
        const viewportAudit = async name => {
            const geometry = await page.evaluate(() => {
                const box = element => {
                    const rect = element.getBoundingClientRect();
                    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
                };
                return {
                    viewport: { width: innerWidth, height: innerHeight },
                    dialog: box(document.getElementById('world-backups-dialog')),
                    close: box(document.getElementById('world-backups-close')),
                    select: box(document.getElementById('world-backups-world')),
                    horizontalOverflow: document.getElementById('world-backups-dialog').scrollWidth > document.getElementById('world-backups-dialog').clientWidth
                };
            });
            for (const [control, rect] of [['dialog', geometry.dialog], ['close', geometry.close], ['select', geometry.select]]) {
                assert.ok(rect.x >= 0 && rect.y >= 0 && rect.right <= geometry.viewport.width && rect.bottom <= geometry.viewport.height,
                    name + ': ' + control + ' must fit within the viewport');
                assert.ok(rect.width >= 32 && rect.height >= 24, name + ': ' + control + ' must have usable dimensions');
            }
            assert.equal(geometry.horizontalOverflow, false, name + ': dialog content must not overflow horizontally');
            assert.equal(await page.locator('#world-backups-close').isEnabled(), true);
            await page.screenshot({ path: path.join(output, 'root-world-backups-' + name + '.png') });
            return geometry;
        };
        const desktop = await viewportAudit('desktop');
        await page.setViewportSize({ width: 412, height: 844 });
        assert.equal(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), true);
        const narrow = await viewportAudit('412px-viewport');
        pass('root: backup dialog fits desktop and 412px viewport in installed standalone mode (viewport resize, not device acceptance)', { desktop, narrow });
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-world-backups');

    await page.locator('#btn-world-backups').click();
    await page.locator('#world-backups-close').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-world-backups');
    assert.equal(await databaseExists(), false, label + ': backup UI must not create the world database');
    pass(label + ': offline backup empty state creates no world database and Escape/Close restore focus');
}

async function downloads(page, label) {
    for (const [file, filename] of [['gamefile.html', 'Nexus_JS_Edition.html'], ['gamefilebetter.html', 'Nexus_WASM_GC.html']]) {
        try {
            const pending = page.waitForEvent('download');
            await page.locator('a[download="' + filename + '"]').click();
            const download = await pending;
            assert.equal(download.suggestedFilename(), filename);
            assert.equal(await download.failure(), null);
            const actual = fs.readFileSync(await download.path());
            const expected = fs.readFileSync(path.join(root, file));
            assert.equal(actual.length, expected.length);
            assert.equal(digest(actual), digest(expected));
            pass(label + ': offline download ' + filename, { bytes: actual.length, sha256: digest(actual) });
        } catch (error) {
            evidence.checks.push({ name: label + ': offline download ' + filename, status: 'fail', reason: error.message });
            process.exitCode = 1;
            console.error('FAIL ' + label + ': offline download ' + filename + ': ' + error.message);
        }
    }
}

async function ocr(page, label, expected) {
    const screenshot = path.join(output, label + '.png');
    await page.screenshot({ path: screenshot });
    // Minecraft's gray textured buttons defeat ordinary adaptive OCR. Isolate
    // their light text without resizing so bounding boxes remain screen pixels.
    const prepared = path.join(output, label + '-ocr.png');
    await sharp(screenshot).grayscale().threshold(180).negate().toFile(prepared);
    const words = [];
    for (const [source, suffix] of [[screenshot, ''], [prepared, '-prepared']]) {
        const tsv = execFileSync(process.env.NEXUS_TESSERACT_EXECUTABLE || 'tesseract', [source, 'stdout', '--psm', '11', 'tsv'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        fs.writeFileSync(path.join(output, label + suffix + '.tsv'), tsv);
        words.push(...tsv.trim().split('\n').slice(1).map(line => line.split('\t')).filter(row => row.length >= 12 && Number(row[10]) >= 0).map(row => ({ text: row.slice(11).join('\t'), x: Number(row[6]) + Number(row[8]) / 2, y: Number(row[7]) + Number(row[9]) / 2 })));
    }
    const text = words.map(word => word.text).join(' ');
    if (expected) assert.match(text.toLowerCase().replace(/[^a-z]/g, ''), expected, label + ' OCR: ' + text);
    return { words, text };
}

async function game(page, edition, label) {
    await page.locator(edition === 'js' ? '#btn-js' : '#btn-wasm').click();
    const frame = await (await page.locator('#game-frame').elementHandle()).contentFrame();
    const deadline = Date.now() + 120000;
    let rendered;
    while (Date.now() < deadline) {
        const prompt = frame.getByText(/Launch EaglercraftX/i);
        if (await prompt.isVisible().catch(() => false)) await prompt.click();
        if (await frame.locator('canvas').count()) {
            rendered = await ocr(page, label + '-profile');
            if (/editprofile/.test(rendered.text.toLowerCase().replace(/[^a-z]/g, ''))) break;
        }
        await page.waitForTimeout(1500);
    }
    assert.ok(rendered && /editprofile/.test(rendered.text.toLowerCase().replace(/[^a-z]/g, '')), label + ' must render Edit Profile, not merely a canvas');
    pass(label + ': offline ' + edition + ' runtime renders Edit Profile');
    async function clickWord(pattern, name) {
        const screen = await ocr(page, label + '-' + name);
        const word = screen.words.find(word => pattern.test(word.text));
        assert.ok(word, name + ' OCR target missing: ' + screen.text);
        await page.mouse.click(word.x, word.y);
        await page.waitForTimeout(500);
    }
    await clickWord(/^done$/i, 'done');
    for (let i = 0; i < 3; i++) {
        const screen = await ocr(page, label + '-after-done-' + i);
        if (/defaultuserna[mn]e/i.test(screen.text.replace(/\s/g, ''))) await clickWord(/^continue$/i, 'continue');
        else if (/important|inportant/i.test(screen.text)) await clickWord(/^(understand|continue|done)$/i, 'acknowledge');
        else break;
    }
    await ocr(page, label + '-title', /singleplayer/);
    await clickWord(/^options[.!]*$/i, 'options-button');
    await ocr(page, label + '-options', /options/);
    await clickWord(/^controls[.!]*$/i, 'controls-button');
    await ocr(page, label + '-controls', /controls/);
    pass(label + ': trusted desktop mouse reaches title, Options and Controls');
}

async function main() {
    await listen(backend);
    base = 'http://127.0.0.1:' + backend.address().port + '/';
    await listen(proxy);
    await openChrome();
    const manifestHash = digest(fs.readFileSync(path.join(root, 'manifest.json')));
    const scopes = ['', 'classroom/'];
    for (const scope of scopes) {
        const url = base + scope;
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'load', timeout: 120000 });
        await controlled(page);
        const session = await context.newCDPSession(page);
        const manifest = await session.send('Page.getAppManifest');
        const errors = await session.send('Page.getInstallabilityErrors');
        assert.deepEqual(errors.installabilityErrors, []);
        assert.deepEqual(manifest.errors, []);
        assert.equal(digest(Buffer.from(manifest.data)), manifestHash);
        const manifestId = url + 'index.html';
        const parsedManifest = JSON.parse(manifest.data);
        assert.equal(new URL(parsedManifest.id || parsedManifest.start_url, manifest.url).href, manifestId);
        evidence.checks.push({ name: scope + ' manifest diagnostics', status: 'pass', manifestId, manifest, installability: errors });
        await browserCDP.send('PWA.install', { manifestId, installUrlOrBundleUrl: url });
        installed.push(manifestId);
        await browserCDP.send('PWA.changeAppUserSettings', { manifestId, displayMode: 'standalone' });
        const state = await browserCDP.send('PWA.getOsAppState', { manifestId });
        pass((scope || 'root') + ': native Chrome installation', { manifestId, osAppState: state });
        await storage(page, true);
        await session.send('Network.clearBrowserCache');
        await session.detach();
        await page.close();
    }
    assert.ok(evidence.proxy.some(req => req.action === 'forwarded' && req.status === 200), 'Loopback requests must demonstrably traverse proxy');
    // Critical ordering: deny network before the entire browser process exits/restarts.
    offline = true;
    await context.close();
    context = null;
    const coldStart = { proxyIndex: evidence.proxy.length, backendIndex: evidence.backend.length };
    await openChrome();
    evidence.persistedInstallations = await Promise.all(installed.map(async manifestId => ({ manifestId, osAppState: await browserCDP.send('PWA.getOsAppState', { manifestId }) })));
    pass('Chrome cold restart uses same isolated profile with process-wide network denied');
    // Check both scopes before starting either game runtime: the two app paths
    // share origin storage, and gameplay may create the platform filesystem DB.
    for (let i = 0; i < scopes.length; i++) {
        const scope = scopes[i], label = scope ? 'classroom' : 'root', url = base + scope;
        const page = await launchedPage(url + 'index.html');
        await worldBackups(page, label);
        await page.close();
    }
    for (let i = 0; i < scopes.length; i++) {
        const scope = scopes[i], label = scope ? 'classroom' : 'root', url = base + scope;
        const page = await launchedPage(url + 'index.html');
        await launcher(page, label);
        assert.deepEqual(await storage(page, false), { local: 'isolated-native-pwa-sentinel', indexed: 'isolated-native-pwa-sentinel' });
        pass(label + ': localStorage and IndexedDB survive cold restart');
        for (const alias of [url, url + 'index.html?launch=installed']) {
            await page.goto(alias, { waitUntil: 'load' });
            await page.locator('#btn-js').waitFor();
            assert.equal(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), true);
        }
        pass(label + ': root and index launch-query navigation offline');
        await downloads(page, label);
        await game(page, i === 0 ? 'js' : 'wasm', label);
        const negative = await context.newPage();
        for (const suffix of ['unknown-navigation', 'gamefile.html?uncached=1']) {
            const response = await negative.goto(url + suffix, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
            assert.ok(!response || !response.ok(), suffix + ' must fail with the network denied');
            assert.equal(await negative.locator('#btn-js').count(), 0, suffix + ' must not receive launcher shell');
        }
        await negative.close();
        pass(label + ': unknown navigation and runtime query receive no shell fallback');
        await page.close();
    }
    const inspection = await context.newPage();
    await inspection.goto(base + 'index.html');
    const caches = await inspection.evaluate(() => window.caches.keys());
    for (const scope of ['/', '/classroom/']) assert.ok(caches.includes('nexus-launcher:' + encodeURIComponent(scope) + ':v5'), 'Distinct scoped cache: ' + scope);
    pass('Root and classroom installed apps and scope caches coexist', { caches });
    assert.equal(evidence.backend.length, coldStart.backendIndex, 'No backend traffic may bypass offline proxy after cold restart');
    assert.ok(evidence.proxy.slice(coldStart.proxyIndex).every(req => req.action === 'blocked'), 'No successful network after restart');
    pass('Cold offline launch has zero successful proxy or backend requests', { blocked: evidence.proxy.slice(coldStart.proxyIndex).length });
}

(async () => {
    try { await main(); }
    catch (error) {
        evidence.errors.push({ message: error.message, stack: error.stack });
        evidence.checks.push({ name: 'Installed PWA acceptance', status: 'fail', reason: error.message });
        process.exitCode = 1;
        console.error(error);
    } finally {
        // IDs are derived only from our random loopback server and isolated profile.
        if (browserCDP) for (const manifestId of installed) {
            try { await browserCDP.send('PWA.uninstall', { manifestId }); pass('Cleanup: uninstalled isolated app', { manifestId }); }
            catch (error) { evidence.errors.push({ cleanup: manifestId, message: error.message }); process.exitCode = 1; }
        }
        if (context) await context.close().catch(error => { evidence.errors.push({ close: error.message }); process.exitCode = 1; });
        await Promise.all([close(proxy), close(backend)]);
        fs.rmSync(profile, { recursive: true, force: true });
        evidence.cleanup = { isolatedProfileRemoved: !fs.existsSync(profile), backendClosed: !backend.listening, proxyClosed: !proxy.listening };
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2));
        console.log('PWA evidence: ' + output);
    }
})();
