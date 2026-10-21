const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { gzipSync, deflateSync } = require('node:zlib');
const test = require('node:test');

const script = path.resolve(__dirname, '../scripts/inspect-world-export.py');
const python = process.env.NEXUS_PYTHON_EXECUTABLE || 'python3';
const bytes = (...parts) => Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)));
const numeric = (type, value) => { const data = Buffer.alloc({ b: 1, h: 2, i: 4, q: 8, d: 8 }[type]); data[{ b: 'writeInt8', h: 'writeInt16BE', i: 'writeInt32BE', q: 'writeBigInt64BE', d: 'writeDoubleBE' }[type]](type === 'q' ? BigInt(value) : value); return data; };
const text = value => { const data = Buffer.from(value); const length = Buffer.alloc(2); length.writeUInt16BE(data.length); return bytes(length, data); };
const tag = (type, name, value) => bytes([type], text(name), value);
const compound = (...tags) => bytes(...tags, [0]);
const str = (name, value) => tag(8, name, text(value));
const integer = (name, value) => tag(3, name, numeric('i', value));
const byte = (name, value) => tag(1, name, numeric('b', value));
const array = (name, value) => tag(7, name, bytes(numeric('i', value.length), value));
const list = (name, kind, values) => tag(9, name, bytes([kind], numeric('i', values.length), ...values));
const root = (...tags) => bytes([10], text(''), compound(...tags));
const namedCompound = (name, ...tags) => tag(10, name, compound(...tags));
const inventoryItem = compound(byte('Slot', 2), str('id', 'minecraft:diamond'), byte('Count', 7), tag(2, 'Damage', numeric('h', 0)));
const levelNBT = () => root(namedCompound('Data', str('LevelName', 'Independent Test World'), tag(4, 'RandomSeed', numeric('q', 123456789012345)), integer('GameType', 1), integer('SpawnX', -1), integer('SpawnY', 64), integer('SpawnZ', -1), namedCompound('Player', list('Pos', 6, [numeric('d', -0.5), numeric('d', 65.0), numeric('d', -0.5)]), list('Inventory', 10, [inventoryItem]), integer('playerGameType', 1))));

function chunkNBT(x = -1, z = -1) {
    const blocks = Buffer.alloc(4096), data = Buffer.alloc(2048), add = Buffer.alloc(2048);
    blocks[255] = 57; data[127] = 0x30; add[127] = 0x10;
    const section = compound(byte('Y', 4), array('Blocks', blocks), array('Data', data), array('Add', add));
    return root(namedCompound('Level', integer('xPos', x), integer('zPos', z), list('Sections', 10, [section]), list('Entities', 10, [compound(str('id', 'minecraft:cow'))])));
}

function region(nbt = chunkNBT()) {
    const compressed = deflateSync(nbt);
    const sectors = Math.ceil((compressed.length + 5) / 4096);
    const output = Buffer.alloc((2 + sectors) * 4096);
    output.writeUInt32BE((2 << 8) | sectors, 1023 * 4);
    output.writeUInt32BE(compressed.length + 1, 8192);
    output[8196] = 2; compressed.copy(output, 8197);
    return output;
}

function zip(entries) {
    const generated = spawnSync(python, ['-c', 'import sys,json,base64,zipfile,io\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z:\n for name,data in json.load(sys.stdin): z.writestr(name,base64.b64decode(data))\nsys.stdout.buffer.write(b.getvalue())'], { input: JSON.stringify(entries.map(([name, data]) => [name, data.toString('base64')])), maxBuffer: 8 * 1024 * 1024 });
    assert.equal(generated.status, 0, generated.stderr.toString());
    return generated.stdout;
}

function crc32(data) {
    let crc = 0xffffffff;
    for (const value of data) { crc ^= value; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
}
function uint32(value) { const data = Buffer.alloc(4); data.writeUInt32BE(value); return data; }
function shortText(value) { const data = Buffer.from(value); return bytes([data.length], data); }
function epk(entries, compression = 'G') {
    const head = bytes('HEAD', shortText('file-type'), uint32(13), 'epk/world1122', '>');
    // Each FILE's size includes CRC32 and ':' but excludes its final '>'.
    const records = entries.map(([name, content]) => bytes('FILE', shortText(name), uint32(content.length + 5), uint32(crc32(content)), content, ':>'));
    let payload = bytes(head, ...records, 'END$');
    if (compression === 'G') payload = gzipSync(payload);
    if (compression === 'Z') payload = deflateSync(payload);
    return bytes('EAGPKG$$', shortText('ver2.0'), shortText('fixture.epk'), text('Independent synthetic fixture'), numeric('q', 0), uint32(entries.length + 1), compression, payload, ':::YEE:>');
}

function inspect(data, args = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-export-test-'));
    try {
        const archive = path.join(dir, 'world.bin'); fs.writeFileSync(archive, data);
        const result = spawnSync(python, [script, archive, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
        assert.equal(result.signal, null, result.stderr);
        assert.ok(result.stdout, result.stderr);
        return { code: result.status, result: JSON.parse(result.stdout) };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const fixtureEntries = () => [['World/level.dat', gzipSync(levelNBT())], ['World/region/r.-1.-1.mca', region()]];
function rejected(data, pattern) { const value = inspect(data); assert.equal(value.code, 1); assert.equal(value.result.status, 'error'); assert.match(value.result.error, pattern); }

test('ZIP reads gzip level.dat, signed/long NBT, saved player and inventory independently', () => {
    const { code, result } = inspect(zip(fixtureEntries()), ['--expect-name', 'Independent Test World', '--expect-seed', '123456789012345']);
    assert.equal(code, 0); assert.equal(result.world.RandomSeed, 123456789012345);
    assert.equal(result.format, 'vanilla-zip');
    assert.deepEqual(result.players['level.dat'].Pos, [-0.5, 65, -0.5]);
    assert.deepEqual(result.players['level.dat'].inventory, [{ Slot: 2, id: 'minecraft:diamond', Count: 7, Damage: 0 }]);
});

test('Anvil sector addressing, negative coordinates, Add and Data nibble order, air and absent chunks', () => {
    const { code, result } = inspect(zip(fixtureEntries()), ['--block=-1,64,-1', '--block=-1,65,-1', '--block=-1,80,-1', '--block=0,64,0']);
    assert.equal(code, 0);
    assert.deepEqual(result.block_queries.map(value => [value.block_id, value.metadata]), [[313, 3], [0, 0], [0, 0], [null, null]]);
    assert.equal(result.dimensions.overworld.chunks, 1);
    assert.deepEqual(result.dimensions.overworld.entity_counts, { 'minecraft:cow': 1 });
    assert.deepEqual(result.dimensions.overworld.stored_section_block_counts, { 0: 4095, 313: 1 });
});

test('EPK exact record framing, file CRC and each raw/gzip/zlib payload mode', () => {
    for (const mode of ['0', 'G', 'Z']) {
        const { code, result } = inspect(epk([['level.dat', gzipSync(levelNBT())], ['level0/1CFD5F1CFD5F.dat', gzipSync(chunkNBT())]], mode), ['--block=-1,64,-1']);
        assert.equal(code, 0, JSON.stringify(result));
        assert.equal(result.format, 'epk-world1122'); assert.equal(result.archive.epk.compression, mode);
        assert.equal(result.block_queries[0].block_id, 313);
    }
});

test('NBT raw and zlib wrappers are supported; expectations fail closed', () => {
    for (const data of [levelNBT(), deflateSync(levelNBT())]) assert.equal(inspect(zip([['level.dat', data]])).code, 0);
    assert.equal(inspect(zip(fixtureEntries()), ['--expect-name', 'Wrong World']).code, 1);
    assert.equal(inspect(zip(fixtureEntries()), ['--expect-seed', '7']).code, 1);
});

test('NBT modified UTF-8 combines Java surrogate pairs and decodes modified NUL', () => {
    const name = Buffer.from('54657374eda0bdedb880c080', 'hex');
    const size = Buffer.alloc(2); size.writeUInt16BE(name.length);
    const data = root(namedCompound('Data', tag(8, 'LevelName', bytes(size, name))));
    const { code, result } = inspect(zip([['level.dat', data]]));
    assert.equal(code, 0); assert.equal(result.world.LevelName, 'Test😀\0');
});

test('archive paths, duplicates, malformed ZIP and unsupported formats fail without extraction', () => {
    for (const bad of ['../outside.dat', '/absolute.dat', 'World/../outside.dat', 'World\\outside.dat', 'C:outside.dat', './level.dat', 'World//outside.dat', 'World//']) rejected(zip([['level.dat', levelNBT()], [bad, Buffer.from('bad')]]), /Unsafe/);
    rejected(zip([['level.dat', levelNBT()], ['level.dat', levelNBT()]]), /Duplicate/);
    rejected(zip(fixtureEntries()).subarray(0, -15), /ZIP/);
    rejected(Buffer.from('EAGPKG!!legacy'), /Unsupported/);
});

test('native normalization aliases and C0/C1 controls are rejected without banning internal spaces', () => {
    for (const name of [' ../leak', '.. /leak', 'a/ /b', 'level.dat ', 'a/ padded', 'a/padded ', 'a\x1fb', 'a\x7fb', 'a\x85b', 'a\x9fb']) {
        const entries = [['level.dat', levelNBT()], [name, Buffer.from('opaque')]];
        rejected(epk(entries, '0'), /Unsafe/);
        rejected(zip(entries), /Unsafe/);
    }
    const { code, result } = inspect(zip([['My World/level.dat', levelNBT()]]));
    assert.equal(code, 0); assert.equal(result.level_dat, 'My World/level.dat');
});

test('160 MiB input ceiling rejects oversized sparse files before parsing or decompression', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-export-limit-'));
    try {
        const archive = path.join(dir, 'oversized.epk');
        const fd = fs.openSync(archive, 'w');
        try { fs.ftruncateSync(fd, 160 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
        const result = spawnSync(python, [script, archive], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1); assert.match(JSON.parse(result.stdout).error, /Input exceeds size limit/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ZIP CRC corruption and declared decompression bombs fail', () => {
    const data = zip(fixtureEntries());
    const crc = Buffer.from(data); const central = crc.indexOf(Buffer.from('504b0102', 'hex')); crc[central + 16] ^= 1;
    rejected(crc, /CRC/);
    const huge = Buffer.from(data); huge.writeUInt32LE(64 * 1024 * 1024 + 1, central + 24);
    rejected(huge, /size limit/);
    const symlink = Buffer.from(data); symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    rejected(symlink, /symlink/);
    const encrypted = Buffer.from(data); encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
    rejected(encrypted, /Encrypted/);
    const nullPath = Buffer.from(data); nullPath[central + 46 + 3] = 0;
    rejected(nullPath, /Unsafe/);
    const tooMany = Buffer.from(data), end = tooMany.lastIndexOf(Buffer.from('504b0506', 'hex'));
    tooMany.writeUInt16LE(8193, end + 8); tooMany.writeUInt16LE(8193, end + 10);
    rejected(tooMany, /member count/);
});

test('truncated, corrupt, trailing and oversized NBT compression is rejected', () => {
    const good = gzipSync(levelNBT()), corrupt = Buffer.from(good); corrupt[corrupt.length - 8] ^= 1;
    for (const data of [good.subarray(0, -2), corrupt, bytes(good, 'junk'), gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1))]) rejected(zip([['level.dat', data]]), /compressed|size limit/);
    rejected(zip([['level.dat', bytes(levelNBT(), [0])]]), /Trailing NBT/);
});

test('native gzip capacity padding is accepted only after valid CRC and complete trailer', () => {
    const good = gzipSync(levelNBT()), padded = bytes(good, Buffer.alloc(64));
    assert.equal(inspect(zip([['level.dat', padded]])).code, 0);
    const internal = epk([['level.dat', padded], ['level0/native.dat', bytes(gzipSync(chunkNBT()), Buffer.alloc(32))]], '0');
    const result = inspect(internal, ['--block=-1,64,-1']);
    assert.equal(result.code, 0); assert.equal(result.result.block_queries[0].block_id, 313);
    const badCRC = Buffer.from(padded); badCRC[good.length - 8] ^= 1;
    rejected(zip([['level.dat', badCRC]]), /compressed/);
    rejected(zip([['level.dat', bytes(good.subarray(0, -4), Buffer.alloc(64))]]), /compressed|Truncated/);
    rejected(zip([['level.dat', bytes(good, Buffer.alloc(64), [1])]]), /Trailing/);
    rejected(zip([['level.dat', bytes(deflateSync(levelNBT()), Buffer.alloc(64))]]), /Trailing/);
});

test('all gzip NBT sidecars are checked while unrelated files remain CRC-validated bytes', () => {
    const good = gzipSync(root(integer('value', 7)));
    const entries = [['level.dat', gzipSync(levelNBT())], ['level.dat_old', gzipSync(levelNBT())], ['data/villages.dat', good], ['stats/player.json', Buffer.from('{}')]];
    const result = inspect(epk(entries, '0'));
    assert.equal(result.code, 0); assert.equal(result.result.validation.nbt_members, 3);
    assert.equal(result.result.validation.file_crcs, 4);
    assert.deepEqual(result.result.validation.other_members_sample, ['stats/player.json']);
    entries[2][1] = bytes(good, [1]);
    rejected(epk(entries, '0'), /Trailing/);
});

test('member hash manifest covers exact opaque and zero-padded bytes in sorted archive paths', () => {
    const entries = [['z/opaque.bin', Buffer.from([0, 255, 58, 62])], ['level.dat', bytes(gzipSync(levelNBT()), Buffer.alloc(64))], ['a/empty.bin', Buffer.alloc(0)]];
    const expected = entries.map(([path, data]) => ({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const data of [epk(entries, '0'), epk(entries, 'G'), zip(entries)]) {
        const { code, result } = inspect(data);
        assert.equal(code, 0); assert.deepEqual(result.member_hashes, expected);
        assert.equal(result.member_hashes.length, result.archive.members);
    }
    const unpadded = createHash('sha256').update(gzipSync(levelNBT())).digest('hex');
    assert.notEqual(expected.find(entry => entry.path === 'level.dat').sha256, unpadded);
});

test('NBT malformed tag lengths, duplicate keys and nesting are bounded', () => {
    rejected(zip([['level.dat', root(tag(7, 'bad', numeric('i', -1)))]]), /Truncated/);
    rejected(zip([['level.dat', root(str('a', 'first'), str('a', 'second'))]]), /Duplicate/);
    let deep = compound(); for (let i = 0; i < 70; i++) deep = compound(tag(10, 'child', deep));
    rejected(zip([['level.dat', bytes([10], text(''), deep)]]), /depth/);
    rejected(zip([['level.dat', root(list('bad', 10, []), tag(9, 'huge', bytes([1], numeric('i', 1000001))))]]), /list length/);
});

test('Anvil truncated sectors, overlaps, wrong coordinates and unsupported compression fail', () => {
    for (const mutate of [
        data => data.subarray(0, -1),
        data => { data.writeUInt32BE(0x201, 0); return data; },
        data => { data.writeUInt32BE(8192, 8192); return data; },
        data => { data[8196] = 4; return data; }
    ]) rejected(zip([['level.dat', levelNBT()], ['region/r.-1.-1.mca', mutate(region())]]), /Anvil/);
    rejected(zip([['level.dat', levelNBT()], ['region/r.-1.-1.mca', region(chunkNBT(0, -1))]]), /coordinate/);
});

test('EPK corrupt CRC, record counts, footer and file-type are rejected', () => {
    const valid = epk([['level.dat', levelNBT()]], '0');
    const crc = Buffer.from(valid); const at = crc.indexOf(Buffer.from('FILE')); const sizeAt = at + 5 + Buffer.byteLength('level.dat'); crc[sizeAt + 4] ^= 1;
    rejected(crc, /CRC32/);
    rejected(valid.subarray(0, -1), /header\/footer/);
    const type = Buffer.from(valid); type[type.indexOf(Buffer.from('epk/world1122')) + 11] = 0x38;
    rejected(type, /world1122/);
    const end = Buffer.from(valid); end[end.indexOf(Buffer.from('END$'))] = 0;
    rejected(end, /end marker/);
    rejected(epk([['../level.dat', levelNBT()]], '0'), /Unsafe/);
    rejected(epk([['level.dat', levelNBT()], ['level.dat', levelNBT()]], '0'), /Duplicate/);
});

test('nested decompression shares a cumulative budget across independent members', () => {
    const code = 'import sys,gzip\nenv={"__name__":"inspector"}\nexec(compile(open(sys.argv[1]).read(),sys.argv[1],"exec"),env)\nb=env["Budget"]();b.remaining=16\nenv["inflate"](gzip.compress(b"a"*10),31,budget=b)\ntry: env["inflate"](gzip.compress(b"b"*10),31,budget=b)\nexcept env["InvalidExport"] as e: print(str(e))\nelse: raise AssertionError("Cumulative limit bypassed")';
    const result = spawnSync(python, ['-c', code, script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /size limit/);
});
