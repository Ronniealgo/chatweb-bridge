import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createBridge } from '../server.mjs';
import { authorizeLocalRequest, readServiceToken, assertLoopbackListenHost } from '../http-security.mjs';

// Deliberately public fixture strings: never deploy these values.
const EXTERNAL = 'offline-fixture-external-0000000000000000';
const INTERNAL = 'offline-fixture-internal-1111111111111111';
const temp = mkdtempSync(join(tmpdir(), 'dsh-http-security-'));
const oldCache = process.env.PI_CHATGPT_WEB_CACHE_DIR;
process.env.PI_CHATGPT_WEB_CACHE_DIR = join(temp, 'cache');
const { AdapterServer } = await import('../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/server/http.js');
const { operationQueueState, operationState, withBrowserOperation } = await import('../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js');
after(() => {
  if (oldCache === undefined) delete process.env.PI_CHATGPT_WEB_CACHE_DIR;
  else process.env.PI_CHATGPT_WEB_CACHE_DIR = oldCache;
  assert.ok(realpathSync(temp).startsWith(resolve(tmpdir()) + sep));
  rmSync(temp, { recursive: true, force: true });
});
const auth = token => ({ authorization: `Bearer ${token}` });
const quiet = { info() {}, error() {} };
const body = { model: 'gpt-5-6-thinking', messages: [{ role: 'user', content: 'Offline fixture only' }] };
const reply = () => ({ model: 'offline-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Offline answer' } }] });

function request(overrides = {}) {
  return { method: 'POST', url: '/v1/chat/completions', socket: { remoteAddress: '127.0.0.1', localPort: 31234 },
    headers: { host: '127.0.0.1:31234', ...auth(EXTERNAL), 'content-type': 'application/json' }, ...overrides };
}
function rejects(req, code, token = EXTERNAL) {
  assert.throws(() => authorizeLocalRequest(req, token), error => error.code === code && error.details.generation_submitted === false);
}
async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function adapter(t, token = INTERNAL) {
  let generations = 0, diagnostics = 0;
  const forbidden = () => { throw Error('Real browser, account auth and model calls are forbidden'); };
  const app = Object.assign(Object.create(AdapterServer.prototype), {
    internalToken: token, opts: {}, chrome: { page: null, ensureRunning: forbidden, fetchSession: forbidden }, chat: { run: forbidden },
    busy: false, warmTimer: null,
    async handleChatExclusive(_req, res) { generations++; this.json(res, 200, reply()); },
    async doctorReport() { diagnostics++; return { diagnosticMode: 'offline-fixture' }; },
  });
  app.server = createServer((req, res) => void app.handle(req, res));
  return { app, base: await listen(t, app.server), generations: () => generations, diagnostics: () => diagnostics };
}
async function bridge(t, options = {}) {
  let submissions = 0, forwarded;
  const server = createBridge({ externalToken: EXTERNAL, upstreamToken: INTERNAL, logger: quiet,
    upstream: 'http://127.0.0.1:9', fetchImpl: async (_url, init) => { submissions++; forwarded = init; return Response.json(reply()); }, ...options });
  return { server, base: await listen(t, server), submissions: () => submissions, forwarded: () => forwarded };
}
const post = (base, token, path = '/v1/chat/completions', headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? auth(token) : {}), ...headers }, body: JSON.stringify(body),
});
function postWithHost(base, token, host) {
  // Node fetch rewrites Host; exercise the actual wire header with node:http.
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL('/v1/chat/completions', base), {
      method: 'POST', headers: { host, ...auth(token), 'content-type': 'application/json' },
    }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('token config has no fallback, rejects ambiguity, and accepts an explicit synthetic file', () => {
  assert.equal(readServiceToken('FIXTURE', undefined, {}), null);
  assert.equal(readServiceToken('FIXTURE', null, { FIXTURE: EXTERNAL }), null);
  assert.equal(readServiceToken('FIXTURE', EXTERNAL, { FIXTURE_FILE: 'must-not-read' }), EXTERNAL);
  for (const env of [{ FIXTURE: 'local-placeholder' }, { FIXTURE: '' }, { FIXTURE: EXTERNAL, FIXTURE_FILE: 'unused' }, { FIXTURE_FILE: join(temp, 'absent') }])
    assert.throws(() => readServiceToken('FIXTURE', undefined, env), error => error.code === 'service_auth_unconfigured');
  const file = join(temp, 'synthetic-token.txt');
  writeFileSync(file, INTERNAL + '\r\n');
  assert.equal(readServiceToken('FIXTURE', undefined, { FIXTURE_FILE: file }), INTERNAL);
  writeFileSync(file, 'x'.repeat(1025));
  assert.throws(() => readServiceToken('FIXTURE', undefined, { FIXTURE_FILE: file }), /not configured/);
  assert.throws(() => createBridge({ externalToken: EXTERNAL, upstreamToken: EXTERNAL }), /not configured/);
});

test('only loopback bind addresses are permitted', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.doesNotThrow(() => assertLoopbackListenHost(host));
  for (const host of ['0.0.0.0', '::', '192.0.2.1', 'example.test']) assert.throws(() => assertLoopbackListenHost(host), /loopback/);
});

for (const peer of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) test(`accept loopback socket peer ${peer}`, () => {
  const req = request({ socket: { remoteAddress: peer, localPort: 31234 } });
  assert.equal(authorizeLocalRequest(req, EXTERNAL), true);
  assert.equal(req[Symbol.for('dsh.http.authenticated')], true);
});
for (const peer of ['192.0.2.1', '::ffff:192.0.2.1', '::', '127.0.0.1.attacker.test', undefined]) test(`reject non-loopback peer ${peer}`, () => {
  rejects(request({ socket: { remoteAddress: peer, localPort: 31234 } }), 'loopback_required');
});
for (const host of ['attacker.test:31234', '127.0.0.1:1456', '127.0.0.1', '127.0.0.1.:31234', '127.1:31234', '2130706433:31234', 'localhost.evil:31234', 'user@127.0.0.1:31234', '127.0.0.1:31234/path', undefined])
  test(`reject rebinding/ambiguous Host ${host}`, () => rejects(request({ headers: { ...request().headers, host } }), 'invalid_host'));
for (const host of ['127.0.0.1:31234', 'localhost:31234', '[::1]:31234'])
  test(`accept exact local Host ${host}`, () => assert.equal(authorizeLocalRequest(request({ headers: { ...request().headers, host } }), EXTERNAL), true));

for (const headers of [{ origin: 'null' }, { origin: 'http://localhost:31234' }, { referer: 'http://localhost/' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-dest': 'empty' }])
  test(`reject browser request ${JSON.stringify(headers)}`, () => rejects(request({ headers: { ...request().headers, ...headers } }), 'browser_origin_forbidden'));

for (const value of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=fixture', 'application/jsonp', 'application/json; charset=utf-16', 'application/json, text/plain'])
  test(`reject unsafe media type ${value}`, () => rejects(request({ headers: { ...request().headers, 'content-type': value } }), 'unsupported_media_type'));
for (const value of ['application/json', 'application/json; charset=utf-8', 'Application/JSON; charset="UTF-8"'])
  test(`accept JSON media type ${value}`, () => assert.equal(authorizeLocalRequest(request({ headers: { ...request().headers, 'content-type': value } }), EXTERNAL), true));

test('duplicate headers, absolute targets, query-string tokens and forwarded headers cannot bypass authentication', () => {
  rejects(request({ rawHeaders: ['Host', '127.0.0.1:31234', 'Host', 'attacker.test'] }), 'invalid_request_headers');
  rejects(request({ rawHeaders: ['Authorization', `Bearer ${EXTERNAL}`, 'Authorization', `Bearer ${INTERNAL}`] }), 'invalid_request_headers');
  rejects(request({ url: 'http://127.0.0.1:31234/v1/chat/completions' }), 'invalid_request_target');
  rejects(request({ url: '//127.0.0.1/v1/chat/completions' }), 'invalid_request_target');
  rejects(request({ url: `/v1/chat/completions?token=${EXTERNAL}`, headers: { host: '127.0.0.1:31234', 'x-forwarded-for': '127.0.0.1', 'x-api-key': EXTERNAL } }), 'service_auth_required');
  rejects(request({ headers: { ...request().headers, 'content-encoding': 'gzip' } }), 'unsupported_content_encoding');
});

test('only exact GET /health is public and emits no detailed status', async t => {
  for (const f of [await adapter(t, null), await bridge(t, { externalToken: null, upstreamToken: null })]) {
    const health = await fetch(f.base + '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(await health.json()).sort(), ['service', 'status']);
    for (const path of ['/', '/health/', '/health?details=1', '/v1/models', '/doctor', '/readiness'])
      assert.equal((await fetch(f.base + path)).status, 503);
    assert.equal((await post(f.base, null)).status, 503);
  }
});

test('adapter rejects absent/external keys on every generation alias and diagnostic route before queue admission', async t => {
  const f = await adapter(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = withBrowserOperation(f.app.chrome, 'readiness', 'offline-owner', () => gate);
  t.after(async () => { release(); await held; });
  for (const token of [null, EXTERNAL]) {
    for (const path of ['/v1/chat/completions', '/chat/completions', '/v1/responses', '/responses'])
      assert.equal((await post(f.base, token, path)).status, 401);
    for (const path of ['/doctor', '/readiness', '/v1/models', '/models'])
      assert.equal((await fetch(f.base + path, { headers: token ? auth(token) : {} })).status, 401);
  }
  assert.equal(f.generations(), 0);
  assert.equal(f.diagnostics(), 0);
  assert.equal(operationQueueState(f.app.chrome).queued, 0);
  assert.equal(operationState(f.app.chrome).requestId, 'offline-owner');
});

test('authenticated adapter generation and diagnostics remain available to native clients', async t => {
  const f = await adapter(t);
  for (const path of ['/v1/chat/completions', '/chat/completions', '/v1/responses', '/responses'])
    assert.equal((await post(f.base, INTERNAL, path)).status, 200);
  for (const path of ['/doctor', '/readiness']) assert.equal((await fetch(f.base + path, { headers: auth(INTERNAL) })).status, 200);
  assert.equal(f.generations(), 4);
  assert.equal(f.diagnostics(), 2);
  assert.equal(operationQueueState(f.app.chrome).queued, 0);
  assert.equal((await (await fetch(f.base + '/health', { headers: auth(INTERNAL) })).json()).security, 'service-bearer-v1');
});

test('bridge authenticates before body/queue, keeps internal key independent and never forwards client credentials', async t => {
  const f = await bridge(t);
  for (const token of [null, INTERNAL]) {
    assert.equal((await post(f.base, token)).status, 401);
    assert.equal((await post(f.base, token, '/v1/responses')).status, 401);
    assert.equal((await fetch(f.base + '/v1/models', { headers: token ? auth(token) : {} })).status, 401);
  }
  assert.equal(f.submissions(), 0);
  assert.equal((await post(f.base, EXTERNAL)).status, 200);
  assert.equal(f.submissions(), 1);
  assert.equal(f.forwarded().headers.authorization, `Bearer ${INTERNAL}`);
  assert.equal(JSON.stringify(f.forwarded()).includes(EXTERNAL), false);
  assert.equal(f.forwarded().redirect, 'error');
  assert.equal((await fetch(f.base + '/v1/models', { headers: auth(EXTERNAL) })).status, 200);
  const health = await (await fetch(f.base + '/health', { headers: auth(EXTERNAL) })).json();
  assert.equal(health.requests, 1);
  assert.equal(health.busy, false);
  assert.equal(health.security, 'service-bearer-v1');
});

test('bridge with missing internal credential fails before upstream', async t => {
  const f = await bridge(t, { upstreamToken: null });
  assert.equal((await post(f.base, EXTERNAL)).status, 503);
  assert.equal(f.submissions(), 0);
});

test('real ephemeral two-hop HTTP accepts separate credentials and cannot bypass through either port', async t => {
  const a = await adapter(t), b = await bridge(t, { upstream: a.base, fetchImpl: fetch });
  assert.equal((await post(b.base, EXTERNAL)).status, 200);
  assert.equal((await post(a.base, EXTERNAL)).status, 401);
  assert.equal((await post(b.base, INTERNAL)).status, 401);
  assert.equal((await post(a.base, null)).status, 401);
  assert.equal((await post(b.base, null)).status, 401);
  assert.equal(a.generations(), 1);
});

for (const make of [adapter, bridge]) test(`${make.name} rejects browser and dangerous media with valid credentials`, async t => {
  const f = await make(t), token = make === adapter ? INTERNAL : EXTERNAL;
  for (const headers of [{ origin: 'https://attacker.test' }, { 'sec-fetch-site': 'same-origin' }])
    assert.equal((await post(f.base, token, '/v1/chat/completions', headers)).status, 403);
  assert.equal(await postWithHost(f.base, token, 'attacker.test'), 403);
  assert.equal((await post(f.base, token, '/v1/chat/completions', { 'content-type': 'text/plain' })).status, 415);
  assert.equal(make === adapter ? f.generations() : f.submissions(), 0);
});
