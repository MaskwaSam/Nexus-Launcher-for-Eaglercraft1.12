'use strict';
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

for (const name of [
  'test_js_bootstrap_suspends_before_allocation_and_resumes',
  'test_wasm_reproduces_exact_reviewed_payload',
]) {
  test(name, { timeout: 180000 }, () => {
    execFileSync(process.env.NEXUS_PYTHON_EXECUTABLE || 'python3', [
      '-B',
      path.join(__dirname, 'native-import-repair.test.py'),
      `NativeImportRepair.${name}`,
    ], { cwd: path.join(__dirname, '..'), stdio: 'pipe', timeout: 170000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', NEXUS_NODE_EXECUTABLE: process.execPath },
    });
  });
}
