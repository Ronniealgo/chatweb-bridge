import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const windows = process.platform === 'win32';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'test/fixtures/universal-windows.ps1');
const ps = windows ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe';
const scratch = process.env.TMPDIR || tmpdir();
const pause = ms => new Promise(r => setTimeout(r, ms));
function sandbox(t, extra = {}) {
  const dir = mkdtempSync(join(scratch, 'chatweb-windows-'));
  const repo = join(dir, 'checkout with spaces');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  for (const file of ['universal-windows.ps1', 'universal-supervisor.ps1']) {
    const path = join(root, 'scripts', file);
    assert.ok(existsSync(path), `${file} must exist`);
    cpSync(path, join(repo, 'scripts', file));
  }
  cpSync(join(root, 'test/fixtures/universal-windows-node.mjs'), join(repo, 'web-bridge.mjs'));
  const config = join(dir, 'bridge config.json');
  const stateDir = join(dir, 'state');
  const authFile = join(dir, 'auth.json');
  writeFileSync(authFile, JSON.stringify({ token: 'fixture-private-value-0000000000000000' }));
  writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 54321, stateDir, authFile, providers: [], ...extra }));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, repo, config, stateDir, authFile, cleanups };
}
function invoke(mode, box, args = [], timeout = 20000) {
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture,
    '-Mode', mode, '-Root', box.repo, '-Config', box.config, '-Node', process.execPath, ...args],
  { encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout.trim());
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(![1456, 1457, 1458, 9200].includes(port));
  return port;
}
async function until(check, timeout = 20000, detail = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(150);
  }
  assert.fail(`Timed out waiting for ${detail}`);
}
function jsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('real hidden supervisor restarts a crashed child, bounds logs, and honors stop marker', { skip: !windows, timeout: 60000 }, async t => {
  const port = await freePort();
  const box = sandbox(t, { port, fixture: { crashOnce: true, logs: true } });
  const launched = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(box.repo, 'scripts/universal-supervisor.ps1'), '-ConfigPath', box.config, '-NodePath', process.execPath,
    '-LogMaxBytes', '32768', '-LogKeepFiles', '2'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  launched.stdout.on('data', value => { diagnostics += value; });
  launched.stderr.on('data', value => { diagnostics += value; });
  const exited = new Promise(resolve => launched.once('exit', (code, signal) => resolve({ code, signal })));
  const launchesPath = join(box.stateDir, 'fixture-launches.jsonl');
  const launches = () => existsSync(launchesPath) ? readFileSync(launchesPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  box.cleanups.push(async () => {
    t.diagnostic(JSON.stringify({ launches: launches(), owner: jsonFile(join(box.stateDir, 'windows-owner.json')), diagnostics }));
    mkdirSync(box.stateDir, { recursive: true });
    writeFileSync(join(box.stateDir, 'windows-stop.request'), 'fixture cleanup');
    await Promise.race([exited, pause(30000)]);
    if (launched.exitCode === null) launched.kill();
    for (const item of launches()) if (alive(item.pid)) process.kill(item.pid);
  });
  const records = await until(() => {
    assert.equal(launched.exitCode, null, diagnostics);
    const records = launches();
    return records.length >= 2 ? records : null;
  }, 25000, 'real crash restart');
  assert.equal(records.length, 2);
  assert.notEqual(records[0].pid, records[1].pid);
  assert.ok(records[1].at - records[0].at >= 1800, 'crash restart must back off');
  const health = await until(async () => {
    try { const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); return health.pid === records[1].pid && health; } catch { return null; }
  });
  assert.equal(health.service, 'chatweb-bridge');
  const owner = await until(() => {
    const owner = jsonFile(join(box.stateDir, 'windows-owner.json'));
    return owner?.child?.pid === records[1].pid && owner;
  });
  assert.equal(owner.configPath, box.config);
  assert.equal(owner.supervisor.pid, launched.pid);
  assert.ok(owner.child.creationTimeUtc);
  assert.ok(owner.child.commandLine.includes(box.config));
  assert.equal(owner.child.configPath, box.config);
  await until(() => existsSync(join(box.stateDir, 'logs/stdout.log.2')) && existsSync(join(box.stateDir, 'logs/stderr.log.2')));
  const logFiles = readdirSync(join(box.stateDir, 'logs'));
  assert.ok(logFiles.length <= 6);
  const token = JSON.parse(readFileSync(box.authFile, 'utf8')).token;
  for (const file of logFiles) {
    const path = join(box.stateDir, 'logs', file);
    assert.ok(statSync(path).size <= 32768, `${file} exceeds log bound`);
    assert.ok(!readFileSync(path, 'utf8').includes(token), 'private token must be redacted');
  }
  writeFileSync(join(box.stateDir, 'windows-stop.request'), 'stop');
  const end = await Promise.race([exited, pause(30000).then(() => ({ code: 'timeout' }))]);
  assert.equal(end.code, 0, diagnostics);
  assert.equal(alive(records[1].pid), false);
  assert.ok(existsSync(join(box.stateDir, 'fixture-shutdowns.jsonl')), 'stop prefers authenticated graceful shutdown');
  await pause(1500);
  assert.equal(launches().length, 2, 'stop must not restart the child');
});

test('owned manager starts once, distinguishes readiness, stops, and uninstalls only its shortcut', { skip: !windows }, t => {
  const result = invoke('tasks', sandbox(t), ['-Case', 'owned-lifecycle']);
  assert.equal(result.failure, null);
  assert.equal(result.started, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.shortcut, null);
  assert.equal(result.lifecycle[0].running, true);
  assert.equal(result.lifecycle[1].alreadyRunning, true);
  assert.equal(result.lifecycle[2].browserReady, false);
  assert.equal(result.lifecycle[3].stopped, true);
});

test('Windows scripts parse on PowerShell 5.1 and library loading is inert', { skip: !windows }, t => {
  const box = sandbox(t);
  const result = invoke('context', box);
  assert.equal(result.parseErrors, 0);
  assert.equal(result.hasState, false, 'reading config must not create runtime files');
  assert.equal(result.configPath, box.config);
  assert.equal(result.scriptPath, join(box.repo, 'web-bridge.mjs'));
  assert.equal(result.nodePath, process.execPath);
  assert.deepEqual(result.args, [process.execPath, join(box.repo, 'web-bridge.mjs'), 'serve', '--config', box.config]);
  assert.match(result.configId, /^[a-f0-9]{64}$/);
});

test('Install is idempotent, limited, hidden, IgnoreNew, and creates a real safe .lnk', { skip: !windows }, t => {
  const box = sandbox(t);
  const result = invoke('tasks', box, ['-Case', 'install']);
  assert.equal(result.failure, null);
  assert.equal(result.registered, 1);
  assert.equal(result.started, 0, 'Install must not launch a service');
  assert.equal(result.task.Principal.RunLevel, 'Limited');
  assert.equal(result.task.Principal.LogonType, 'Interactive');
  assert.equal(result.task.Settings.MultipleInstances, 'IgnoreNew');
  assert.equal(result.task.Settings.ExecutionTimeLimit, '00:00:00');
  assert.equal(result.task.Settings.Hidden, true);
  assert.match(result.task.Actions[0].Arguments, /-WindowStyle Hidden/);
  assert.ok(result.task.Actions[0].Arguments.includes(join(box.repo, 'scripts/universal-supervisor.ps1')));
  assert.ok(result.shortcut.Arguments.includes('-Action Start'));
  assert.match(result.shortcut.Arguments, /-WindowStyle Hidden/);
  assert.ok(!JSON.stringify(result).includes(readFileSync(box.authFile, 'utf8')));
});

for (const field of ['action', 'description']) for (const action of ['Install', 'Start', 'Stop', 'Status', 'Uninstall']) {
  test(`foreign task ${field} refuses ${action} without side effects`, { skip: !windows }, t => {
    const result = invoke('tasks', sandbox(t), ['-Case', `foreign-${field}-${action}`]);
    assert.match(result.failure, /task_not_owned/);
    assert.equal(result.registered + result.started + result.stopped + result.removed, 0);
    assert.equal(result.hasState, false);
    assert.equal(result.shortcut, null);
  });
}
