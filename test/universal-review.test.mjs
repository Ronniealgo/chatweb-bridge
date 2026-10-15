import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { createWebBridge } from '../bridge/server.mjs';
import { SerialLane } from '../bridge/queue.mjs';
import { loadAdapters, main } from '../web-bridge.mjs';

const token = 'offline-fixture-credential-not-real-000000000';
const block = ms => { const until = Date.now() + ms; while (Date.now() < until) {} };
const adapter = (overrides = {}) => ({
  id: 'fixture', models: [{ id: 'fixture-model' }], capabilities: { images: false },
  status: () => ({ state: 'ready' }), close: async () => {},
  generate: async payload => ({ model: payload.model, text: 'ok' }), ...overrides,
});
async function serve(t, adapters, limits = {}) {
  const bridge = createWebBridge({ token, adapters, limits });
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  return { bridge, url, send: body => fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }], ...body }),
  }) };
}

test('review: tool contract preserves ChatGPT names, descriptions, schema and forced choice', async t => {
  let observed;
  const tool = { name: 'ChatGPT_search', description: 'Search ChatGPT exactly', parameters: {
    type: 'object', properties: { product: { type: 'string', const: 'ChatGPT' } },
    required: ['product'], additionalProperties: false,
  } };
  const { send } = await serve(t, [adapter({ generate: async payload => {
    const contract = payload.messages[0].content;
    observed = { contract, tools: JSON.parse(contract.split('Available tools (JSON Schema): ')[1]) };
    const [available] = observed.tools;
    const nonce = contract.match(/<(dsh_reply_[a-f0-9]{32})>/)[1];
    return { model: payload.model, text: `<${nonce}>${JSON.stringify({ tool_calls: [{
      name: available.name, arguments: { product: available.parameters.properties.product.const },
    }] })}</${nonce}>` };
  } })]);
  const response = await send({ tools: [{ type: 'function', function: tool }],
    tool_choice: { type: 'function', function: { name: tool.name } } });
  assert.equal(response.status, 200);
  assert.deepEqual(observed.tools, [tool]);
  assert.ok(observed.contract.includes('Only call ChatGPT_search.'));
  const result = await response.json();
  assert.equal(result.choices[0].message.tool_calls[0].function.name, tool.name);
  assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { product: 'ChatGPT' });
});

test('review: an expired request never invokes its operation after a delayed microtask', async t => {
  const lane = new SerialLane({ requestTimeoutMs: 15, queueTimeoutMs: 200 });
  t.after(() => lane.close());
  let calls = 0;
  const result = lane.submit(() => { calls++; return 'too late'; }).catch(error => error);
  block(40);
  const error = await result;
  assert.equal(error.code, 'request_timeout');
  assert.equal(error.details.generation_submitted, false);
  assert.equal(calls, 0);
  assert.equal(lane.snapshot().active, false);
});

test('review: delayed timers cannot turn an overdue successful settlement into success', async t => {
  const lane = new SerialLane({ requestTimeoutMs: 15, queueTimeoutMs: 200 });
  t.after(() => lane.close());
  let operationSignal;
  const result = await lane.submit(({ signal }) => {
    operationSignal = signal;
    block(40);
    return 'late success';
  }).catch(error => error);
  assert.equal(result.code, 'request_timeout');
  assert.equal(result.details.generation_submitted, 'unknown');
  assert.equal(operationSignal.aborted, true);
  assert.equal(lane.snapshot().active, false);
});

function moduleFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'web-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, 'closed.jsonl');
  const source = `import { appendFileSync } from 'node:fs';
    export function createAdapter(o) { return {
      models: [{ id: 'fixture-model' }], generate() {}, status() {},
      close() { appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(o.id) + '\\n');
        if (o.throwOnClose) throw new Error('close failure'); }
    }; }`;
  const modulePath = join(dir, 'adapter.mjs');
  writeFileSync(modulePath, source);
  return { dir, logFile, modulePath, source, closed: () => existsSync(logFile)
    ? readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).sort() : [] };
}

for (const failure of ['import', 'missing factory', 'factory throw', 'invalid contract']) {
  test(`review: adapter initialization rolls back on ${failure}`, async t => {
    const f = moduleFixture(t);
    const badModule = join(f.dir, 'bad.mjs');
    if (failure === 'missing factory') writeFileSync(badModule, 'export const notAFactory = true;');
    if (failure === 'factory throw') writeFileSync(badModule, 'export function createAdapter() { throw new Error("factory failure"); }');
    if (failure === 'invalid contract') writeFileSync(badModule, f.source.replace("models: [{ id: 'fixture-model' }]", 'models: []'));
    const providers = [
      { type: 'module', id: 'first', modulePath: f.modulePath, throwOnClose: true },
      { type: 'module', id: 'second', modulePath: f.modulePath },
      { type: 'module', id: 'invalid', modulePath: badModule },
    ];
    const expectedError = failure === 'import' ? /Cannot find module/ : failure === 'missing factory'
      ? /must export createAdapter/ : failure === 'factory throw' ? /factory failure/ : /Invalid adapter contract/;
    await assert.rejects(loadAdapters({ providers }, token), expectedError);
    assert.deepEqual(f.closed(), failure === 'invalid contract' ? ['first', 'invalid', 'second'] : ['first', 'second']);
  });
}

test('review: constructor failure closes adapters without installing process listeners', async t => {
  const f = moduleFixture(t);
  const configPath = join(f.dir, 'config.json');
  writeFileSync(join(f.dir, 'auth.json'), JSON.stringify({ token }));
  writeFileSync(configPath, JSON.stringify({ schema: 1, authFile: 'auth.json', providers: [
    { type: 'module', id: 'first', modulePath: f.modulePath, throwOnClose: true },
    { type: 'module', id: 'second', modulePath: f.modulePath },
  ] }));
  const before = ['SIGINT', 'SIGTERM'].map(signal => process.rawListeners(signal));
  await assert.rejects(main(['serve', '--config', configPath]), /Duplicate model route/);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.rawListeners(signal)), before);
  assert.deepEqual(f.closed(), ['first', 'second']);
});

test('review: synchronous close failure cannot skip adapters or HTTP socket teardown', { timeout: 3000 }, async t => {
  const closed = [];
  const bridge = createWebBridge({ token, adapters: [
    adapter({ close() { closed.push('first'); throw new Error('sync close failure'); } }),
    adapter({ models: [{ id: 'second' }], async close() { closed.push('second'); throw new Error('async close failure'); } }),
    adapter({ models: [{ id: 'third' }], close() { closed.push('third'); } }),
  ] });
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  const socket = connect(bridge.server.address().port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(async () => { socket.destroy(); bridge.server.closeAllConnections(); await bridge.close().catch(() => {}); });
  await once(socket, 'connect');
  socket.resume(); // Drain any response so the peer's FIN is observed.
  const socketClosed = new Promise(resolve => socket.once('close', resolve));
  const requestSeen = once(bridge.server, 'request');
  socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: 100\r\n\r\n{`);
  await requestSeen;
  const closing = bridge.close();
  assert.equal(bridge.close(), closing, 'close must remain idempotent');
  await assert.doesNotReject(closing);
  assert.deepEqual(closed, ['first', 'second', 'third']);
  await socketClosed;
  assert.equal(socket.destroyed, true);
  assert.equal(bridge.server.listening, false);
});

for (const [label, messages] of [['non-array messages', {}], ['null message', [null]]]) {
  test(`review: image precheck leaves ${label} to client validation`, async t => {
    let calls = 0;
    const { send } = await serve(t, [adapter({ generate() { calls++; throw new Error('must not generate'); } })]);
    const response = await send({ messages });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'invalid_request');
    assert.equal(calls, 0);
  });
}
