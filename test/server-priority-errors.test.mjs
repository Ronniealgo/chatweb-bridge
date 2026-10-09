import { bridgeAuth, adapterAuth, externalToken, upstreamToken, authFetch } from './http-auth-fixture.mjs';
const fetch = authFetch(externalToken);
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createBridge } from '../server.mjs';

const tool = { type: 'function', function: { name: 'read_file', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
} } };
const request = () => ({ model: 'gpt-5-6-thinking', messages: [{ role: 'user', content: 'Return the mock result.' }], tools: [tool] });
const reply = init => {
  const body = JSON.parse(init.body);
  const nonce = body.messages[0].content.match(/<(dsh_reply_[a-f0-9]+)>JSON<\//)?.[1];
  assert.ok(nonce);
  return Response.json({ model: 'mock-model', choices: [{ message: { role: 'assistant', content: `<${nonce}>{"content":"mock complete"}</${nonce}>` }, finish_reason: 'stop' }] });
};
async function fixture(t, fetchImpl, options = {}) {
  const logs = [];
  const server = createBridge({ ...bridgeAuth, upstream: 'http://127.0.0.1:9', fetchImpl,
    logger: { info: x => logs.push(JSON.parse(x)), error: x => logs.push(JSON.parse(x)) }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (signal, body = request()) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const health = async () => (await fetch(`${base}/health`)).json();
  return { server, post, health, logs };
}
const preserved = [
  ['adapter_busy', 429, 'queue'],
  ['adapter_queue_timeout', 429, 'queue'],
  ['adapter_queue_full', 429, 'queue'],
  ['adapter_queue_cancelled', 499, 'queue'],
  ['adapter_request_cancelled', 499, 'acquire'],
  ['adapter_body_timeout', 408, 'acquire'],
  ['browser_user_action_required', 401, 'prepare'],
  ['browser_operation_failed', 503, 'response'],
];
for (const [code, status, phase] of preserved) {
  test(`${code} preserves upstream status and safe pre-submit metadata without retry`, async t => {
    let clock = 0, calls = 0;
    const f = await fixture(t, async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:9/v1/chat/completions');
      calls++;
      if (calls === 1) return Response.json({ error: { message: 'Mock failure before submission.', code, phase, generation_submitted: false, retryable: true } }, { status });
      return reply(init);
    }, { now: () => clock });
    const first = await f.post();
    assert.equal(first.status, status);
    const error = (await first.json()).error;
    assert.equal(error.code, code);
    assert.equal(error.phase, phase);
    assert.equal(error.generation_submitted, false);
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, first.headers.get('x-dsh-request-id'));
    assert.equal(calls, 1, 'bridge must make exactly one upstream attempt');
    clock = 1000;
    const cached = await f.post();
    assert.equal(cached.status, 422);
    const suppressed = (await cached.json()).error;
    assert.equal(suppressed.code, 'recent_failed_request');
    assert.equal(suppressed.original_code, code);
    assert.equal(suppressed.generation_submitted, false);
    assert.equal(suppressed.retry_after_ms, 2000);
    assert.equal(calls, 1, 'identical request must be suppressed locally');
    clock = 3000;
    assert.equal((await f.post()).status, 200, 'caller may explicitly submit after the short cooldown');
    assert.equal(calls, 2);
    assert.equal((await f.health()).busy, false);
  });
}

for (const submitted of [true, 'unknown', undefined, 'false']) {
  test(`submitted=${JSON.stringify(submitted)} keeps the 60-second suppression and never auto-replays`, async t => {
    let clock = 0, calls = 0;
    const f = await fixture(t, async (_url, init) => {
      calls++;
      if (calls === 1) return Response.json({ error: { message: 'Mock response-stage failure.', code: 'browser_operation_failed', phase: 'generation-submit', generation_submitted: submitted } }, { status: 502 });
      return reply(init);
    }, { now: () => clock });
    const first = await f.post();
    assert.equal(first.status, 502);
    assert.equal((await first.json()).error.generation_submitted, submitted === true ? true : 'unknown');
    clock = 4000;
    const cached = (await (await f.post()).json()).error;
    assert.equal(cached.original_code, 'browser_operation_failed');
    assert.equal(cached.retry_after_ms, 56000);
    assert.equal(calls, 1);
    clock = 59999;
    assert.equal((await (await f.post()).json()).error.retry_after_ms, 1, 'suppression must not extend its deadline');
    assert.equal(calls, 1);
    clock = 60000;
    assert.equal((await f.post()).status, 200);
    assert.equal(calls, 2, 'second attempt must come only from a new explicit HTTP request');
  });
}

test('unrecognized error code and phase cannot masquerade as a trusted queue failure', async t => {
  const f = await fixture(t, async () => Response.json({ error: {
    message: 'Mock unknown adapter error.', code: 'adapter_queue_untrusted', phase: 'queue', generation_submitted: false,
  } }, { status: 429 }));
  const response = await f.post();
  assert.equal(response.status, 429);
  const error = (await response.json()).error;
  assert.equal(error.code, 'upstream_error');
  assert.equal(Object.hasOwn(error, 'generation_submitted'), false);
  const g = await fixture(t, async () => Response.json({ error: {
    message: 'Mock invalid phase.', code: 'browser_operation_failed', phase: 'private-internal-phase', generation_submitted: false,
  } }, { status: 502 }));
  assert.equal((await (await g.post()).json()).error.phase, 'unknown');
});

for (const finishReason of [undefined, null, '', 'length', 'tool_calls']) {
  test(`upstream finish_reason=${String(finishReason)} is incomplete with submitted=true`, async t => {
    let calls = 0;
    const f = await fixture(t, async (_url, init) => {
      calls++;
      const body = await reply(init).json();
      body.choices[0].finish_reason = finishReason;
      return Response.json(body);
    });
    const response = await f.post(undefined, { ...request(), stream: true });
    assert.equal(response.status, 502);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const body = await response.json();
    assert.equal(body.error.code, 'incomplete_upstream');
    assert.equal(body.error.phase, 'response');
    assert.equal(body.error.generation_submitted, true);
    assert.equal(body.error.retryable, false);
    assert.equal(Object.hasOwn(body, 'choices'), false);
    assert.equal(calls, 1);
    assert.equal((await f.health()).busy, false);
  });
}

test('safe termination evidence passes through; arbitrary exception text is dropped', async t => {
  const f=await fixture(t,async()=>Response.json({error:{code:'browser_submission_uncertain',message:'Fixture failure',phase:'generation-submit',generation_submitted:'unknown',details:{reason:'cdp_timeout',elapsedMs:180014,terminationConfirmed:false,raw:'SYNTHETIC_PRIVATE_TEXT'}}},{status:422}));
  const body=await(await f.post()).json();
  assert.equal(body.error.reason,'cdp_timeout');assert.equal(body.error.elapsedMs,180014);assert.equal(body.error.terminationConfirmed,false);
  assert.equal(JSON.stringify(body).includes('SYNTHETIC_PRIVATE_TEXT'),false);
  const g=await fixture(t,async()=>Response.json({error:{code:'browser_submission_uncertain',message:'Fixture failure',details:{reason:'SYNTHETIC_PRIVATE_TEXT'}}},{status:422}));
  assert.equal(Object.hasOwn((await(await g.post()).json()).error,'reason'),false);
});

test('real bridge concurrency remains bridge_busy with no duplicate upstream call', { timeout: 5000 }, async t => {
  let enter, release, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, async (_url, init) => { calls++; enter(); await gate; return reply(init); });
  const first = f.post();
  await entered;
  const second = await f.post();
  assert.equal(second.status, 429);
  const error = (await second.json()).error;
  assert.equal(error.code, 'bridge_busy');
  assert.equal(error.phase, 'queue');
  assert.equal(error.generation_submitted, false);
  assert.equal(error.retryable, false);
  assert.equal(calls, 1);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await f.health()).busy, false);
  assert.equal((await f.post()).status, 200, 'bridge_busy must not poison the active request fingerprint');
  assert.equal(calls, 2);
});

for (const outcome of ['resolve', 'reject']) {
  test(`client disconnect aborts upstream and emits no reply when mock upstream later ${outcome}s`, { timeout: 5000 }, async t => {
    let enter, observeAbort, release, calls = 0;
    const entered = new Promise(resolve => { enter = resolve; });
    const aborted = new Promise(resolve => { observeAbort = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const f = await fixture(t, async (_url, init) => {
      calls++;
      init.signal.addEventListener('abort', observeAbort, { once: true });
      enter();
      await gate;
      if (outcome === 'reject') throw new DOMException('Mock upstream aborted.', 'AbortError');
      return reply(init);
    });
    let writes = 0, ended = 0, finish = 0;
    let observeClose;
    const closed = new Promise(resolve => { observeClose = resolve; });
    f.server.on('request', (req, res) => {
      if (req.url !== '/v1/chat/completions') return;
      const writeHead = res.writeHead, end = res.end;
      res.writeHead = function (...args) { writes++; return writeHead.apply(this, args); };
      res.end = function (...args) { ended++; return end.apply(this, args); };
      res.once('finish', () => finish++);
      res.once('close', observeClose);
    });
    const ac = new AbortController();
    const pending = f.post(ac.signal);
    const clientRejected = assert.rejects(pending, error => error.name === 'AbortError');
    await entered;
    ac.abort();
    await Promise.all([clientRejected, aborted, closed]);
    release();
    let health;
    for (let i = 0; i < 30; i++) {
      health = await f.health();
      if (!health.busy) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(health.busy, false);
    assert.equal(calls, 1);
    assert.equal(writes, 0, 'server must not write reply headers after disconnect');
    assert.equal(ended, 0, 'server must not end a reply after disconnect');
    assert.equal(finish, 0);
    assert.equal(health.completed, 0);
    assert.equal(f.logs.some(log => ['completion', 'error'].includes(log.event)), false);
  });
}
