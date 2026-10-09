import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const [name, expected] of [
  ['foreign-install', { failed: true, registered: 0, removed: 0 }],
  ['foreign-remove', { failed: true, registered: 0, removed: 0 }],
  ['owned-install', { failed: false, registered: 1, removed: 0 }],
  ['owned-remove', { failed: false, registered: 0, removed: 1 }],
  ['missing-install', { failed: false, registered: 1, removed: 0 }],
  ['missing-remove', { failed: false, registered: 0, removed: 0 }],
  ['lookup-error', { failed: true, registered: 0, removed: 0 }],
]) test(`autostart ${name} preserves checkout ownership`, { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./fixtures/autostart-ownership.ps1', import.meta.url)), '-Case', name,
    '-ScriptPath', fileURLToPath(new URL('../install-autostart.ps1', import.meta.url))],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
