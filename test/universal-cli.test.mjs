import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('../web-bridge.mjs', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function port() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function launch(args, cwd) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  const exit = once(child, 'exit');
  return { child, exit, output: () => output };
}

test('CLI initializes credentials without printing them or overwriting them', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'web-cli-init-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const init = launch(['init', '--config', file], dir);
  assert.equal((await init.exit)[0], 0, init.output());
  const token = JSON.parse(readFileSync(join(dir, '.state', 'auth.json'), 'utf8')).token;
  assert.ok(token.length >= 32); assert.equal(init.output().includes(token), false);
  const again = launch(['init', '--config', file], dir);
  assert.notEqual((await again.exit)[0], 0);
  assert.equal(JSON.parse(readFileSync(join(dir, '.state', 'auth.json'), 'utf8')).token, token);
});

test('real CLI starts independently of cwd, refuses duplicates, and shuts down with auth', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'web-cli-live-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = 'offline-fixture-credential-not-real-000000000';
  const p = await port(), url = `http://127.0.0.1:${p}`;
  const file = join(dir, 'config.json');
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ token }));
  writeFileSync(join(dir, 'fixture.mjs'), `export function createAdapter(o) { return {id:o.id,models:o.models,capabilities:{images:false},status:()=>({state:'ready'}),close:async()=>{},generate:async r=>({text:'fixture-only',model:r.model})}; }`);
  writeFileSync(file, JSON.stringify({ schema: 1, host: '127.0.0.1', port: p, stateDir: 'state', authFile: 'auth.json', providers: [{ type: 'module', id: 'fixture', modulePath: 'fixture.mjs', models: [{ id: 'fixture' }] }] }));
  const running = launch(['serve', '--config', file], dir); t.after(() => { if (running.child.exitCode === null) running.child.kill(); });
  let health;
  for (let i = 0; i < 80 && !health; i++) { await sleep(50); try { health = await (await fetch(`${url}/health`)).json(); } catch {} if (running.child.exitCode !== null) break; }
  assert.equal(health?.service, 'chatweb-bridge', running.output());
  assert.equal(health.pid, running.child.pid);
  const duplicate = launch(['serve', '--config', file], dir);
  assert.notEqual((await duplicate.exit)[0], 0, 'occupied port must not spawn another browser or kill the owner');
  assert.equal((await (await fetch(`${url}/health`)).json()).instanceId, health.instanceId);
  const response = await fetch(`${url}/admin/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 202);
  assert.equal((await running.exit)[0], 0);
  assert.equal(running.output().includes(token), false);
});
