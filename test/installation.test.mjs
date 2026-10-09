import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { patchRuntime } from '../scripts/patch-runtime.mjs';
import { exportSource } from '../scripts/export-source.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-install-fixture-'));
  const installed = join(root, 'runtime/node_modules/@minzicat/pi-chatgpt-web-adapter');
  mkdirSync(join(installed, 'dist'), { recursive: true });
  mkdirSync(join(root, 'patches'));
  const pkg = '{"name":"@minzicat/pi-chatgpt-web-adapter","version":"0.1.1"}\n';
  writeFileSync(join(installed, 'package.json'), pkg);
  writeFileSync(join(installed, 'dist/example.js'), 'old\n');
  const patch = 'diff --git a/dist/example.js b/dist/example.js\n--- a/dist/example.js\n+++ b/dist/example.js\n@@ -1 +1 @@\n-old\n+new\n';
  writeFileSync(join(root, 'patches/change.patch'), patch);
  const manifest = { schema: 1, upstream: { package: '@minzicat/pi-chatgpt-web-adapter', version: '0.1.1' },
    patch: { file: 'patches/change.patch', sha256: hash(patch) },
    inputFiles: { 'package.json': hash(pkg), 'dist/example.js': hash('old\n') },
    outputFiles: { 'package.json': hash(pkg), 'dist/example.js': hash('new\n') },
  };
  const save = () => writeFileSync(join(root, 'patches/adapter-manifest.json'), JSON.stringify(manifest));
  save();
  return { root, installed, manifest, save, value: () => readFileSync(join(installed, 'dist/example.js'), 'utf8') };
}

test('clean reconstruction verifies output and repeat invocation performs verification only', () => {
  const f = fixture();
  assert.equal(patchRuntime(f.root).status, 'patched-and-verified');
  assert.equal(f.value(), 'new\n');
  assert.equal(patchRuntime(f.root).status, 'verified');
  assert.equal(patchRuntime(f.root, { verifyOnly: true }).status, 'verified');
});

test('complete patch adds new runtime modules and verifies their bytes', () => {
  const f = fixture();
  const patchPath = join(f.root, 'patches/change.patch');
  const patch = readFileSync(patchPath, 'utf8') + 'diff --git a/dist/new.js b/dist/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/dist/new.js\n@@ -0,0 +1 @@\n+fixture\n';
  writeFileSync(patchPath, patch);
  f.manifest.patch.sha256 = hash(patch);
  f.manifest.outputFiles['dist/new.js'] = hash('fixture\n'); f.save();
  assert.equal(patchRuntime(f.root).status, 'patched-and-verified');
  assert.equal(readFileSync(join(f.installed, 'dist/new.js'), 'utf8'), 'fixture\n');
});

test('unknown input and additional files are refused without modifying the installed tree', () => {
  const f = fixture();
  writeFileSync(join(f.installed, 'dist/example.js'), 'user-edit\n');
  assert.throws(() => patchRuntime(f.root), /neither pristine/);
  assert.equal(f.value(), 'user-edit\n');
  writeFileSync(join(f.installed, 'dist/example.js'), 'old\n');
  writeFileSync(join(f.installed, 'unexpected.private'), 'synthetic-data');
  assert.throws(() => patchRuntime(f.root), /neither pristine/);
  assert.equal(f.value(), 'old\n');
});

test('verification refuses an unpatched input and tampered patch before writes', () => {
  const f = fixture();
  assert.throws(() => patchRuntime(f.root, { verifyOnly: true }), /does not match/);
  writeFileSync(join(f.root, 'patches/change.patch'), 'tampered');
  assert.throws(() => patchRuntime(f.root), /digest mismatch/);
  assert.equal(f.value(), 'old\n');
});

test('incorrect output hash leaves the installed pristine package intact', () => {
  const f = fixture();
  f.manifest.outputFiles['dist/example.js'] = hash('wrong'); f.save();
  assert.throws(() => patchRuntime(f.root), /output digest mismatch/);
  assert.equal(f.value(), 'old\n');
});

test('a parent Git checkout does not redirect patch application outside staging', () => {
  const f = fixture();
  assert.equal(spawnSync('git', ['init', '--quiet', f.root], { windowsHide: true }).status, 0);
  assert.equal(patchRuntime(f.root).status, 'patched-and-verified');
  assert.equal(existsSync(join(f.root, 'dist/example.js')), false);
  assert.equal(f.value(), 'new\n');
});

test('export includes only allowlisted source and independent output hashes', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'source.mjs'), 'export const fixture = true;\n');
  writeFileSync(join(f.root, 'release-files.json'), JSON.stringify({ files: ['source.mjs', 'release-files.json'] }));
  mkdirSync(join(f.root, '.runtime')); writeFileSync(join(f.root, '.runtime/private.log'), 'synthetic-not-for-release');
  const dest = join(f.root, 'export');
  assert.equal(exportSource(f.root, dest).files, 2);
  assert.equal(existsSync(join(dest, '.runtime')), false);
  const sums = JSON.parse(readFileSync(join(dest, 'SOURCE-SHA256.json')));
  assert.equal(sums['source.mjs'], hash(readFileSync(join(dest, 'source.mjs'))));
  assert.throws(() => exportSource(f.root, dest), /must not exist/);
});

test('unsafe export manifest is refused before destination creation', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'release-files.json'), JSON.stringify({ files: ['../outside.txt'] }));
  const dest = join(f.root, 'export');
  assert.throws(() => exportSource(f.root, dest), /Unsafe relative/);
  assert.equal(existsSync(dest), false);
});

test('export refuses a directory junction to outside source', () => {
  const f = fixture(), other = fixture();
  symlinkSync(other.root, join(f.root, 'linked'), 'junction');
  writeFileSync(join(f.root, 'release-files.json'), JSON.stringify({ files: ['linked/patches/change.patch'] }));
  assert.throws(() => exportSource(f.root, join(f.root, 'export')), /ordinary source/);
});

test('fresh installer refuses existing scratch junction before configuration or dependency writes', { skip: process.platform !== 'win32' }, () => {
  const outside = mkdtempSync(join(tmpdir(), 'bridge-user-fixture-'));
  // Use a genuinely fresh source root; the fixture's runtime dependencies must not mask .build refusal.
  const root = mkdtempSync(join(tmpdir(), 'bridge-preflight-fixture-'));
  copyFileSync(new URL('../install.ps1', import.meta.url), join(root, 'install.ps1'));
  writeFileSync(join(outside, 'empty-user.npmrc'), 'synthetic-user-data');
  symlinkSync(outside, join(root, '.build'), 'junction');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'install.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fresh checkout/);
  assert.equal(readFileSync(join(outside, 'empty-user.npmrc'), 'utf8'), 'synthetic-user-data');
  assert.equal(existsSync(join(root, 'node_modules')), false);
});

test('fresh installer rejects a runtime junction before npm can write into another project', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-runtime-boundary-'));
  const outside = mkdtempSync(join(tmpdir(), 'bridge-other-project-'));
  copyFileSync(new URL('../install.ps1', import.meta.url), join(root, 'install.ps1'));
  writeFileSync(join(outside, 'package.json'), '{"name":"synthetic-other-project"}\n');
  symlinkSync(outside, join(root, 'runtime'), 'junction');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'install.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ordinary directory/);
  assert.equal(existsSync(join(outside, 'node_modules')), false);
  assert.equal(existsSync(join(root, '.build')), false);
});
