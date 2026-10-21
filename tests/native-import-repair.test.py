#!/usr/bin/env python3
"""Verify the frozen native startup repair without requiring Git history.

Requires only Python stdlib and a Node release supporting the bundled GC
module. Git enables an additional full historical replay. No browser, network, world/archive fixtures, or game save edits.
"""
import base64
import importlib.util
import json
import lzma
import os
import sys
import tempfile
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASE = '68d67066f13e4c4b688596e7d95b68f40ff0494b'
sys.dont_write_bytecode = True
NODE = os.environ.get('NEXUS_NODE_EXECUTABLE', 'node')
BASE_JS_SHA256 = 'd787592f6bd51b9732373992db0f72753e48177570e973626ca9eaf5f524bdfc'
BASE_WASM_SHA256 = '38cbb6c21bb15d5f7d2911a588b61e1fa224d442fd4663465afa0351f5deed4d'
BASE_DEBUG_SHA256 = 'd9e3de56cf7061df22ac5676766c0ffb2d7cef82a102f5fb79085639c216eb57'
spec = importlib.util.spec_from_file_location('repair', ROOT / 'scripts/repair-native-import.py')
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def optional_original(path):
    try:
        return subprocess.check_output(
            ['git', 'show', BASE + ':' + path], cwd=ROOT, stderr=subprocess.DEVNULL)
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None


class NativeImportRepair(unittest.TestCase):
    def test_wasm_reproduces_exact_reviewed_payload(self):
        new_html = (ROOT / 'gamefilebetter.html').read_bytes()
        matches = list(re.finditer(repair.PATTERN, new_html))
        self.assertEqual(len(matches), 1)
        new_match = matches[0]
        payload = base64.b64decode(new_match[1], validate=True)
        self.assertEqual(repair.sha(payload), repair.OUTPUT_EPW)
        self.assertEqual(repair.read32(payload, 8), len(payload))
        self.assertEqual(repair.read32(payload, 12), repair.zlib.crc32(payload[16:]) & 0xffffffff)

        def component(at):
            p, n = repair.read32(payload, at), repair.read32(payload, at+4)
            result = lzma.decompress(payload[p:p+n])
            self.assertEqual(len(result), repair.read32(payload, at+8))
            return result

        wasm, debug = component(228), component(244)
        # Independently reverse the narrowly specified output edit, rather than
        # obtaining an original module from Git. Frozen hashes prove the entire
        # reconstructed code/data/debug bytes match the reviewed baseline.
        sec = repair.sections(wasm)
        self.assertEqual(wasm[1882256:1882259], bytes.fromhex('109933'))
        self.assertEqual(wasm[1882184:1882188], bytes.fromhex('ad898000'))
        self.assertEqual(repair.u(wasm, sec[10][0]+1)[0], 6068134)
        original_wasm = bytearray(wasm)
        del original_wasm[1882256:1882259]
        original_wasm[1882184:1882188] = repair.leb(1194, 4)
        original_wasm[sec[10][0]+1:sec[10][1]] = repair.leb(6068131, 4)
        original_wasm = bytes(original_wasm)
        self.assertEqual(repair.sha(original_wasm), BASE_WASM_SHA256)
        ds = repair.tdbg_sections(debug)
        _, start, stop = ds['teavm_line']
        line = debug[start:stop]
        self.assertEqual(line[179964:179966], bytes.fromhex('0447'))
        original_debug = bytearray(debug)
        original_debug[start+179965] = 68
        original_debug = bytes(original_debug)
        self.assertEqual(repair.sha(original_debug), BASE_DEBUG_SHA256)
        forward_wasm, forward_debug, evidence = repair.patch_wasm(original_wasm, original_debug)
        self.assertEqual(forward_wasm, wasm)
        self.assertEqual(forward_debug, debug)
        self.assertTrue(evidence['reverse_wasm_and_debug_exact_original_bytes'])
        with tempfile.NamedTemporaryFile(suffix='.wasm') as f:
            f.write(wasm)
            f.flush()
            subprocess.run([NODE, '-e',
                'const fs=require("fs");if(!WebAssembly.validate(fs.readFileSync(process.argv[1])))process.exit(1)',
                f.name], check=True)
        # Historical EPW recompression is extra coverage when the object exists;
        # all mandatory current-payload, inverse/forward and native checks above
        # run in shallow checkouts and distribution copies as well.
        old_html = optional_original('gamefilebetter.html')
        if old_html is not None:
            old_match = re.search(repair.PATTERN, old_html)
            output, replay_evidence = repair.patch_epw(base64.b64decode(old_match[1], validate=True))
            self.assertEqual(output, payload)
            self.assertEqual(old_html[:old_match.start(1)], new_html[:new_match.start(1)])
            self.assertEqual(old_html[old_match.end(1):], new_html[new_match.end(1):])
            self.assertTrue(replay_evidence['node_webassembly_validate'])
        evidence['historical_epw_replay_available'] = old_html is not None
        evidence['native_validate'] = True
        print(json.dumps(evidence, sort_keys=True))

    def test_js_bootstrap_suspends_before_allocation_and_resumes(self):
        new = (ROOT / 'gamefile.html').read_bytes()
        start = new.index(b'function G8g()')
        end = new.index(b'\nfunction ', start+1)
        fixed = new[start:end]
        self.assertEqual(fixed.count(repair.NEW_JS), 1)
        self.assertEqual(fixed.count(repair.OLD_JS), 0)
        f = fixed.replace(repair.NEW_JS, repair.OLD_JS, 1)
        self.assertEqual(repair.sha(f), repair.BASE_JS_FUNC)
        old = new[:start] + f + new[end:]
        self.assertEqual(repair.sha(old), BASE_JS_SHA256)
        self.assertEqual(new, old[:start] + f.replace(repair.OLD_JS, repair.NEW_JS, 1) + old[start+len(f):])
        # Exercise the actual generated function's first two resumable states.
        harness = r'''
const assert=require('node:assert/strict');
let suspended=false, resuming=false, stack=[], calls=0, allocations=0, hqk=0;
function FZ(){return resuming;}
function Ds(){return {l(){return stack.pop()},s(...v){stack=v;resuming=true}}}
function B(){return suspended;}
function Fgk(){calls++;suspended=calls===1;}
function BkS(){assert.equal(calls,2);allocations++;}
function Hqk(){hqk++;suspended=true;}
function FV(){throw Error('unexpected state');}
'''
        harness += fixed.decode() + r'''
G8g();assert.equal(calls,1);assert.equal(allocations,0);assert.equal(stack.at(-1),108);
G8g();assert.equal(calls,2);assert.equal(allocations,1);assert.equal(hqk,1);assert.equal(stack.at(-1),1);
'''
        subprocess.run([NODE, '-e', harness], check=True)


if __name__ == '__main__':
    unittest.main()
