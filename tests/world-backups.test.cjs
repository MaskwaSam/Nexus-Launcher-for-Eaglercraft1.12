const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const core = require('../assets/world-backups.js');

function epkRecords(bytes) {
    const data = Buffer.from(bytes); let at = 8;
    assert.equal(data.subarray(0, at).toString(), 'EAGPKG$$');
    const text8 = () => { const length = data[at++], value = data.subarray(at, at + length).toString('latin1'); at += length; return value; };
    assert.equal(text8(), 'ver2.0'); text8();
    const commentLength = data.readUInt16BE(at); at += 2 + commentLength + 8;
    const count = data.readUInt32BE(at); at += 4;
    assert.equal(String.fromCharCode(data[at++]), '0');
    const files = new Map();
    for (let i = 0; i < count; i++) {
        const type = data.subarray(at, at + 4).toString(); at += 4;
        const name = text8(), size = data.readUInt32BE(at); at += 4;
        if (type === 'HEAD') { assert.equal(name, 'file-type'); assert.equal(data.subarray(at, at + size).toString(), 'epk/world1122'); at += size; }
        else {
            assert.equal(type, 'FILE'); const crc = data.readUInt32BE(at); at += 4;
            const file = data.subarray(at, at + size - 5); at += size - 5;
            assert.equal(core.crc32(file), crc); assert.equal(data[at++], 58); files.set(name, file);
        }
        assert.equal(data[at++], 62);
    }
    assert.equal(data.subarray(at).toString(), 'END$:::YEE:>');
    return files;
}
function mockStorage(records, { missing = false, transactionFailure = false, blocked = false } = {}) {
    const log = []; let aborted = false;
    const transaction = {
        abort() { aborted = true; log.push('abort'); queueMicrotask(() => { if (transaction.onabort) transaction.onabort(); }); },
        objectStore(name) { log.push(['store', name]); return { openCursor() {
            const request = {}; let cursorIndex = 0;
            function advance() {
                if (aborted) return;
                queueMicrotask(() => {
                    const record = records[cursorIndex++];
                    request.result = record ? { value: record, continue: advance } : null;
                    request.onsuccess();
                    if (!record) queueMicrotask(() => transactionFailure ? transaction.onabort() : transaction.oncomplete());
                });
            }
            advance(); return request;
        } }; }
    };
    const db = { objectStoreNames: { contains: name => name === 'filesystem' }, close() { log.push('close'); }, transaction(name, mode) { log.push(['transaction', name, mode]); return transaction; } };
    const indexedDB = { open(name, version) {
        log.push(['open', name, version]); const request = { result: db, transaction };
        queueMicrotask(() => { if (missing) { request.onupgradeneeded(); request.onerror(); } else if (blocked) { request.onblocked(); queueMicrotask(() => request.onsuccess()); } else request.onsuccess(); });
        return request;
    } };
    const context = { window: { indexedDB }, ArrayBuffer, Uint8Array, Uint32Array, DataView, TextEncoder, Blob, Set, Date };
    vm.runInNewContext(fs.readFileSync(require.resolve('../assets/world-backups.js'), 'utf8'), context);
    return { api: context.window.NexusWorldBackups, log };
}
const record = (path, bytes = [1]) => ({ path, data: Uint8Array.from(bytes).buffer });

test('native EPK preserves every world-relative file, including opaque metadata and all dimensions', () => {
    const files = ['level.dat', 'level.dat_old', 'playerdata/user.dat', 'data/map_0.dat', 'stats/user.json', 'eagler/skulls/custom', 'icon.png', 'level0/ABC.dat', 'level-1/DEF.dat', 'level1/GHI.dat', 'unknown/opaque.bin'].map((path, i) => ({ path, data: Uint8Array.from([i, 0, 255, 58, 62]) }));
    const result = core.encodeEpk({ id: 'World 1', files, capturedAt: 0 });
    assert.equal(result.filename, 'World_1.epk');
    assert.equal(result.world.fileCount, files.length);
    const members = epkRecords(result.bytes);
    for (const file of files) assert.deepEqual(members.get(file.path), Buffer.from(file.data));
    assert.equal(members.size, files.length);
    assert.equal(core.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('unsafe, duplicate, unrepresentable and incomplete native entries fail closed', () => {
    for (const path of ['../leak', '/leak', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'C:leak', 'a\0b', 'a\u0085b', 'a/', ' ../leak', '.. /leak', 'a/ ./b', 'a/ /b', 'level.dat ']) {
        assert.throws(() => core.encodeEpk({ id: 'world', files: [{ path: 'level.dat', data: new Uint8Array() }, { path, data: new Uint8Array() }] }), /path/);
    }
    assert.throws(() => core.encodeEpk({ id: '../world', files: [] }), /ID/);
    assert.throws(() => core.encodeEpk({ id: 'world', files: [{ path: 'level.dat', data: new Uint8Array() }, { path: 'level.dat', data: new Uint8Array() }] }), /Duplicate/);
    assert.throws(() => core.encodeEpk({ id: 'world', files: [{ path: 'icon.png', data: new Uint8Array() }] }), /level.dat/);
    assert.throws(() => core.encodeEpk({ id: 'world', files: [{ path: 'level.dat', data: new Uint8Array() }, { path: 'unicode-😀', data: new Uint8Array() }] }), /without loss/);
    assert.throws(() => core.encodeEpk({ id: 'world', files: [{ path: 'level.dat', data: new Uint8Array(core.LIMITS.fileBytes + 1) }] }), /size limit/);
});

test('one readonly transaction snapshots only the exact selected world prefix', async () => {
    const source = record('eaglercraft/worlds/alpha/level.dat', [7, 8]);
    const { api, log } = mockStorage([record('worlds_list.txt'), source, record('eaglercraft/worlds/alpha/data/map.dat'), record('eaglercraft/worlds/alpha-other/level.dat', [99]), record('eaglercraft/worlds/beta/level.dat', [98])]);
    const snapshot = await api.snapshotWorld('alpha');
    assert.deepEqual(Array.from(snapshot.files, file => file.path), ['data/map.dat', 'level.dat']);
    new Uint8Array(source.data)[0] = 0;
    assert.deepEqual(Array.from(snapshot.files[1].data), [7, 8]);
    assert.deepEqual(log.filter(item => Array.isArray(item) && item[0] === 'transaction'), [['transaction', 'filesystem', 'readonly']]);
    assert.equal(log.at(-1), 'close');
    assert.deepEqual(log.find(item => Array.isArray(item) && item[0] === 'open'), ['open', '_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_12_2_', undefined]);
});

test('lists durable native worlds; missing DB creation is aborted without records or writes', async () => {
    const existing = mockStorage([record('worlds_list.txt'), record('eaglercraft/worlds/alpha/level.dat'), record('eaglercraft/worlds/beta/level.dat'), record('eaglercraft/worlds/unfinished/icon.png')]);
    assert.deepEqual(Array.from(await existing.api.listWorlds(), world => world.id), ['alpha', 'beta']);
    const absent = mockStorage([], { missing: true });
    await assert.rejects(absent.api.listWorlds(), /No saved-world database/);
    assert.equal(absent.log.filter(item => item === 'abort').length, 1);
    assert.equal(absent.log.some(item => Array.isArray(item) && item[0] === 'transaction'), false);
});

test('snapshot corruption, absent level.dat, and transaction failure never return partial backups', async () => {
    for (const rows of [[record('eaglercraft/worlds/alpha/data/bad')], [record('eaglercraft/worlds/alpha/level.dat'), record('eaglercraft/worlds/alpha/a/../b')], [record('eaglercraft/worlds/alpha/level.dat'), { path: 'eaglercraft/worlds/alpha/bad', data: 'invalid' }]]) {
        const { api } = mockStorage(rows); await assert.rejects(api.snapshotWorld('alpha'));
    }
    const { api } = mockStorage([record('eaglercraft/worlds/alpha/level.dat')], { transactionFailure: true });
    await assert.rejects(api.snapshotWorld('alpha'), /snapshot/);
});

// Independent Python inspector owns the EPK/NBT decoder, rather than calling the writer's helpers.
test('generated native archive passes independent EPK CRC/framing and gzip NBT inspection', () => {
    const text = value => { const data = Buffer.from(value), length = Buffer.alloc(2); length.writeUInt16BE(data.length); return Buffer.concat([length, data]); };
    const nbt = Buffer.concat([Buffer.from([10, 0, 0, 10]), text('Data'), Buffer.from([8]), text('LevelName'), text('Core Native Fixture'), Buffer.from([0, 0])]);
    const result = core.encodeEpk({ id: 'native-fixture', capturedAt: 0, files: [{ path: 'level.dat', data: gzipSync(nbt) }, { path: 'opaque/extra.bin', data: Uint8Array.from([0, 255, 58, 62]) }] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-native-core-'));
    try {
        const archive = path.join(dir, result.filename); fs.writeFileSync(archive, result.bytes);
        const inspected = spawnSync(process.env.NEXUS_PYTHON_EXECUTABLE || 'python3', [path.resolve(__dirname, '../scripts/inspect-world-export.py'), archive, '--expect-name', 'Core Native Fixture'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
        assert.equal(JSON.parse(inspected.stdout).archive.members, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a blocked open rejects and closes a late success without starting a snapshot', async () => {
    const { api, log } = mockStorage([], { blocked: true });
    await assert.rejects(api.listWorlds(), /storage is busy/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(log.at(-1), 'close');
    assert.equal(log.some(item => Array.isArray(item) && item[0] === 'transaction'), false);
});

test('confirmed browser BASE database and human-readable native folder preserve padded gzip bytes', async () => {
    const id = 'New WorldANexus-JS-Probe';
    const padded = Buffer.alloc(320); gzipSync(Buffer.from('native chunk byte fixture')).copy(padded);
    const level = Buffer.alloc(2068); gzipSync(Buffer.from('native level byte fixture')).copy(level);
    const { api, log } = mockStorage([
        record('worlds_list.txt', Buffer.from(id)),
        record('eaglercraft/worlds/' + id + '/level.dat', level),
        record('eaglercraft/worlds/' + id + '/level0/0BDFC106DFC1.dat', padded),
        record('eaglercraft/worlds/' + id + '/stats/UUID.json', Buffer.from('{}')),
        record('eaglercraft/worlds/Other World/level.dat', [99])
    ]);
    assert.deepEqual(Array.from(await api.listWorlds(), world => world.name), [id, 'Other World']);
    const exported = api.encodeEpk(await api.snapshotWorld(id)), members = epkRecords(exported.bytes);
    assert.deepEqual(members.get('level.dat'), level);
    assert.deepEqual(members.get('level0/0BDFC106DFC1.dat'), padded);
    assert.equal(members.size, 3);
    assert.equal(members.has('worlds_list.txt'), false);
    assert.ok(log.filter(item => Array.isArray(item) && item[0] === 'open').every(item => item[1] === '_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_12_2_'));
});
