#!/usr/bin/env python3
"""Mandatory frozen output and inverse/forward proof; no Git history required."""
import base64
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
from unittest import mock

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('repair_explicit_usernames', root/'scripts/repair-explicit-usernames.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
html = (root/'gamefilebetter.html').read_bytes()
matches = list(re.finditer(u.r.PATTERN,html))
assert len(matches) == 1
output = base64.b64decode(matches[0][1],validate=True)
u.verify_payload(output,u.OUTPUT_EPW)
original = u.undo_epw(output)
u.verify_payload(original,u.BASE_EPW)
replay,_,_ = u.apply_epw(original)
assert replay == output
js = (root/'gamefile.html').read_bytes()
assert u.r.sha(js) == u.OUTPUT_JS
original_js = u.undo_js(js)
assert u.r.sha(original_js) == u.BASE_JS
assert u.patch_js(original_js) == js
# The preceding native-import fix remains exactly recoverable, including its
# compiled body, metadata and previously repaired EPW packaging.
assert u.r.sha(u.component(original,228)) == u.BASE_WASM
assert u.r.sha(u.component(original,244)) == u.BASE_DEBUG
# Boundary checks fail closed, including valid but unrelated modified modules.
for mutate,func in ((bytearray(js),u.undo_js),(bytearray(output),u.undo_epw)):
    mutate[-1] ^= 1
    try:
        func(bytes(mutate))
    except AssertionError:
        pass
    else:
        raise AssertionError('Unreviewed bytes were accepted')
print(json.dumps({'native_validate':True,'exact_js_inverse_forward':True,'exact_epw_inverse_forward':True,
    'native_import_checkpoint_recovered':True,'input_epw':u.BASE_EPW,'output_epw':u.OUTPUT_EPW},sort_keys=True))

# Simulate an interrupted second atomic write, then prove the mixed pair can
# resume. Default verification diagnoses mixed state and exits nonzero.
with tempfile.TemporaryDirectory(prefix='explicit-usernames-pair-') as temp:
    folder = Path(temp)
    old_html = html[:matches[0].start(1)] + base64.b64encode(original) + html[matches[0].end(1):]
    (folder/'gamefile.html').write_bytes(original_js)
    (folder/'gamefilebetter.html').write_bytes(old_html)
    real_write = u.r.atomic_write
    calls = []
    def interrupted_write(path, content):
        calls.append(path.name)
        if len(calls) == 2:
            raise OSError('Simulated second-write failure')
        return real_write(path,content)
    def invoke(*flags):
        with mock.patch.object(sys,'argv',['repair-explicit-usernames.py','--root',str(folder),*flags]):
            return u.main()
    with mock.patch.object(u.r,'atomic_write',interrupted_write):
        try:
            invoke('--apply')
        except OSError as error:
            assert str(error) == 'Simulated second-write failure'
        else:
            raise AssertionError('Second-write failure was not exercised')
    assert calls == ['gamefile.html','gamefilebetter.html']
    assert (folder/'gamefile.html').read_bytes() == js
    assert (folder/'gamefilebetter.html').read_bytes() == old_html
    try:
        invoke()
    except SystemExit as error:
        assert error.code == 1
    else:
        raise AssertionError('Mixed verification claimed completion')
    invoke('--apply')
    assert (folder/'gamefile.html').read_bytes() == js
    assert (folder/'gamefilebetter.html').read_bytes() == html
    # Restore only JS first, then undo the remaining native output.
    (folder/'gamefile.html').write_bytes(original_js)
    invoke('--apply','--undo')
    assert (folder/'gamefile.html').read_bytes() == original_js
    assert (folder/'gamefilebetter.html').read_bytes() == old_html
    # The opposite mixed pair must also complete in either direction.
    (folder/'gamefilebetter.html').write_bytes(html)
    invoke('--apply')
    assert (folder/'gamefile.html').read_bytes() == js
    (folder/'gamefilebetter.html').write_bytes(old_html)
    invoke('--apply','--undo')
    assert (folder/'gamefile.html').read_bytes() == original_js
    assert (folder/'gamefilebetter.html').read_bytes() == old_html
print(json.dumps({'mixed_pair_apply_undo':True,'second_atomic_write_failure_recovered':True}))
