(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.EpkImportGuard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    // Covers the launcher's 128 MiB snapshot budget plus all 8191 member
    // names/framing and compression overhead, without accepting unbounded input.
    const LIMITS = Object.freeze({ inputBytes: 160 * 1024 * 1024, payloadBytes: 256 * 1024 * 1024, memberBytes: 64 * 1024 * 1024, records: 8192 });
    const installed = new WeakMap();
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let n = 0; n < 8; n++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); table[i] = c >>> 0; }
    function requireValue(ok, message) { if (!ok) throw new Error(message); }
    function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = (c >>> 8) ^ table[(c ^ b) & 255]; return (c ^ 0xffffffff) >>> 0; }
    function safeName(name) {
        // Native F6t trims each segment with Java String.trim (<= U+0020)
        // before resolving '.'/'..'. Reject aliases before that normalization.
        requireValue(name && !/[\\:\x00-\x1f\x7f-\x9f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..' && part === part.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')), 'Unsafe EPK filename');
        return name;
    }
    function safeDefaultName(filename) {
        requireValue(typeof filename === 'string', 'Invalid EPK filename');
        // FuK/Dww populate the initially enabled native world-name field by
        // stripping a case-sensitive extension, then truncating to 32 UTF-16
        // code units. Fbq later applies Java trim. A blank default would make
        // the native import root empty, even with safe archive member paths.
        const stem = filename.length > 4 && (filename.endsWith('.epk') || filename.endsWith('.zip')) ? filename.slice(0, -4) : filename;
        const initial = stem.slice(0, 32), trimmed = initial.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
        requireValue(initial === trimmed && !/[\/\\]/.test(initial), 'Unsafe EPK default world name');
        safeName(trimmed);
        // GEd substitutes these characters before F6t interprets the path.
        // Validate that effective default as one segment as well. This gate
        // does not inspect later manual edits to the game's canvas text field.
        safeName(trimmed.replace(/[./"]/g, '_'));
    }
    class Reader {
        constructor(bytes) { this.bytes = bytes; this.at = 0; }
        take(size) { requireValue(Number.isSafeInteger(size) && size >= 0 && size <= this.bytes.length - this.at, 'Truncated EPK'); const out = this.bytes.subarray(this.at, this.at + size); this.at += size; return out; }
        number(size) { const b = this.take(size); let n = 0; for (const value of b) n = n * 256 + value; return n; }
        text(size) { let out = ''; for (const b of this.take(size)) out += String.fromCharCode(b); return out; }
        text8() { return this.text(this.number(1)); }
        expect(text) { requireValue(this.text(text.length) === text, 'Invalid EPK framing'); }
    }
    async function inflate(bytes, format, limit) {
        requireValue(typeof DecompressionStream === 'function', 'This browser cannot safely validate compressed EPK files');
        const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
        const chunks = []; let size = 0;
        try {
            while (true) {
                const part = await reader.read(); if (part.done) break;
                size += part.value.byteLength;
                requireValue(size <= limit, 'EPK decompressed size exceeds limit');
                chunks.push(part.value);
            }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        const out = new Uint8Array(size); let at = 0;
        for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
        return out;
    }
    // Matches the bundled C3W/DG7 decoder: Latin-1 text8, outer EOF outside
    // compression, and FILE length includes the CRC32 and ':' sentinel.
    async function validate(value, options = {}) {
        const limits = { ...LIMITS, ...options.limits };
        for (const key of Object.keys(LIMITS)) requireValue(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= LIMITS[key], 'Invalid EPK limit');
        let bytes;
        if (value && typeof value.arrayBuffer === 'function') {
            safeDefaultName(value.name);
            requireValue(Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= limits.inputBytes, 'EPK input size exceeds limit');
            bytes = new Uint8Array(await value.arrayBuffer());
            requireValue(bytes.byteLength === value.size, 'EPK file size changed');
        } else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') bytes = new Uint8Array(value);
        else throw new Error('Expected an EPK File or bytes');
        requireValue(bytes.length <= limits.inputBytes, 'EPK input size exceeds limit');
        // Take a private copy before the first decompression await.
        bytes = bytes.slice();
        const outer = new Reader(bytes); outer.expect('EAGPKG$$');
        const version = outer.text8(); requireValue(version.startsWith('ver2.'), 'Unsupported EPK version');
        outer.text8(); outer.take(outer.number(2)); outer.take(8);
        const count = outer.number(4); requireValue(count <= limits.records, 'EPK record count exceeds limit');
        const compression = outer.text(1);
        requireValue(['0', 'G', 'Z'].includes(compression), 'Unsupported EPK compression');
        const compressed = outer.take(bytes.length - outer.at - 8); outer.expect(':::YEE:>');
        const payload = compression === '0' ? compressed : await inflate(compressed, compression === 'G' ? 'gzip' : 'deflate', limits.payloadBytes);
        requireValue(payload.length <= limits.payloadBytes, 'EPK decompressed size exceeds limit');
        const stream = new Reader(payload), names = new Set(), headers = new Set(); let files = 0;
        for (let i = 0; i < count; i++) {
            const tag = stream.text(4), name = safeName(stream.text8()), size = stream.number(4);
            requireValue(size <= limits.memberBytes + (tag === 'FILE' ? 5 : 0), 'EPK member size exceeds limit');
            if (tag === 'FILE') {
                requireValue(!names.has(name), 'Duplicate EPK filename'); names.add(name);
                requireValue(size >= 5, 'Invalid EPK FILE length');
                const checksum = stream.number(4), content = stream.take(size - 5);
                stream.expect(':'); requireValue(crc32(content) === checksum, 'EPK FILE CRC32 mismatch'); files++;
            } else if (tag === 'HEAD') {
                requireValue(!headers.has(name), 'Duplicate EPK header'); headers.add(name); stream.take(size);
            } else throw new Error('Unsupported EPK record tag');
            stream.expect('>');
        }
        stream.expect('END$'); requireValue(stream.at === payload.length, 'Invalid EPK record count or trailing data');
        return Object.freeze({ version, compression, records: count, files });
    }
    function install(frameWindow, options = {}) {
        const doc = frameWindow.document;
        if (installed.has(doc)) return installed.get(doc);
        const states = new WeakMap(), replayEvents = new WeakSet(); let active = null, generation = 0, disposed = false, statusNode;
        const picker = input => input && input.tagName === 'INPUT' && input.type === 'file' && String(input.accept).trim().toLowerCase() === '.epk';
        const mobile = input => input.closest('._eaglercraftX_mobile_file_chooser_popup');
        const status = (state, message) => {
            try {
                if (options.onStatus) options.onStatus({ state, message });
                else {
                    if (!statusNode) { statusNode = doc.createElement('div'); statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite'); statusNode.style.cssText = 'position:fixed;bottom:8px;left:8px;max-width:90%;padding:6px 10px;background:#18212c;color:white;font:14px sans-serif;z-index:2147483647;pointer-events:none'; doc.body.appendChild(statusNode); }
                    statusNode.textContent = message; statusNode.hidden = !message;
                }
            } catch (_) { /* Status presentation must not affect the safety gate. */ }
        };
        const invalidate = () => { generation++; active = null; };
        const current = state => {
            // WindowProxy survives navigation, and a retained old input can
            // stay connected to its old Document. Never replay into that game.
            try { return !disposed && frameWindow.document === doc && state.generation === generation && active === state && state.input.isConnected && state.input.files[0] === state.file; }
            catch (_) { return false; } // The frame may have navigated cross-origin.
        };
        function replay(state, target, type) {
            if (!current(state) || !target.isConnected) return;
            const event = new frameWindow.Event(type, { bubbles: true, cancelable: true });
            replayEvents.add(event); target.dispatchEvent(event); replayEvents.delete(event);
        }
        function begin(input) {
            const existing = states.get(input), file = input.files[0];
            if (existing && current(existing)) return existing;
            invalidate();
            const state = { input, file, generation, done: null, valid: false }; active = state; states.set(input, state);
            if (!file) return state;
            status('pending', 'Checking EPK file…');
            state.promise = validate(file).then(() => {
                if (!current(state)) return;
                state.valid = true; status('ready', '');
                if (state.done) { const done = state.done; state.done = null; replay(state, done, 'click'); }
                else if (!mobile(input)) replay(state, input, 'change');
            }, error => {
                if (!current(state)) return;
                input.value = ''; state.file = undefined;
                status('error', 'EPK import blocked: ' + error.message);
                // The native engine resumes its waiting importer on an empty
                // change/Done, whereas its cancel event is ignored.
                replay(state, state.done || input, state.done ? 'click' : 'change');
            });
            return state;
        }
        function onChange(event) {
            if (replayEvents.delete(event)) return;
            const input = event.target; if (!picker(input)) return;
            invalidate();
            if (!input.files[0]) { status('idle', ''); return; }
            event.stopImmediatePropagation(); event.preventDefault(); begin(input);
        }
        function onClick(event) {
            if (replayEvents.delete(event)) return;
            const target = event.target;
            if (!target || typeof target.closest !== 'function') return;
            const done = target.closest('._eaglercraftX_mobile_file_chooser_btn_done');
            if (done) {
                const popup = done.closest('._eaglercraftX_mobile_file_chooser_popup'), input = popup && popup.querySelector('input[type="file"]');
                if (!picker(input) || !input.files[0]) return;
                event.stopImmediatePropagation(); event.preventDefault();
                const state = begin(input);
                if (state.valid) replay(state, done, 'click'); else state.done = done;
            } else if (picker(target) || target.closest('._eaglercraftX_mobile_file_chooser_btn_cancel')) { invalidate(); status('idle', ''); }
        }
        function onCancel(event) { if (picker(event.target)) { invalidate(); status('idle', ''); } }
        doc.addEventListener('change', onChange, true); doc.addEventListener('click', onClick, true); doc.addEventListener('cancel', onCancel, true);
        const observer = new frameWindow.MutationObserver(records => {
            if (!active) return;
            const abandon = () => { const pending = !active.valid && active.file; invalidate(); if (pending) status('idle', ''); };
            for (const record of records) {
                for (const node of record.removedNodes) if (node === active.input || node.contains && node.contains(active.input)) { abandon(); return; }
                for (const node of record.addedNodes) if (node !== active.input && (picker(node) || node.querySelectorAll && Array.from(node.querySelectorAll('input[type="file"]')).some(picker))) { abandon(); return; }
            }
        });
        observer.observe(doc.documentElement, { subtree: true, childList: true });
        const control = Object.freeze({ dispose() { disposed = true; invalidate(); observer.disconnect(); doc.removeEventListener('change', onChange, true); doc.removeEventListener('click', onClick, true); doc.removeEventListener('cancel', onCancel, true); if (statusNode) statusNode.remove(); installed.delete(doc); } });
        installed.set(doc, control); return control;
    }
    return Object.freeze({ LIMITS, validate, install });
}));
