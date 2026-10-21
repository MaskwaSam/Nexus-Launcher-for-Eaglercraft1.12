#!/usr/bin/env python3
"""Repair Bootstrap-before-DataFixer ordering in the two reviewed game bundles.

No source rebuild is available. This intentionally accepts only the recorded
baseline/output bytes and preserves every other method, data segment and asset.
TeaVM debug encoding reference (Apache-2.0): official konsoletyper/teavm,
core/src/main/java/org/teavm/backend/wasm/debug/parser/DebugLinesParser.java,
commit cfc0ce2a9874a4ce38b48adb90bc91ca0e755289.
"""
import argparse
import base64
import hashlib
import json
import lzma
import os
import stat
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import zlib

if not __debug__:
    raise RuntimeError('This byte repair requires enabled Python assertions; remove -O/PYTHONOPTIMIZE')

PATTERN = rb'data:application/octet-stream;base64,(RUFHJFdBU0[A-Za-z0-9+/=]*)'
OLD_JS = b'switch($p){case 0:b=new BkS;'
NEW_JS = b'switch($p){case 0:$p=108;case 108:Fgk();if(B()){break _;}b=new BkS;'
# These identify the entire reviewed input/output, including the earlier touch fix.
BASE_EPW = '93d386bb781b8428625b49248aa07fb1e61b66fd053d972e38cecf324e78c886'
OUTPUT_EPW = '856faef3c5a11fbcf05cfb87fcaf5c92f0776b7200925dd062277621f543d11d'
# A later bounded profile repair preserves the complete bootstrap fix. Its
# independent inverse/forward proof recovers OUTPUT_EPW exactly.
USERNAME_OUTPUT_EPW = '1a675662fe90ef02c7559d3b4d6506179afb3e4aacdcf0ebb16faa84bdfc8f30'
BASE_JS_FUNC = 'bad2d111aa8922dda94666ae40c2ae394cf648f195f79a1d05dcd435c5d1c1ce'


def sha(b):
    return hashlib.sha256(b).hexdigest()


def read32(b, p):
    return struct.unpack_from('<I', b, p)[0]


def u(b, p):
    v = shift = 0
    while True:
        a = b[p]
        p += 1
        v |= (a & 127) << shift
        if a < 128:
            return v, p
        shift += 7
        assert shift < 35


def read_uleb_value(b, p):
    return u(b, p)[0]


def leb(v, width=0):
    out = bytearray()
    while True:
        a = v & 127
        v >>= 7
        out.append(a | (128 if v or len(out) + 1 < width else 0))
        if not v and len(out) >= width:
            return bytes(out)


def sections(b, start=8):
    out = {}
    p = start
    while p < len(b):
        st = p
        k = b[p]
        n, p = u(b, p + 1)
        assert k not in out
        out[k] = (st, p, p + n)
        p += n
    assert p == len(b)
    return out


def tdbg_sections(b):
    assert b[:5] == b'tdbg\x01'
    p = 5
    out = {}
    while p < len(b):
        n, p = u(b, p)
        name = b[p:p + n].decode()
        p += n
        size_at = p
        n, p = u(b, p)
        out[name] = (size_at, p, p + n)
        p += n
    assert p == len(b)
    return out


def lines(b):
    """Return lossless TeaVM commands with their post-command absolute address."""
    p = address = depth = 0
    out = []
    while p < len(b):
        st = p
        op = b[p]
        p += 1
        v = None
        if op in (0, 2, 3, 4):
            v, p = u(b, p)
        if op == 0:
            depth += 1
        elif op == 1:
            depth -= 1
            assert depth >= 0
        elif op == 4:
            address += v
        elif op >= 10:
            address += (op - 10) % 32
        else:
            assert op in (2, 3)
        out.append((st, p, op, v, address, depth))
    assert depth == 0
    return out


def val(b, p):
    k = b[p]
    p += 1
    if k in (0x63, 0x64):
        _, p = u(b, p)  # signed heap type: byte length is the same
    return p


def type_one(b, p):
    k = b[p]
    p += 1
    if k in (0x4f, 0x50):
        n, p = u(b, p)
        for _ in range(n):
            _, p = u(b, p)
        k = b[p]
        p += 1
    if k == 0x60:
        args, results = [], []
        for dest in (args, results):
            n, p = u(b, p)
            for _ in range(n):
                q = val(b, p)
                dest.append(b[p:q].hex())
                p = q
        return p, ('func', args, results)
    if k == 0x5f:
        n, p = u(b, p)
        for _ in range(n):
            p = val(b, p) + 1
    else:
        assert k == 0x5e
        p = val(b, p) + 1
    return p, ('other',)


def inspect_wasm(b, debug):
    sec = sections(b)
    # This reviewed module imports functions only.
    p = sec[2][1]
    imports, p = u(b, p)
    for _ in range(imports):
        for _ in range(2):
            n, p = u(b, p)
            p += n
        assert b[p] == 0
        _, p = u(b, p + 1)
    assert p == sec[2][2]
    p = sec[3][1]
    n, p = u(b, p)
    function_types = []
    for _ in range(n):
        t, p = u(b, p)
        function_types.append(t)
    assert p == sec[3][2]
    p = sec[1][1]
    n, p = u(b, p)
    types = []
    for _ in range(n):
        count = 1
        if b[p] == 0x4e:
            count, p = u(b, p + 1)
        for _ in range(count):
            p, t = type_one(b, p)
            types.append(t)
    assert p == sec[1][2]
    p = sec[10][1]
    n, p = u(b, p)
    assert n == len(function_types)
    bodies = []
    for _ in range(n):
        prefix = p
        n, p = u(b, p)
        bodies.append((prefix, p, p + n))
        p += n
    assert p == sec[10][2]
    ds = tdbg_sections(debug)
    def pairs(name):
        _, p, end = ds[name]
        out = []
        while p < end:
            a, p = u(debug, p)
            c, p = u(debug, p)
            out.append((a, c))
        assert p == end
        return out
    _, p, end = ds['teavm_str']
    strings = []
    while p < end:
        n, p = u(debug, p)
        strings.append(debug[p:p + n].decode())
        p += n
    classes = pairs('teavm_cls')
    methods = pairs('teavm_mtd')
    named = {}
    for i, (cls, name) in enumerate(methods):
        class_name = strings[classes[cls][1]]
        if (class_name, strings[name]) in (('DataFixesManager', 'createFixer'), ('Bootstrap', 'register')):
            named[class_name] = i
    assert named == {'DataFixesManager': 6003, 'Bootstrap': 8285}
    _, p, end = ds['teavm_line']
    commands = lines(debug[p:end])
    targets = {}
    for c in commands:
        if c[2] == 0 and c[3] in named.values() and c[5] == 1:
            found = [(i, x) for i, x in enumerate(bodies) if x[0] <= c[4] < x[2]]
            assert len(found) == 1
            i, body = found[0]
            targets[c[3]] = (i + imports, body, types[function_types[i]], function_types[i])
    assert targets[6003][0] == 4889 and targets[8285][0] == 6553
    assert targets[8285][2] == ('func', [], [])
    assert targets[6003][2] == ('func', [], ['63a80d'])
    return sec, ds, commands, bodies, targets


def patch_wasm(b, debug):
    sec, ds, commands, bodies, targets = inspect_wasm(b, debug)
    prefix, body, end = targets[6003][1]
    p = body
    n, p = u(b, p)
    for _ in range(n):
        _, p = u(b, p)
        p = val(b, p)
    insertion = p
    assert insertion == 1882256
    call = b'\x10' + leb(targets[8285][0])
    assert call.hex() == '109933'
    result = bytearray(b[:insertion] + call + b[insertion:])
    assert body - prefix == 4
    result[prefix:body] = leb(end - body + len(call), 4)
    st, begin, code_end = sec[10]
    assert begin - st == 5
    result[st + 1:begin] = leb(code_end - begin + len(call), 4)
    # Preserve every original function body; only createFixer gains one call.
    for i, (a, q, z) in enumerate(bodies):
        shift = len(call) if a > prefix else 0
        expected = b[q:insertion] + call + b[insertion:z] if a == prefix else b[q:z]
        assert result[q + shift:z + shift + (len(call) if a == prefix else 0)] == expected
    assert result[:st] == b[:st]
    assert result[code_end + len(call):] == b[code_end:]
    size_at, start, stop = ds['teavm_line']
    line = debug[start:stop]
    # TeaVM is delta encoded: adjust only the first advance crossing insertion.
    # TeaVM records module instruction addresses minus one (also true of
    # every method sequence start); shift original first-instruction metadata.
    debug_insertion = insertion - 1
    crossing = next(c for c in commands if c[4] >= debug_insertion)
    a, z, op, v, _, _ = crossing
    crossing_offset = a
    assert op == 4
    replacement = b'\x04' + leb(v + len(call)) if op == 4 else b'\x04' + leb(len(call)) + line[a:z]
    new_line = line[:a] + replacement + line[z:]
    fixed_debug = debug[:size_at] + leb(len(new_line)) + new_line + debug[stop:]
    old_events = [(c[2], c[3], c[4], c[5]) for c in commands if c[2] != 4]
    new_events = [(c[2], c[3], c[4], c[5]) for c in lines(new_line) if c[2] != 4]
    assert new_events == [(op, v, addr + (len(call) if addr >= debug_insertion else 0), depth) for op, v, addr, depth in old_events]
    # Independently undo the native edit and metadata delta from output bytes.
    reverse = bytearray(result)
    assert reverse[insertion:insertion + len(call)] == call
    del reverse[insertion:insertion + len(call)]
    reverse[prefix:body] = leb(read_uleb_value(reverse, prefix) - len(call), 4)
    reverse[st + 1:begin] = leb(read_uleb_value(reverse, st + 1) - len(call), 4)
    assert bytes(reverse) == b
    reverse_ds = tdbg_sections(fixed_debug)
    reverse_size, reverse_start, reverse_stop = reverse_ds['teavm_line']
    reverse_line = fixed_debug[reverse_start:reverse_stop]
    reverse_command = next(c for c in lines(reverse_line) if c[4] >= debug_insertion)
    r_a, r_z, r_op, r_value, _, _ = reverse_command
    assert r_op == 4
    reverse_line = reverse_line[:r_a] + b'\x04' + leb(r_value - len(call)) + reverse_line[r_z:]
    reverse_debug = fixed_debug[:reverse_size] + leb(len(reverse_line)) + reverse_line + fixed_debug[reverse_stop:]
    assert reverse_debug == debug
    # All non-line debug sections remain byte-identical.
    fixed_sections = tdbg_sections(fixed_debug)
    for name, (_, a, z) in ds.items():
        if name != 'teavm_line':
            _, q, r = fixed_sections[name]
            assert debug[a:z] == fixed_debug[q:r]
    return bytes(result), fixed_debug, {'function': 4889, 'function_type': 8363, 'bootstrap_function': 6553, 'bootstrap_type': 2036, 'insert_offset': insertion, 'insert_hex': call.hex(), 'body_size_before': end-body, 'body_size_after': end-body+len(call), 'debug_crossing_command_offset': crossing_offset, 'reverse_wasm_and_debug_exact_original_bytes': True, 'all_other_function_bodies_identical': True, 'all_original_debug_events_remapped': len(old_events)}


def compress(b):
    return lzma.compress(b, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC32, filters=[{'id': lzma.FILTER_LZMA2, 'dict_size': 32*1024*1024, 'lc': 3, 'lp': 0, 'pb': 2, 'mode': lzma.MODE_NORMAL, 'nice_len': 64, 'mf': lzma.MF_BT4, 'depth': 0}])


def patch_epw(payload):
    assert payload[:8] == b'EAG$WASM'
    assert read32(payload, 8) == len(payload)
    assert read32(payload, 12) == zlib.crc32(payload[16:]) & 0xffffffff
    assert sha(payload) == BASE_EPW
    def component(at):
        p, n, raw = (read32(payload, at + d) for d in (0, 4, 8))
        b = lzma.decompress(payload[p:p+n])
        assert len(b) == raw
        return b
    wasm, debug = component(228), component(244)
    new_wasm, new_debug, evidence = patch_wasm(wasm, debug)
    result = bytearray(payload)
    for at, content in ((244, new_debug), (228, new_wasm)):
        p, n = read32(result, at), read32(result, at+4)
        packed = compress(content)
        delta = len(packed) - n
        result[p:p+n] = packed
        for later in (228, 244, 260, 292, 324):
            if read32(result, later) >= p+n:
                struct.pack_into('<I', result, later, read32(result, later)+delta)
        struct.pack_into('<II', result, at+4, len(packed), len(content))
    struct.pack_into('<I', result, 8, len(result))
    struct.pack_into('<I', result, 12, zlib.crc32(result[16:]) & 0xffffffff)
    for at in (196, 212, 260, 292, 324):
        old_p, old_n = read32(payload, at), read32(payload, at+4)
        new_p, new_n = read32(result, at), read32(result, at+4)
        assert old_n == new_n and payload[old_p:old_p+old_n] == result[new_p:new_p+new_n]
    evidence.update({'wasm_before_sha256': sha(wasm), 'wasm_after_sha256': sha(new_wasm), 'debug_before_sha256': sha(debug), 'debug_after_sha256': sha(new_debug), 'payload_before_sha256': sha(payload), 'payload_after_sha256': sha(result), 'other_epw_components_identical': True})
    with tempfile.NamedTemporaryFile(suffix='.wasm') as f:
        f.write(new_wasm)
        f.flush()
        check = subprocess.run([os.environ.get('NEXUS_NODE_EXECUTABLE', 'node'), '-e', 'const fs=require("fs");if(!WebAssembly.validate(fs.readFileSync(process.argv[1])))process.exit(1)', f.name], check=False)
        assert check.returncode == 0, 'Native WebAssembly.validate rejected patched module'
    evidence['node_webassembly_validate'] = True
    return bytes(result), evidence


def atomic_write(path, content):
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.native-import-', delete=False) as temporary:
            temporary_name = temporary.name
            temporary.write(content)
        os.chmod(temporary_name, stat.S_IMODE(path.stat().st_mode))
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            os.unlink(temporary_name)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = ap.parse_args()
    js_path = args.root / 'gamefile.html'
    js = js_path.read_bytes()
    start = js.index(b'function G8g()')
    end = js.index(b'\nfunction ', start+1)
    f = js[start:end]
    if NEW_JS in f:
        baseline = f.replace(NEW_JS, OLD_JS, 1)
    else:
        assert f.count(OLD_JS) == 1
        baseline = f
    assert sha(baseline) == BASE_JS_FUNC
    new_js = js[:start] + baseline.replace(OLD_JS, NEW_JS, 1) + js[end:]
    path = args.root / 'gamefilebetter.html'
    html = path.read_bytes()
    matches = list(re.finditer(PATTERN, html))
    assert len(matches) == 1
    match = matches[0]
    payload = base64.b64decode(match[1], validate=True)
    if sha(payload) in (OUTPUT_EPW, USERNAME_OUTPUT_EPW):
        print(json.dumps({'status': 'already_repaired', 'payload_sha256': sha(payload), 'js_repaired': f != baseline}))
        assert f != baseline
        return
    output, evidence = patch_epw(payload)
    assert sha(output) == OUTPUT_EPW
    evidence['js_function_before_sha256'] = sha(baseline)
    evidence['js_function_after_sha256'] = sha(baseline.replace(OLD_JS, NEW_JS, 1))
    evidence['status'] = 'repaired' if args.apply else 'verified_repair_required'
    if args.apply:
        atomic_write(js_path, new_js)
        atomic_write(path, html[:match.start(1)] + base64.b64encode(output) + html[match.end(1):])
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
