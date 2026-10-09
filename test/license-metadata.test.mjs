import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSource } from '../scripts/export-source.mjs';
import { verifyLicense } from '../scripts/verify-license.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'bridge-license-fixture-')), 'source');
  exportSource(project, root);
  return root;
}
function editJson(root, name, mutate) {
  const path = join(root, name);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

test('current original MIT notice and metadata agree without clearing third-party redistribution', () => {
  const result = verifyLicense(project);
  assert.equal(result.author, 'うんけん');
  assert.equal(result.copyrightYear, 2026);
  assert.equal(result.originalContributionsLicense, 'MIT');
  assert.equal(result.upstreamNoticeStatus, 'unresolved');
  assert.equal(result.publicRedistributionCleared, false);
  assert.equal(result.networkRequests, 0);
});

test('fresh allowlisted export includes license validation and regenerates its checksum list', () => {
  const root = fixture();
  const release = JSON.parse(readFileSync(join(root, 'release-files.json'), 'utf8'));
  const sums = JSON.parse(readFileSync(join(root, 'SOURCE-SHA256.json'), 'utf8'));
  assert.deepEqual(Object.keys(sums).sort(), [...release.files].sort());
  assert.ok(release.files.includes('scripts/verify-license.mjs'));
  assert.ok(release.files.includes('test/license-metadata.test.mjs'));
  assert.ok(release.files.includes('INSTALL.zh-CN.md'));
  assert.equal(verifyLicense(root).sourceFiles, release.files.length);
});

test('a different original copyright notice is rejected', () => {
  const root = fixture(), path = join(root, 'LICENSE');
  writeFileSync(path, readFileSync(path, 'utf8').replace('うんけん', 'Synthetic fixture attribution'));
  assert.throws(() => verifyLicense(root), /Original MIT notice/);
});

test('adding a restriction to the standard MIT grant is rejected', () => {
  const root = fixture(), path = join(root, 'LICENSE');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nSynthetic extra restriction.\n');
  assert.throws(() => verifyLicense(root), /standard permission/);
});

test('package author drift is rejected', () => {
  const root = fixture();
  editJson(root, 'package.json', value => { value.author.name = 'Synthetic fixture attribution'; });
  assert.throws(() => verifyLicense(root), /Package author/);
});

test('bridge lockfile license drift is rejected', () => {
  const root = fixture();
  editJson(root, 'package-lock.json', value => { value.packages[''].license = 'UNLICENSED'; });
  assert.throws(() => verifyLicense(root), /bridge package[/]lock license/);
});

test('runtime dependency version drift is rejected', () => {
  const root = fixture();
  editJson(root, 'runtime/package.json', value => { value.dependencies['@minzicat/pi-chatgpt-web-adapter'] = '0.1.2'; });
  assert.throws(() => verifyLicense(root), /runtime package[/]lock dependencies/);
});

test('runtime adapter integrity drift is rejected', () => {
  const root = fixture();
  editJson(root, 'runtime/package-lock.json', value => { value.packages['node_modules/@minzicat/pi-chatgpt-web-adapter'].integrity = 'synthetic-integrity'; });
  assert.throws(() => verifyLicense(root), /Adapter runtime lock[/]provenance/);
});

test('provenance cannot silently reference a different integrity value', () => {
  const root = fixture();
  editJson(root, 'third-party/adapter-provenance.json', value => { value.integrity = 'synthetic-integrity'; });
  assert.throws(() => verifyLicense(root), /Adapter provenance integrity/);
});

test('removing the adapter patch exclusion is rejected', () => {
  const root = fixture();
  editJson(root, 'LICENSE-SCOPE.json', value => { delete value.excludedFiles['patches/adapter-0.1.1-to-runtime-v4.patch']; });
  assert.throws(() => verifyLicense(root), /Third-party exclusion missing/);
});

test('a new original source file cannot be omitted from the scope', () => {
  const root = fixture();
  editJson(root, 'LICENSE-SCOPE.json', value => { value.originalContributionFiles = value.originalContributionFiles.filter(name => name !== 'scripts/verify-license.mjs'); });
  assert.throws(() => verifyLicense(root), /scope must cover exactly/);
});

test('duplicate original scope entries are rejected', () => {
  const root = fixture();
  editJson(root, 'LICENSE-SCOPE.json', value => { value.originalContributionFiles.push(value.originalContributionFiles[0]); });
  assert.throws(() => verifyLicense(root), /scope list must be unique/);
});

test('adapter-derived material cannot be added to the original grant', () => {
  const root = fixture();
  editJson(root, 'LICENSE-SCOPE.json', value => { value.originalContributionFiles.push('patches/adapter-0.1.1-to-runtime-v4.patch'); });
  assert.throws(() => verifyLicense(root), /Third-party exclusion missing or regranted/);
});

test('bridge dependency metadata must agree with its root lockfile', () => {
  const root = fixture();
  editJson(root, 'package.json', value => { value.dependencies.ajv = '^0.0.0'; });
  assert.throws(() => verifyLicense(root), /bridge package[/]lock dependencies/);
});
