import {externalToken, upstreamToken} from './http-auth-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManager, services } from '../manage.mjs';

const adapter = services[0];
const bridge = services[1];
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const timeout = () => Object.assign(new Error('sensitive cookie/token must not be recorded'), { name: 'TimeoutError' });
const response = (service, extra = {}) => ({ ok: true, status: 200, json: async () => ({ service: service.name, security:'service-bearer-v1' }), ...extra });
const portOf = url => Number(new URL(url).port);

function fixture(overrides = {}) {
  const events = [];
  const output = [];
  const errors = [];
  const launches = [];
  let time = 0;
  const manager = createManager({ serviceTokens: {1456:upstreamToken,1457:externalToken},
    services: [adapter], now: () => time, wait: async ms => { time += ms; },
    journal: event => events.push(event), out: line => output.push(line), err: line => errors.push(line),
    launch: async service => { launches.push(service); return { pid: 123 }; },
    ...overrides,
  });
  return { manager, events, output, errors, launches, time: () => time };
}

test('initial adapter timeout does not block bridge launch; aggregate status fails', async () => {
  let bridgeCalls = 0;
  const f = fixture({ services, fetch: async url => {
    if (portOf(url) === 1456) throw timeout();
    if (++bridgeCalls === 1) throw refused();
    return response(bridge);
  } });
  const r = await f.manager.run();
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.results.map(x => x.outcome ?? x.kind), ['service_error', 'started']);
  assert.deepEqual(f.launches.map(x => x.port), [1457]);
  assert.ok(f.events.some(x => x.port === 1456 && x.event === 'health_result' && x.type === 'TimeoutError' && x.phase === 'initial_health'));
  assert.equal(f.events.at(-1).event, 'manager_result');
});

test('bridge launch proceeds while adapter initial health is still unresolved', async () => {
  let rejectAdapter;
  const blocked = new Promise((_, reject) => { rejectAdapter = reject; });
  let bridgeCalls = 0;
  let bridgeLaunched;
  const launched = new Promise(resolve => { bridgeLaunched = resolve; });
  const f = fixture({ services, fetch: async url => {
    if (portOf(url) === 1456) return blocked;
    if (++bridgeCalls === 1) throw refused();
    return response(bridge);
  }, launch: async service => { bridgeLaunched(service); return { pid: 1457 }; } });
  const running = f.manager.run();
  assert.equal((await launched).port, 1457);
  rejectAdapter(timeout());
  assert.equal((await running).exitCode, 1);
});

test('16-second cold startup survives fast refusal without exceeding health budget', async () => {
  let f;
  f = fixture({ fetch: async () => { if (f.time() < 16000) throw refused(); return response(adapter); } });
  const r = await f.manager.run();
  assert.equal(r.exitCode, 0);
  assert.equal(f.launches.length, 1);
  assert.equal(f.time(), 16000);
  const attempts = f.events.filter(x => x.event === 'health_attempt');
  assert.equal(attempts.length, 11);
  assert.ok(attempts.every(x => x.budgetMs === 1500));
});

test('permanent refusal is capped at 41 GET and one spawn', async () => {
  const f = fixture({ fetch: async () => { throw refused(); } });
  const r = await f.manager.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.results[0].kind, 'startup_budget_exhausted');
  assert.equal(f.launches.length, 1);
  assert.equal(f.events.filter(x => x.event === 'health_attempt').length, 41);
  assert.equal(f.time(), 68500);
});

test('slow health checks use at most the original 70-second startup window', async () => {
  let time = 0;
  let count = 0;
  const f = fixture({ now: () => time, wait: async ms => { time += ms; }, fetch: async () => {
    if (++count === 1) throw refused();
    time += 1500;
    throw timeout();
  } });
  const r = await f.manager.run();
  assert.equal(r.exitCode, 1);
  assert.equal(count, 41);
  assert.equal(time, 70000);
});

test('warmup timeout retries the same owned process and then succeeds', async () => {
  let count = 0;
  const f = fixture({ fetch: async () => {
    if (++count === 1) throw refused();
    if (count === 2) throw timeout();
    return response(adapter);
  } });
  assert.equal((await f.manager.run()).exitCode, 0);
  assert.equal(f.launches.length, 1);
  assert.equal(count, 3);
  assert.ok(f.events.some(x => x.event === 'health_result' && x.phase === 'startup_health' && x.type === 'TimeoutError'));
});

for (const kind of ['identity', 'http', 'json']) {
  test(`initial ${kind} error prevents duplicate spawn but does not block other service`, async () => {
    const f = fixture({ services, fetch: async url => {
      if (portOf(url) === 1457) return response(bridge);
      if (kind === 'identity') return response(bridge);
      if (kind === 'http') return response(adapter, { ok: false, status: 503 });
      return response(adapter, { json: async () => { throw new SyntaxError('secret body'); } });
    } });
    const r = await f.manager.run();
    assert.equal(r.exitCode, 1);
    assert.equal(r.results[1].outcome, 'already_running');
    assert.equal(f.launches.length, 0);
    const failed = f.events.find(x => x.event === 'health_result' && x.port === 1456);
    assert.equal(failed.headersReceived, true);
    assert.equal(failed.status, kind === 'http' ? 503 : 200);
  });
}

test('spawn failure is recorded while the other missing service starts', async () => {
  let bridgeCalls = 0;
  const f = fixture({ services, fetch: async url => {
    if (portOf(url) === 1456 || ++bridgeCalls === 1) throw refused();
    return response(bridge);
  }, launch: async service => {
    if (service.port === 1456) throw Object.assign(new Error('private path'), { code: 'ENOENT' });
    return { pid: 1457 };
  } });
  const r = await f.manager.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.results[1].outcome, 'started');
  assert.ok(f.events.some(x => x.event === 'service_result' && x.phase === 'spawn' && x.code === 'ENOENT'));
});

test('owned child exit stops polling without spawning again', async () => {
  const f = fixture({ fetch: async () => { throw refused(); }, launch: async () => ({ pid: 123, exit: { code: 2, signal: null } }) });
  assert.equal((await f.manager.run()).results[0].kind, 'child_exited');
  assert.equal(f.events.filter(x => x.event === 'health_attempt').length, 1);
  assert.ok(f.events.some(x => x.kind === 'child_exited' && x.exitCode === 2));
});

test('status checks both services and never launches processes', async () => {
  const f = fixture({ services, fetch: async url => { if (portOf(url) === 1456) throw refused(); return response(bridge); } });
  const r = await f.manager.run('status');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.results.map(x => x.outcome), ['unavailable', 'healthy']);
  assert.equal(f.launches.length, 0);
  assert.equal(f.events.filter(x => x.event === 'health_attempt').length, 2);
});

test('journal failures are visible and do not prevent the other service from starting', async () => {
  let count = 0;
  const f = fixture({ fetch: async () => { if (++count === 1) throw refused(); return response(adapter); }, journal: () => { throw new Error('disk full'); } });
  const r = await f.manager.run();
  assert.equal(r.exitCode, 0);
  assert.equal(r.journalFailed, true);
  assert.ok(f.errors.includes('startup_log_write_failed'));
});

test('diagnostics omit untrusted messages, bodies, headers and environment', async () => {
  const secret = 'Bearer should-never-be-written';
  const f = fixture({ env: { PRIVATE_TOKEN: secret }, fetch: async () => { throw Object.assign(new TypeError(secret, { cause: { code: secret, message: secret } }), { kind: secret }); } });
  await f.manager.run();
  assert.equal(JSON.stringify([f.events, f.errors]).includes(secret), false);
  assert.ok(f.events.some(x => x.code === 'OTHER' && x.type === 'TypeError'));
});

test('real launch wrapper preserves arguments, environment, hidden detached process and log redirection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-manager-offline-'));
  let count = 0;
  let captured;
  let unref = false;
  const f = fixture({ directory: root, launch: undefined, minimized: true, env: { PCW_TEMPORARY_CHAT: '0', PCW_CHROME_ARGS: '--existing' },
    fetch: async () => { if (++count === 1) throw refused(); return response(adapter); },
    spawn: (executable, args, options) => {
      captured = { executable, args, options };
      const child = new EventEmitter(); child.pid = 42; child.unref = () => { unref = true; };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal((await f.manager.run()).exitCode, 0);
  assert.equal(captured.executable, process.execPath);
  assert.deepEqual(captured.args, [join(root, 'pcw.mjs'), 'serve']);
  assert.equal(captured.options.cwd, root);
  assert.equal(captured.options.detached, true);
  assert.equal(captured.options.windowsHide, true);
  assert.equal(captured.options.stdio[0], 'ignore');
  assert.equal(captured.options.stdio[1], captured.options.stdio[2]);
  assert.equal(captured.options.env.PCW_TEMPORARY_CHAT, '0');
  assert.equal(captured.options.env.PCW_CHROME_ARGS, '--existing --start-minimized');
  assert.equal(unref, true);
  assert.equal(readFileSync(join(root, '.runtime', '1456.log')).length, 0);
});

test('real launch error event is contained and logged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-manager-error-offline-'));
  const f = fixture({ directory: root, launch: undefined, fetch: async () => { throw refused(); }, spawn: () => {
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('error', Object.assign(new Error('private text'), { code: 'EACCES' })));
    return child;
  } });
  const r = await f.manager.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.results[0].phase, 'spawn');
  assert.equal(r.results[0].code, 'EACCES');
});

test('invalid command never performs health or launch', async () => {
  const f = fixture({ fetch: async () => { assert.fail('no GET'); } });
  assert.equal((await f.manager.run('invalid')).exitCode, 1);
  assert.equal(f.events.filter(x => x.event === 'health_attempt').length, 0);
});

test('default journal persists run and per-service phase outcomes as valid JSONL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-manager-journal-offline-'));
  const f = fixture({ directory: root, journal: undefined, fetch: async () => { throw timeout(); } });
  assert.equal((await f.manager.run()).exitCode, 1);
  const records = readFileSync(join(root, '.runtime', 'startup.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].event, 'manager_begin');
  assert.equal(records.at(-1).event, 'manager_result');
  assert.equal(new Set(records.map(x => x.runId)).size, 1);
  assert.ok(records.some(x => x.event === 'health_result' && x.phase === 'initial_health' && x.type === 'TimeoutError'));
  assert.equal(JSON.stringify(records).includes('sensitive cookie/token'), false);
});

test('one shared explicit GET budget caps both concurrently starting services', async () => {
  let calls = 0;
  const f = fixture({ services, maxGET: 3, fetch: async () => { calls++; throw refused(); } });
  const result = await f.manager.run();
  assert.equal(result.exitCode, 1);
  assert.equal(calls, 3);
  assert.equal(result.healthGET, 3);
  assert.equal(f.launches.length, 2);
  assert.ok(result.results.every(item => item.kind === 'health_get_budget_exhausted'));
});

test('invalid shared health ceilings reject before any request or process launch', () => {
  for (const maxGET of [0, -1, 1.5, 83, NaN]) {
    assert.throws(() => createManager({ serviceTokens: {1456:upstreamToken,1457:externalToken}, services, maxGET }), /invalid_budget/);
  }
});

test('manager rejects old unauthenticated service before launching or treating it as ready',async()=>{
 const f=fixture({fetch:async()=>({ok:true,status:200,json:async()=>({service:adapter.name})})});
 const r=await f.manager.run();assert.equal(r.exitCode,1);assert.equal(f.launches.length,0);assert.equal(r.results[0].kind,'service_auth_unverified');
});
test('manager without authorization sends zero health requests and spawns nothing',async()=>{
 const f=fixture({serviceTokens:{},fetch:()=>{throw Error('No request allowed')}});const r=await f.manager.run();assert.equal(r.exitCode,1);assert.equal(r.healthGET,0);assert.equal(f.launches.length,0);
});
