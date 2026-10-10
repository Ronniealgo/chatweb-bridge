import { bridgeAuth, adapterAuth, externalToken, upstreamToken, authFetch } from './http-auth-fixture.mjs';
const fetch = authFetch(externalToken);
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../server.mjs';

const tool = { type: 'function', function: { name: 'read_file', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
} } };
const request = overrides => ({ model: 'gpt-5-6-thinking', messages: [{ role: 'user', content: 'Read example.txt and report its contents.' }], tools: [tool], ...overrides });
const upstreamReply = (body, payload, extra = {}) => {
  const nonce = body.messages[0].content.match(/<(dsh_reply_[a-f0-9]+)>JSON<\//)?.[1];
  assert.ok(nonce, 'request must instruct the model with a unique envelope');
  return Response.json({ model: 'mock-model', choices: [{ message: { role: 'assistant', content: `<${nonce}>${JSON.stringify(payload)}</${nonce}>` }, finish_reason: 'stop', ...extra }] });
};
async function fixture(t, fetchImpl, options = {}) {
  const logs = [];
  const server = createBridge({ ...bridgeAuth, upstream: 'http://127.0.0.1:9', fetchImpl, logger: { info: x => logs.push(x), error: x => logs.push(x) }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, post, logs };
}

test('two-round JSON integration propagates assistant call and real harness result to final answer', async t => {
  const outbound = [];
  const f = await fixture(t, async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:9/v1/chat/completions');
    assert.equal(init.method, 'POST');
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    outbound.push(body);
    if (outbound.length === 1) return upstreamReply(body, { tool_calls: [{ name: 'read_file', arguments: { path: 'example.txt' } }] });
    const history = JSON.parse(body.messages[1].content).conversation;
    const call = history[1].tool_calls[0];
    const actualResult = history[2];
    assert.equal(actualResult.role, 'tool');
    assert.equal(actualResult.tool_call_id, call.id);
    assert.equal(actualResult.content, 'Only the mock harness knows this result: 314159');
    assert.deepEqual(call.arguments, { path: 'example.txt' });
    return upstreamReply(body, { content: `File contents: ${actualResult.content}` });
  });
  const first = await f.post(request());
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.model, 'mock-model');
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  const assistant = result.choices[0].message;
  const second = await f.post(request({ messages: [request().messages[0], assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'Only the mock harness knows this result: 314159' }] }));
  assert.equal(second.status, 200);
  const final = await second.json();
  assert.equal(final.choices[0].finish_reason, 'stop');
  assert.equal(final.choices[0].message.content, 'File contents: Only the mock harness knows this result: 314159');
  assert.equal(outbound.length, 2);
  const health = await (await fetch(`${f.base}/health`)).json();
  assert.equal(health.busy, false);
  assert.equal(health.requests, 2);
  assert.equal(health.completed, 2);
  assert.equal(health.toolRounds, 1);
  assert.equal(health.failed, 0);
  assert.equal(f.logs.join('\n').includes('314159'), false, 'completion logs must not leak tool output');
});

test('request IDs correlate the response, upstream request and logs without retaining failed text',async t=>{
 const secret='PRIVATE_FAILURE_BODY_482175';let forwarded;
 const f=await fixture(t,async(_url,init)=>{forwarded=init.headers['x-dsh-request-id'];return Response.json({choices:[{message:{content:secret},finish_reason:'stop'}]});});
 const r=await f.post(request());assert.equal(r.status,422);const body=await r.json();
 assert.equal(body.error.requestId,forwarded);assert.equal(r.headers.get('x-dsh-request-id'),forwarded);assert.equal(body.error.generation_submitted,true);assert.equal(body.error.phase,'protocol-parse');
 const logs=f.logs.map(JSON.parse);assert.ok(logs.every(e=>e.requestId===forwarded));assert.ok(logs.every(e=>e.timestamp));assert.equal(f.logs.join('').includes(secret),false);
 const sample=logs.find(e=>e.event==='protocol-failure-sample');assert.equal(sample.format,'plain-text');assert.equal(sample.characters,secret.length);
});
test('submitted state remains unknown across transport failures and is not shortened to pre-send cooldown',async t=>{
 let time=0,calls=0;const f=await fixture(t,async()=>{calls++;return Response.json({error:{code:'browser_operation_failed',phase:'generation-submit',generation_submitted:'unknown',message:'Browser disconnected'}},{status:502});},{now:()=>time});
 const first=await(await f.post(request())).json();assert.equal(first.error.phase,'generation-submit');assert.equal(first.error.generation_submitted,'unknown');
 time=4000;const blocked=await(await f.post(request())).json();assert.equal(blocked.error.code,'recent_failed_request');assert.equal(calls,1);assert.equal(blocked.error.retry_after_ms,56000);
});

for (const [name, payload, finish] of [
  ['tool calls', { tool_calls: [{ name: 'read_file', arguments: { path: 'example.txt' } }] }, 'tool_calls'],
  ['final text', { content: 'Hello 中文\nsecond line' }, 'stop'],
]) {
  test(`stream=true returns complete valid SSE for ${name}`, async t => {
    const f = await fixture(t, async (_url, init) => upstreamReply(JSON.parse(init.body), payload));
    const response = await f.post(request({ stream: true }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const events = (await response.text()).trim().split('\n\n').map(x => x.slice(6));
    assert.equal(events.pop(), '[DONE]');
    const chunks = events.map(JSON.parse);
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.equal(chunks.at(-1).choices[0].finish_reason, finish);
    if (finish === 'tool_calls') {
      const call = chunks[1].choices[0].delta.tool_calls[0];
      assert.equal(call.index, 0);
      assert.match(call.id, /^call_/);
      assert.deepEqual(JSON.parse(call.function.arguments), { path: 'example.txt' });
    } else assert.equal(chunks[1].choices[0].delta.content, payload.content);
  });
}

test('malformed tool batch returns JSON error before any SSE/tool output escapes', async t => {
  const f = await fixture(t, async (_url, init) => upstreamReply(JSON.parse(init.body), { tool_calls: [
    { name: 'read_file', arguments: { path: 'allowed' } }, { name: 'unknown', arguments: {} },
  ] }));
  const response = await f.post(request({ stream: true }));
  assert.equal(response.status, 422);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const body = await response.json();
  assert.equal(body.error.code, 'invalid_tool_protocol');
  assert.equal(Object.hasOwn(body, 'choices'), false);
});

for (const status of [401, 429, 503]) {
  test(`upstream HTTP ${status} is surfaced without retry and releases busy state`, async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return new Response('private upstream details', { status }); });
    const response = await f.post(request());
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, 'upstream_error');
    assert.ok(body.error.message.includes(`HTTP ${status}`));
    assert.equal(JSON.stringify(body).includes('private upstream details'), false);
    assert.equal(calls, 1);
    const health = await (await fetch(`${f.base}/health`)).json();
    assert.equal(health.busy, false);
    assert.equal(health.failed, 1);
  });
}

for (const [name, fetchImpl, status, code] of [
  ['network failure', async () => { throw new Error('internal secret'); }, 502, 'transport_error'],
  ['invalid upstream JSON', async () => new Response('{broken'), 502, 'transport_error'],
  ['truncated model response', async (_url, init) => upstreamReply(JSON.parse(init.body), { content: 'partial' }, { finish_reason: 'length' }), 502, 'incomplete_upstream'],
  ['missing model text', async () => Response.json({ choices: [{ message: {}, finish_reason: 'stop' }] }), 422, 'invalid_tool_protocol'],
]) {
  test(`${name} is an error with no retry`, async t => {
    let calls = 0;
    const f = await fixture(t, async (...args) => { calls++; return fetchImpl(...args); });
    const response = await f.post(request());
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.equal(JSON.stringify(body).includes('internal secret'), false);
    assert.equal(calls, 1);
  });
}

test('timeout aborts the upstream attempt, returns 504 and never retries', async t => {
  let calls = 0;
  const f = await fixture(t, async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  }, { timeoutMs: 25 });
  const response = await f.post(request());
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'transport_error');
  assert.equal(calls, 1);
});

test('an identical failed request is blocked locally while different requests remain available', async t => {
  let calls = 0;
  const f = await fixture(t, async (_url, init) => {
    calls++;
    if (calls === 1) return new Response('upstream failed', { status: 503 });
    return upstreamReply(JSON.parse(init.body), { content: 'different request succeeded' });
  });
  assert.equal((await f.post(request())).status, 503);
  const repeat = await f.post(request());
  assert.equal(repeat.status, 422);
  assert.equal((await repeat.json()).error.code, 'recent_failed_request');
  assert.equal(calls, 1);
  const changed = request({ messages: [{ role: 'user', content: 'This is a separate task.' }] });
  assert.equal((await f.post(changed)).status, 200);
  assert.equal(calls, 2);
});

test('confirmed pre-send failure keeps cause, short cooldown and permits recovery without extending suppression', async t => {
  let clock=1000,calls=0;
  const f=await fixture(t,async(_url,init)=>{
    if(++calls===1)return Response.json({error:{message:'Composer not ready; no send attempted.',code:'browser_not_ready',phase:'prepare',generation_submitted:false}},{status:422});
    return upstreamReply(JSON.parse(init.body),{content:'recovered'});
  },{now:()=>clock});
  const first=await f.post(request());assert.equal(first.status,422);assert.equal((await first.json()).error.code,'browser_not_ready');
  clock=2000;const cached=await (await f.post(request())).json();assert.equal(cached.error.original_code,'browser_not_ready');assert.equal(cached.error.retry_after_ms,2000);assert.equal(cached.error.generation_submitted,false);assert.equal(calls,1);
  clock=4001;assert.equal((await f.post(request())).status,200);assert.equal(calls,2);
});

test('uncertain submission stays suppressed for 60 seconds and never auto-replays', async t=>{
  let clock=0,calls=0;
  const f=await fixture(t,async()=>{calls++;return Response.json({error:{message:'Submission uncertain.',code:'browser_submission_uncertain',phase:'submit',generation_submitted:'unknown'}},{status:422});},{now:()=>clock});
  await f.post(request());clock=5000;const cached=await(await f.post(request())).json();
  assert.equal(cached.error.retry_after_ms,55000);assert.equal(cached.error.generation_submitted,'unknown');assert.equal(calls,1);
});

test('invalid protocol responses also suppress identical harness retries', async t => {
  let calls = 0;
  const f = await fixture(t, async (_url, init) => {
    calls++;
    return upstreamReply(JSON.parse(init.body), { tool_calls: [{ name: 'unknown', arguments: {} }] });
  });
  const first = await f.post(request());
  assert.equal(first.status, 422);
  assert.equal((await first.json()).error.code, 'invalid_tool_protocol');
  const repeat = await f.post(request());
  assert.equal(repeat.status, 422);
  assert.equal((await repeat.json()).error.code, 'recent_failed_request');
  assert.equal(calls, 1);
});

test('concurrent request gets 429 without touching upstream; active request completes and lock releases', async t => {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = await fixture(t, async (_url, init) => {
    calls++;
    entered();
    await wait;
    return upstreamReply(JSON.parse(init.body), { content: 'complete' });
  });
  const firstPending = f.post(request());
  await ready;
  assert.equal((await (await fetch(`${f.base}/health`)).json()).busy, true);
  const second = await f.post(request());
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'bridge_busy');
  assert.equal(calls, 1);
  release();
  assert.equal((await firstPending).status, 200);
  assert.equal((await (await fetch(`${f.base}/health`)).json()).busy, false);
  assert.equal((await f.post(request())).status, 200);
  assert.equal(calls, 2);
});

test('an over-long message (HTTP 413) is reported in the wording DSH recognises as context overflow, and is not cached as a failure that blocks the retry', async t => {
  let calls = 0;
  const localized = JSON.stringify({ error: { message: 'chat request failed (HTTP 413): {"detail":{"message":"你提交的消息过长，请编辑后重新发送。","code":"input_too_large","can_retry":false}}' } });
  const f = await fixture(t, async (_url, init) => {
    calls++;
    if (calls === 1) return new Response(localized, { status: 413, headers: { 'content-type': 'application/json' } });
    return upstreamReply(JSON.parse(init.body), { content: 'recovered after compaction' });
  });
  const first = await f.post(request());
  assert.equal(first.status, 413);
  const body = await first.json();
  assert.equal(body.error.code, 'context_length_exceeded');
  assert.match(body.error.message, /Prompt too long/i);
  // the harness compacts, then sends a DIFFERENT (shorter) request, which must go through
  const retry = await f.post(request({ messages: [{ role: 'user', content: 'A much shorter request after compaction.' }] }));
  assert.equal(retry.status, 200);
  assert.equal(calls, 2);
});
test('invalid client requests and browser-origin writes never call upstream', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('should not run'); });
  assert.equal((await f.post(request(), { origin: 'https://example.test' })).status, 403);
  assert.equal((await f.post(request(), { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.post(request(), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.post(request({ tool_choice: 'required', tools: [] }))).status, 400);
  assert.equal((await fetch(`${f.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await fetch(`${f.base}/v1/responses`, { method: 'POST' })).status, 415);
  assert.equal((await fetch(`${f.base}/v1/unsupported`, { method: 'POST', headers: {'content-type':'application/json'} })).status, 404);
  assert.equal(calls, 0);
  assert.equal((await (await fetch(`${f.base}/health`)).json()).busy, false);
});

test('remote, credential-bearing, non-HTTP and path-bearing upstreams are rejected', () => {
  for (const upstream of ['https://127.0.0.1', 'http://example.test', 'http://127.0.0.2', 'http://u:p@127.0.0.1', 'http://127.0.0.1/v1']) {
    assert.throws(() => createBridge({ ...bridgeAuth, upstream }), /loopback HTTP origin/);
  }
});

// --- image attachments (local feature) ---------------------------------------
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('image parts reach the upstream as temp files with markers and are cleaned up', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pcw-img-srv-'));
  process.env.PCW_UPLOAD_DIR = dir;
  t.after(() => { delete process.env.PCW_UPLOAD_DIR; rmSync(dir, { recursive: true, force: true }); });
  const seen = {};
  const f = await fixture(t, async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.body = body;
    seen.duringCall = existsSync(body.images[0].path) ? readFileSync(body.images[0].path) : null;
    return upstreamReply(body, { content: 'seen the image' });
  });
  const response = await f.post(request({ messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng.toString('base64')}` } },
    { type: 'text', text: '图里第一行字是什么' },
  ] }] }));
  assert.equal(response.status, 200);
  assert.deepEqual(seen.duringCall, tinyPng, 'the adapter reads the exact bytes while the upstream call runs');
  const image = seen.body.images[0];
  assert.equal(image.media_type, 'image/png');
  assert.equal(image.name, 'image-1.png');
  assert.match(image.path, /pcw-img-[0-9a-f-]+\.png$/);
  const transcript = JSON.parse(seen.body.messages[1].content).conversation;
  assert.equal(transcript[0].content, `[图片 #1]\n图里第一行字是什么`);
  assert.match(seen.body.messages[0].content, /image file is attached/);
  assert.equal(existsSync(image.path), false, 'temp file is deleted once the turn settles');
  const health = await (await fetch(`${f.base}/health`)).json();
  assert.equal(health.failed, 0);
  assert.equal(health.completed, 1);
});

test('remote image URLs and oversized bodies never reach the upstream', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; });
  const rejected = await f.post(request({ messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'https://example.test/pic.png' } }, { type: 'text', text: 'x' }] }] }));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'invalid_request');
  assert.equal(calls, 0);
  // 33 MiB body exceeds the raised cap (32 MiB) even though each image stays under 20 MiB.
  const big = Buffer.alloc(33 * 1024 * 1024, 7).toString('base64');
  const huge = await f.post(request({ messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } }, { type: 'text', text: 'x' }] }] }));
  assert.equal(huge.status, 413);
  assert.equal(calls, 0);
});
