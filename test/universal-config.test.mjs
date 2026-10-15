import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('configuration resolves paths from its own directory, never the working directory', async t => {
  const { loadConfig, loadToken } = await import('../bridge/config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'web-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ token: 'offline-fixture-credential-not-real-000000000' }));
  writeFileSync(join(dir, 'bridge.json'), JSON.stringify({ schema: 1, port: 15458, stateDir: 'data', authFile: 'auth.json', providers: [{ type: 'gemini', profileDir: 'browser', models: [{ id: 'fixture', label: 'Fixture' }] }] }));
  const config = loadConfig(join(dir, 'bridge.json'));
  assert.equal(config.stateDir, join(dir, 'data'));
  assert.equal(config.providers[0].profileDir, join(dir, 'browser'));
  assert.match(loadToken(config.authFile), /^offline-fixture-/);
});

test('configuration rejects public binding, conflicting profiles and invalid timeout bounds', async t => {
  const { loadConfig } = await import('../bridge/config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'web-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'bridge.json');
  const base = { schema: 1, providers: [{ type: 'gemini', profileDir: 'browser', models: [{ id: 'fixture', label: 'Fixture' }] }] };
  for (const change of [{ host: '0.0.0.0' }, { limits: { requestTimeoutMs: 0 } }, { providers: [...base.providers, { ...base.providers[0], id: 'second' }] }, { providers: [{ type: 'unknown' }] }]) {
    writeFileSync(file, JSON.stringify({ ...base, ...change }));
    assert.throws(() => loadConfig(file));
  }
});
