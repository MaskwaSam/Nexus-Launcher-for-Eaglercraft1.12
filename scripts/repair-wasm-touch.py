#!/usr/bin/env python3
"""Apply or verify the bounded native-tap repair in this bundled WASM host.

The compiled game ignores queued touch events. Let the browser produce its
native compatibility mouse events for taps, as the JS edition already does.
Only the canvas touchstart/touchend preventDefault calls are removed. No DOM
mouse events are fabricated, and touchmove/keyboard-zone cancellation remains.
"""

import argparse
import base64
import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import stat
import struct
import tempfile
import zlib

BASE_PAYLOAD_SHA256 = "1d8bbadb6afd5f8cfed2961c8c0ba8349a183e0960ac9dec1beee19b8cb1742e"
BASE_HOST_SHA256 = "af9165310c1abb4ab3a9b77f954f52703cb3b5ae9c4b763a0457f4358b6d8b7a"
REPAIRED_PAYLOAD_SHA256 = "93d386bb781b8428625b49248aa07fb1e61b66fd053d972e38cecf324e78c886"
# The later import-bootstrap repair preserves this complete host component.
# Accept only its frozen output as well; historical --apply output stays exact.
IMPORT_REPAIRED_PAYLOAD_SHA256 = "856faef3c5a11fbcf05cfb87fcaf5c92f0776b7200925dd062277621f543d11d"
PAYLOAD_PATTERN = rb"data:application/octet-stream;base64,(RUFHJFdBU0[A-Za-z0-9+/=]*)"
DOWNSTREAM_OFFSETS = (228, 244, 260, 292, 324)
PATCHES = tuple(
    (prefix + b"m.preventDefault();m.stopPropagation();", prefix + b"m.stopPropagation();")
    for prefix in (
        b'R.addEventListener("touchstart",pb=function(m){',
        b'R.addEventListener("touchend",qb=function(m){',
    )
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="apply to the exact reviewed baseline; otherwise verify")
    parser.add_argument("--file", type=Path, default=Path(__file__).resolve().parents[1] / "gamefilebetter.html")
    args = parser.parse_args()
    html = args.file.read_bytes()
    matches = list(re.finditer(PAYLOAD_PATTERN, html))
    if len(matches) != 1:
        raise ValueError("Expected exactly one embedded EPW payload")
    match = matches[0]
    payload = base64.b64decode(match[1], validate=True)
    if payload[:8] != b"EAG$WASM" or read32(payload, 8) != len(payload):
        raise ValueError("Invalid EPW signature or length")
    if read32(payload, 12) != zlib.crc32(payload[16:]) & 0xffffffff:
        raise ValueError("EPW checksum mismatch")
    start, size, raw_size = (read32(payload, offset) for offset in (212, 216, 220))
    if not 384 <= start < start + size <= len(payload):
        raise ValueError("Host component bounds are invalid")
    host = lzma.decompress(payload[start:start + size], format=lzma.FORMAT_XZ)
    if len(host) != raw_size:
        raise ValueError("Host component length mismatch")
    if all(host.count(after) == 1 and host.count(before) == 0 for before, after in PATCHES):
        restored = host
        for before, after in PATCHES:
            restored = restored.replace(after, before, 1)
        if sha256(restored) != BASE_HOST_SHA256:
            raise ValueError("Patched host contains changes beyond the two reviewed call removals")
        if sha256(payload) not in (REPAIRED_PAYLOAD_SHA256, IMPORT_REPAIRED_PAYLOAD_SHA256):
            raise ValueError("Repaired payload differs from the complete reviewed output")
        print(json.dumps({"status": "already_repaired", "host_sha256": sha256(host), "payload_sha256": sha256(payload), "epw_bytes": len(payload), "crc32": hex(read32(payload, 12))}))
        return 0
    if sha256(payload) != BASE_PAYLOAD_SHA256 or sha256(host) != BASE_HOST_SHA256:
        raise ValueError("Payload differs from the reviewed baseline; refusing to patch")
    repaired = host
    for before, after in PATCHES:
        if repaired.count(before) != 1:
            raise ValueError("Expected one canvas handler for each reviewed replacement")
        repaired = repaired.replace(before, after, 1)
    if not args.apply:
        print(json.dumps({"status": "repair_required", "original_host_sha256": sha256(host), "repaired_host_sha256": sha256(repaired)}))
        return 1
    compressed = lzma.compress(repaired, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC32, filters=[{
        "id": lzma.FILTER_LZMA2, "dict_size": 32 * 1024 * 1024,
        "lc": 3, "lp": 0, "pb": 2, "mode": lzma.MODE_NORMAL,
        "nice_len": 64, "mf": lzma.MF_BT4, "depth": 0,
    }])
    old_end = start + size
    delta = len(compressed) - size
    result = bytearray(payload[:start] + compressed + payload[old_end:])
    for offset in DOWNSTREAM_OFFSETS:
        if read32(payload, offset) < old_end:
            raise ValueError("Unexpected downstream component offset")
        struct.pack_into("<I", result, offset, read32(payload, offset) + delta)
    struct.pack_into("<I", result, 216, len(compressed))
    struct.pack_into("<I", result, 220, len(repaired))
    struct.pack_into("<I", result, 8, len(result))
    struct.pack_into("<I", result, 12, zlib.crc32(result[16:]) & 0xffffffff)
    allowed_header_bytes = {offset + index for offset in (8, 12, 216, 220, *DOWNSTREAM_OFFSETS) for index in range(4)}
    if any(result[index] != payload[index] for index in range(384) if index not in allowed_header_bytes):
        raise ValueError("Unexpected EPW header change")
    if result[384:start] != payload[384:start] or result[start + len(compressed):] != payload[old_end:]:
        raise ValueError("Bytes outside the host component changed")
    if lzma.decompress(compressed) != repaired:
        raise ValueError("Repacked host failed readback verification")
    if sha256(result) != REPAIRED_PAYLOAD_SHA256:
        raise ValueError("Compressor output differs from the reviewed payload; review before updating its expected hash")
    updated_html = html[:match.start(1)] + base64.b64encode(result) + html[match.end(1):]
    with tempfile.NamedTemporaryFile(dir=args.file.parent, prefix=".wasm-touch-", delete=False) as temporary:
        temporary.write(updated_html)
        temporary_name = temporary.name
    os.chmod(temporary_name, stat.S_IMODE(args.file.stat().st_mode))
    os.replace(temporary_name, args.file)
    print(json.dumps({"status": "repaired", "host_sha256": sha256(repaired), "payload_sha256": sha256(result), "epw_bytes": len(result), "crc32": hex(read32(result, 12)), "host_bytes": len(repaired), "xz_bytes": len(compressed), "other_component_bytes_preserved": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
