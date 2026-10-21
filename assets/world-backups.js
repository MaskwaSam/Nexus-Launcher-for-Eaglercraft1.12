/* Read-only native saved-world backups. No runtime globals or database writes. */
(function (root, factory) {
    'use strict';
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.NexusWorldBackups = api;
}(typeof window === 'object' ? window : globalThis, function (root) {
    'use strict';
    const DATABASE = '_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_12_2_';
    const STORE = 'filesystem';
    const LIMITS = Object.freeze({ files: 8191, fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 });
    function requireValue(value, message) { if (!value) throw new Error(message); }
    function worldId(value) {
        requireValue(typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\\/:\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..', 'Invalid saved-world ID');
        return value;
    }
    function relativePath(value) {
        requireValue(typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f\x7f-\x9f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && part[0] !== ' ' && part[part.length - 1] !== ' '), 'Unsafe saved-world path');
        return value;
    }
    function fileBytes(value) {
        requireValue(value instanceof ArrayBuffer || value instanceof Uint8Array, 'Invalid saved-world file data');
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        requireValue(bytes.byteLength <= LIMITS.fileBytes, 'Saved-world file exceeds backup size limit');
        return bytes;
    }
    function validateFiles(files) {
        requireValue(Array.isArray(files) && files.length > 0 && files.length <= LIMITS.files, 'Invalid saved-world file count');
        const names = new Set(); let total = 0;
        const result = files.map(file => {
            const path = relativePath(file.path), data = fileBytes(file.data);
            requireValue(!names.has(path), 'Duplicate saved-world file'); names.add(path);
            total += data.byteLength;
            requireValue(total <= LIMITS.totalBytes, 'Saved world exceeds backup size limit');
            return { path, data };
        });
        requireValue(names.has('level.dat'), 'Saved world has no level.dat; finish saving it before backing up');
        return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    }
    function openDatabase() {
        return new Promise((resolve, reject) => {
            const idb = root && root.indexedDB;
            if (!idb) { reject(new Error('Saved-world storage is unavailable')); return; }
            let request, missing = false, refused = false;
            try { request = idb.open(DATABASE); } catch (error) { reject(error); return; }
            request.onupgradeneeded = () => {
                missing = true;
                // Opening a nonexistent DB would create it; abort the upgrade instead.
                request.transaction.abort();
            };
            request.onerror = () => reject(new Error(missing ? 'No saved-world database exists yet' : 'Could not open saved-world storage'));
            request.onblocked = () => { refused = true; reject(new Error('Saved-world storage is busy; close other game tabs and retry')); };
            request.onsuccess = () => {
                const db = request.result;
                if (refused) { db.close(); return; }
                if (missing) { db.close(); reject(new Error('No saved-world database exists yet')); return; }
                if (!db.objectStoreNames.contains(STORE)) { db.close(); reject(new Error('Unrecognized saved-world database')); return; }
                db.onversionchange = () => db.close();
                resolve(db);
            };
        });
    }
    async function readRecords(visit) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            let tx, failure;
            const fail = error => { failure = error; try { tx.abort(); } catch (_) { /* already finished */ } };
            try {
                tx = db.transaction(STORE, 'readonly');
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onabort = tx.onerror = () => { db.close(); reject(failure || new Error('Could not read saved-world snapshot')); };
                const request = tx.objectStore(STORE).openCursor();
                request.onsuccess = () => {
                    try {
                        const cursor = request.result;
                        if (cursor) { visit(cursor.value); cursor.continue(); }
                    } catch (error) { fail(error); }
                };
            } catch (error) { db.close(); reject(error); }
        });
    }
    async function listWorlds() {
        const ids = new Set();
        await readRecords(record => {
            // A complete level.dat is the native world's durable metadata file.
            if (record && typeof record.path === 'string') {
                const match = /^eaglercraft\/worlds\/([^/]+)\/level\.dat$/.exec(record.path);
                if (match) ids.add(worldId(match[1]));
            }
        });
        return Array.from(ids).sort().map(id => ({ id, name: id }));
    }
    async function snapshotWorld(id) {
        worldId(id);
        const prefix = 'eaglercraft/worlds/' + id + '/', files = []; let total = 0;
        await readRecords(record => {
            if (!record || typeof record.path !== 'string' || !record.path.startsWith(prefix)) return;
            const path = relativePath(record.path.slice(prefix.length)), bytes = fileBytes(record.data);
            total += bytes.byteLength;
            requireValue(files.length < LIMITS.files && total <= LIMITS.totalBytes, 'Saved world exceeds backup size limit');
            files.push({ path, data: bytes.slice() });
        });
        return { id, name: id, files: validateFiles(files), capturedAt: Date.now() };
    }
    const crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let n = 0; n < 8; n++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); crcTable[i] = c >>> 0; }
    function crc32(bytes) { let c = 0xffffffff; for (const value of bytes) c = (c >>> 8) ^ crcTable[(c ^ value) & 255]; return (c ^ 0xffffffff) >>> 0; }
    function latin1(value) {
        requireValue(value.length <= 255 && Array.from(value).every(char => char.charCodeAt(0) <= 255), 'Native EPK path cannot be represented without loss');
        return Uint8Array.from(value, char => char.charCodeAt(0));
    }
    function safeFilename(id) { return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'world'; }
    function encodeEpk(snapshot) {
        requireValue(snapshot && typeof snapshot === 'object', 'Invalid saved-world snapshot');
        worldId(snapshot.id);
        const files = validateFiles(snapshot.files), filename = safeFilename(snapshot.id) + '.epk';
        const names = files.map(file => latin1(file.path));
        const comment = new TextEncoder().encode('Nexus native Eaglercraft 1.12.2 world backup');
        const archiveName = latin1(filename), version = latin1('ver2.0'), type = latin1('epk/world1122');
        const size = 8 + 1 + version.length + 1 + archiveName.length + 2 + comment.length + 8 + 4 + 1 + 4 + 1 + 9 + 4 + type.length + 1 + 4 + 8 + files.reduce((sum, file, i) => sum + 4 + 1 + names[i].length + 4 + 4 + file.data.length + 2, 0);
        const bytes = new Uint8Array(size), view = new DataView(bytes.buffer); let at = 0;
        const raw = data => { bytes.set(data, at); at += data.length; };
        const ascii = value => raw(Uint8Array.from(value, char => char.charCodeAt(0)));
        const u32 = value => { view.setUint32(at, value, false); at += 4; };
        const str8 = data => { bytes[at++] = data.length; raw(data); };
        ascii('EAGPKG$$'); str8(version); str8(archiveName);
        view.setUint16(at, comment.length, false); at += 2; raw(comment);
        const timestamp = Number.isSafeInteger(snapshot.capturedAt) && snapshot.capturedAt >= 0 ? snapshot.capturedAt : Date.now();
        view.setUint32(at, Math.floor(timestamp / 0x100000000), false); view.setUint32(at + 4, timestamp >>> 0, false); at += 8;
        u32(files.length + 1); ascii('0'); // Native decoder supports uncompressed EPK payloads.
        ascii('HEAD'); str8(latin1('file-type')); u32(type.length); raw(type); ascii('>');
        files.forEach((file, i) => { ascii('FILE'); str8(names[i]); u32(file.data.length + 5); u32(crc32(file.data)); raw(file.data); ascii(':>'); });
        ascii('END$'); ascii(':::YEE:>');
        requireValue(at === bytes.length, 'Internal EPK size mismatch');
        return { filename, bytes, blob: new Blob([bytes], { type: 'application/octet-stream' }), world: { id: snapshot.id, name: snapshot.name || snapshot.id, fileCount: files.length, byteLength: files.reduce((sum, file) => sum + file.data.length, 0) } };
    }
    return Object.freeze({ DATABASE, LIMITS, listWorlds, snapshotWorld, encodeEpk, crc32 });
}));
