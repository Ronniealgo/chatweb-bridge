import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

const token = 'offline-fixture-credential-not-real-000000000';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, generate, options = {}) {
  const { createWebBridge } = await import('../bridge/server.mjs');
  const adapter = { id: 'fixture', models: [{ id: 'fixture-model' }], capabilities: { images: false },
    status: () => ({ state: 'ready' }), close: async () => {}, generate };
  const bridge = createWebBridge({ token, adapters: [adapter], logger: () => {}, ...options });
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(() => bridge.close());
  const send = (body, extra = {}) => fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body), ...extra,
  });
  return { bridge, adapter, send, url };
}
const request = (text = 'hello', extra = {}) => ({ model: 'fixture-model', messages: [{ role: 'user', content: text }], ...extra });

test('concurrent clients are FIFO serialized on one browser', async t => {
  let active = 0, maximum = 0;
  const order = [];
  const { send } = await fixture(t, async payload => {
    active++; maximum = Math.max(maximum, active);
    const text = JSON.parse(payload.messages[1].content).conversation[0].content;
    order.push(text); await pause(30); active--;
    return { model: payload.model, text };
  });
  const first = send(request('first'));
  await pause(5);
  const second = send(request('second'));
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(maximum, 1, 'shared browser must never receive overlapping operations');
  assert.deepEqual(order, ['first', 'second']);
});

test('stream opens promptly, keeps alive, and errors are never assistant success', async t => {
  const { BridgeError } = await import('../bridge/errors.mjs');
  let release;
  const gate = new Promise(r => { release = r; });
  const { send } = await fixture(t, async () => { await gate; throw new BridgeError('Browser closed.', 503, 'browser_closed'); }, { limits: { heartbeatMs: 10 } });
  const pending = send(request('private prompt', { stream: true }));
  const received = await Promise.race([pending, pause(500).then(() => null)]);
  if (!received) release();
  assert.ok(received, 'SSE headers must arrive before the browser finishes');
  await pause(30); release();
  const wire = await received.text();
  assert.match(wire, /: keepalive/);
  const frames = wire.split('\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));
  assert.equal(frames.at(-1).error.code, 'browser_closed');
  assert.equal(frames.some(f => f.choices?.some(c => c.finish_reason === 'stop')), false);
  assert.match(wire, /data: \[DONE\]/);
});

test('request deadline aborts its adapter and returns a structured failure', async t => {
  let aborted = false, calls = 0;
  const { send, bridge } = await fixture(t, async (_payload, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
  }, { limits: { requestTimeoutMs: 40, cancelGraceMs: 20 } });
  const response = await send(request());
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'request_timeout');
  assert.equal(aborted, true);
  assert.equal(calls, 1, 'never replay an uncertain submitted request');
  assert.equal(bridge.snapshot().active, 0);
});

test('oversized and malformed inputs fail before browser access', async t => {
  let calls = 0;
  const { send } = await fixture(t, async () => { calls++; return { text: 'unexpected' }; }, { limits: { bodyBytes: 256 } });
  assert.equal((await send('{')).status, 400);
  assert.equal((await send(request('x'.repeat(300)))).status, 413);
  assert.equal((await send(request('x', { model: 'not-configured' }))).status, 400);
  assert.equal(calls, 0);
});

test('health is liveness, not a false claim that the browser is ready', async t => {
  const { url, adapter } = await fixture(t, async () => ({ text: 'ok' }));
  adapter.status = () => ({ state: 'disconnected' });
  const live = await fetch(`${url}/health`);
  assert.equal(live.status, 200);
  const ready = await fetch(`${url}/ready`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).ready, false);
});

test('unsupported image input and model mismatch fail closed', async t => {
  let calls = 0;
  const { send } = await fixture(t, async () => { calls++; return { text: 'wrong model', model: 'another-model' }; });
  const image = await send(request('x', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] }));
  assert.equal(image.status, 400);
  assert.equal((await image.json()).error.code, 'unsupported_image_input');
  assert.equal(calls, 0);
  const mismatch = await send(request());
  assert.equal(mismatch.status, 422);
  assert.equal((await mismatch.json()).error.code, 'model_identity_mismatch');
});

test('Responses API uses the same validated tool protocol without invented usage', async t => {
  const { url } = await fixture(t, async payload => ({ model: payload.model, text: 'fixture response' }));
  const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model', input: 'hello' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.output[0].content[0].text, 'fixture response');
  assert.equal(body.usage, null);
});

test('shutdown requires auth and emits a control event, not an arbitrary process kill', async t => {
  const { url, bridge } = await fixture(t, async () => ({ text: 'ok' }));
  let events = 0; bridge.server.on('shutdownRequested', () => events++);
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(`${url}/admin/shutdown`, options)).status, 401);
  options.headers.authorization = `Bearer ${token}`;
  assert.equal((await fetch(`${url}/admin/shutdown`, options)).status, 202);
  await pause(5);
  assert.equal(events, 1);
});

test('uncertain submitted failures suppress automatic identical client replay', async t => {
  const { BridgeError } = await import('../bridge/errors.mjs');
  let count = 0;
  const { send } = await fixture(t, async () => { count++; throw new BridgeError('Not confirmed.', 504, 'generation_timeout', { generation_submitted: true }); });
  assert.equal((await send(request('same operation'))).status, 504);
  const repeated = await send(request('same operation'));
  assert.equal(repeated.status, 422);
  assert.equal((await repeated.json()).error.code, 'recent_failed_request');
  assert.equal(count, 1);
});

test('HTTP preserves every conversation role and validates a tool request', async t => {
  let observed;
  const { send } = await fixture(t, async payload => {
    observed = payload;
    const nonce = payload.messages[0].content.match(/<([a-z_]+[a-f0-9]{32})>/)[1];
    return { model: payload.model, text: `<${nonce}>{"tool_calls":[{"name":"read_local","arguments":{"path":"fixture.txt"}}]}</${nonce}>` };
  });
  const response = await send(request('new turn', {
    messages: [{ role: 'system', content: 'system rule' }, { role: 'developer', content: 'developer rule' },
      { role: 'user', content: 'prior question' }, { role: 'assistant', content: 'prior answer' },
      { role: 'tool', content: 'actual result', tool_call_id: 'previous_call' }, { role: 'user', content: 'new turn' }],
    tools: [{ type: 'function', function: { name: 'read_local', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }],
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(JSON.parse(observed.messages[1].content).conversation.map(m => m.role), ['system', 'developer', 'user', 'assistant', 'tool', 'user']);
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'read_local');
  assert.equal(body.usage, undefined, 'never invent native usage');
});
