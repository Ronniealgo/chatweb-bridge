import { bridgeAuth, adapterAuth, externalToken, upstreamToken, authFetch } from './http-auth-fixture.mjs';
const fetch = authFetch(upstreamToken);
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../server.mjs';
import { createModelRegistry } from '../model-routes.mjs';
import { ChatClient } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';

// Keep every adapter log in this test's own temporary directory. Authentication
// is replaced in memory before importing HTTP, so no credential file is read.
const cacheDir = mkdtempSync(join(tmpdir(), 'pcw-http-queue-'));
const previousCacheDir = process.env.PI_CHATGPT_WEB_CACHE_DIR;
process.env.PI_CHATGPT_WEB_CACHE_DIR = cacheDir;
const authKey = Symbol.for('pcw-http-queue-offline-auth');
const previousAuthStub = globalThis[authKey];
const authHandlers = new WeakMap();
globalThis[authKey] = {
  ensureFreshToken(chrome, ...args) {
    const handler = authHandlers.get(chrome);
    assert.ok(handler, 'authentication must be explicitly stubbed by this test');
    return handler(...args);
  },
};
const authURL = new URL('../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/auth/refresh.js', import.meta.url).href;
const authHook = registerHooks({
  load(url, context, nextLoad) {
    if (url !== authURL) return nextLoad(url, context);
    return {
      format: 'module', shortCircuit: true,
      source: `
        export class SessionExpiredError extends Error {}
        export const ensureFreshToken = (...args) =>
          globalThis[Symbol.for('pcw-http-queue-offline-auth')].ensureFreshToken(...args);
        export const refreshToken = () => { throw Error('Real authentication is forbidden in HTTP queue tests'); };
      `,
    };
  },
});
let AdapterServer, withBrowserOperation, operationState, operationQueueState, operationPhase;
try {
  ({ AdapterServer } = await import('../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/server/http.js'));
  ({ withBrowserOperation, operationState, operationQueueState, operationPhase } = await import('../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js'));
} finally {
  authHook.deregister();
}
after(() => {
  if (previousCacheDir === undefined) delete process.env.PI_CHATGPT_WEB_CACHE_DIR;
  else process.env.PI_CHATGPT_WEB_CACHE_DIR = previousCacheDir;
  if (previousAuthStub === undefined) delete globalThis[authKey];
  else globalThis[authKey] = previousAuthStub;
  assert.ok(realpathSync(cacheDir).startsWith(resolve(tmpdir()) + sep));
  rmSync(cacheDir, { recursive: true, force: true });
});

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
async function eventually(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
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
async function fixture(t) {
  const forbidden = () => { throw Error('Real browser and model access are forbidden in HTTP queue tests'); };
  const chrome = { page: null, ensureRunning: forbidden, fetchSession: forbidden, pageContext: forbidden, ping: forbidden, close: forbidden };
  // Do not call AdapterServer's constructor, which creates ManagedChrome.
  const app = Object.assign(Object.create(AdapterServer.prototype), { ...adapterAuth,
    chrome, chat: { run: forbidden }, opts: {}, busy: false, warmTimer: null,
  });
  const requests = [], errors = [];
  const realHandleChat = app.handleChat;
  app.handleChat = async (...args) => {
    try { return await realHandleChat.apply(app, args); }
    catch (error) { errors.push(error); throw error; }
  };
  app.server = createServer((req, res) => {
    requests.push(req);
    void app.handle(req, res).catch(error => { errors.push(error); res.destroy(); });
  });
  const base = await listen(t, app.server);
  return { app, chrome, base, requests, errors };
}
const bridgeBases = new Set();
function post(base, id, body = '{}', { path = '/v1/chat/completions', end = true, session = id, headers = {} } = {}) {
  const client = request(new URL(path, base), {
    method: 'POST', agent: false,
    headers: { 'authorization': 'Bearer ' + (bridgeBases.has(base) ? externalToken : upstreamToken), 'content-type': 'application/json', 'x-dsh-request-id': id, 'x-test-session': session, ...headers },
  });
  const response = new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('response', res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
  });
  // A cancelled socket is an expected outcome; attach a handler immediately.
  response.catch(() => {});
  if (end) client.end(body);
  else { client.flushHeaders(); client.write(body); }
  return { client, response };
}
async function hold(t, chrome, id = 'maintenance-owner') {
  const entered = deferred(), gate = deferred();
  const done = withBrowserOperation(chrome, 'readiness', id, async () => { entered.resolve(); await gate.promise; });
  t.after(async () => { gate.resolve(); await done; });
  await entered.promise;
  return { release: gate.resolve, done };
}
const validBody = ({ stream = false, responses = false } = {}) => JSON.stringify(responses
  ? { model: 'offline-model', input: 'Offline fixture prompt', stream }
  : { model: 'offline-model', messages: [{ role: 'user', content: 'Offline fixture prompt' }], stream });
function authSignal(args) {
  return args.flatMap(value => value instanceof AbortSignal ? [value] : value?.signal instanceof AbortSignal ? [value.signal] : []);
}

test('HTTP chat waits for an existing maintenance owner and executes exactly once', { timeout: 5_000 }, async t => {
  const f = await fixture(t), maintenance = await hold(t, f.chrome);
  let executions = 0;
  f.app.handleChatExclusive = async (_req, res, surface, signal) => {
    executions++;
    assert.equal(surface, 'chat');
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    assert.equal(operationState(f.chrome).requestId, 'chat-after-maintenance');
    f.app.json(res, 200, { executions });
  };
  const pending = post(f.base, 'chat-after-maintenance');
  await eventually(() => operationQueueState(f.chrome).queued === 1, 'chat should be queued behind maintenance');
  assert.equal(executions, 0);
  assert.equal(f.app.busy, false);
  const health = await (await fetch(f.base + '/health')).json();
  assert.equal(health.operation.requestId, 'maintenance-owner');
  assert.deepEqual(health.queue, { queued: 1, limit: 8 });
  maintenance.release();
  await maintenance.done;
  const response = await pending.response;
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { executions: 1 });
  assert.equal(executions, 1);
  assert.equal(operationState(f.chrome), null);
  assert.equal(f.app.busy, false);
});

test('independent HTTP sessions share one FIFO and never overlap generation', { timeout: 5_000 }, async t => {
  const f = await fixture(t), maintenance = await hold(t, f.chrome);
  const firstGate = deferred(), firstEntered = deferred();
  t.after(() => firstGate.resolve());
  const order = [], sessions = [];
  let active = 0, peak = 0;
  f.app.handleChatExclusive = async (req, res) => {
    active++; peak = Math.max(peak, active);
    const id = req.headers['x-dsh-request-id'];
    order.push(id); sessions.push(req.headers['x-test-session']);
    assert.equal(operationState(f.chrome).requestId, id);
    assert.equal(f.app.busy, true);
    try {
      if (id === 'fifo-one') { firstEntered.resolve(); await firstGate.promise; }
      f.app.json(res, 200, { id });
    } finally { active--; }
  };
  const pending = [];
  for (const [index, id] of ['fifo-one', 'fifo-two', 'fifo-three'].entries()) {
    pending.push(post(f.base, id, '{}', { session: `independent-session-${index}` }));
    await eventually(() => operationQueueState(f.chrome).queued === index + 1, `FIFO request ${index + 1} should be queued`);
  }
  maintenance.release();
  await firstEntered.promise;
  assert.deepEqual(order, ['fifo-one']);
  assert.equal(operationQueueState(f.chrome).queued, 2);
  firstGate.resolve();
  const responses = await Promise.all(pending.map(item => item.response));
  assert.ok(responses.every(response => response.status === 200));
  assert.deepEqual(order, ['fifo-one', 'fifo-two', 'fifo-three']);
  assert.deepEqual(sessions, ['independent-session-0', 'independent-session-1', 'independent-session-2']);
  assert.equal(peak, 1);
  assert.equal(operationState(f.chrome), null);
  assert.equal(operationQueueState(f.chrome).queued, 0);
  assert.equal(f.app.busy, false);
});

test('disconnecting a queued HTTP request removes it before any chat action runs', { timeout: 5_000 }, async t => {
  const f = await fixture(t), maintenance = await hold(t, f.chrome);
  const executed = [];
  f.app.handleChatExclusive = async (req, res) => {
    executed.push(req.headers['x-dsh-request-id']);
    f.app.json(res, 200, { ok: true });
  };
  const cancelled = post(f.base, 'queued-cancelled');
  await eventually(() => operationQueueState(f.chrome).queued === 1, 'request should first enter the queue');
  const survivor = post(f.base, 'queued-survivor');
  await eventually(() => operationQueueState(f.chrome).queued === 2, 'surviving request should queue second');
  cancelled.client.destroy();
  await assert.rejects(cancelled.response);
  await eventually(() => operationQueueState(f.chrome).queued === 1 && f.errors.length === 1, 'disconnect should remove the cancelled queue entry');
  const [error] = f.errors;
  assert.equal(error.code, 'adapter_queue_cancelled');
  assert.equal(error.status, 499);
  assert.equal(error.phase, 'queue');
  assert.equal(error.generationSubmitted, false);
  assert.equal(error.requestId, 'queued-cancelled');
  assert.deepEqual(executed, []);
  maintenance.release();
  assert.equal((await survivor.response).status, 200);
  assert.deepEqual(executed, ['queued-survivor']);
  assert.equal(operationState(f.chrome), null);
  assert.equal(operationQueueState(f.chrome).queued, 0);
});

test('aborting an unfinished JSON upload releases its owner without authentication or generation', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  let authCalls = 0, generations = 0, uploadSignal;
  authHandlers.set(f.chrome, () => { authCalls++; throw Error('Incomplete uploads must never authenticate'); });
  f.app.chat.run = async () => { generations++; throw Error('Incomplete uploads must never generate'); };
  const exclusive = f.app.handleChatExclusive;
  f.app.handleChatExclusive = async (...args) => { uploadSignal = args[3]; return exclusive.apply(f.app, args); };
  const partial = post(f.base, 'partial-upload', '{"messages": [', { end: false, headers: { 'content-length': '1000' } });
  await eventually(() => operationState(f.chrome)?.requestId === 'partial-upload', 'partial upload should own the browser operation');
  assert.ok(uploadSignal instanceof AbortSignal);
  partial.client.destroy();
  await assert.rejects(partial.response);
  await eventually(() => operationState(f.chrome) === null && !f.app.busy, 'aborted JSON upload must release the owner');
  assert.equal(uploadSignal.aborted, true);
  assert.equal(authCalls, 0);
  assert.equal(generations, 0);
  assert.equal(operationQueueState(f.chrome).queued, 0);
  const next = await post(f.base, 'request-after-upload', '{').response;
  assert.equal(next.status, 400);
  assert.match(JSON.parse(next.text).error.message, /invalid JSON/);
  assert.equal(operationState(f.chrome), null);
  assert.equal(authCalls, 0);
  assert.equal(generations, 0);
});

for (const responses of [false, true]) for (const stream of [false, true]) {
  test(`${responses ? 'Responses' : 'Chat Completions'} stream=${stream} carries one signal through queue, auth and chat`, { timeout: 5_000 }, async t => {
    const f = await fixture(t), maintenance = await hold(t, f.chrome);
    const id = `signal-${responses ? 'responses' : 'chat'}-${stream}`;
    let exclusiveSignal, observedAuthSignals, chatSignal, generations = 0;
    const exclusive = f.app.handleChatExclusive;
    f.app.handleChatExclusive = async (...args) => { exclusiveSignal = args[3]; return exclusive.apply(f.app, args); };
    authHandlers.set(f.chrome, (...args) => { observedAuthSignals = authSignal(args); return 'offline-placeholder'; });
    f.app.chat.run = async (turn, bearer) => {
      generations++; chatSignal = turn.signal;
      assert.equal(bearer, 'offline-placeholder');
      assert.equal(operationState(f.chrome).requestId, id);
      assert.equal(turn.signal.aborted, false);
      turn.onTextDelta?.('offline answer');
      return { model: 'offline-model', text: 'offline answer' };
    };
    const pending = post(f.base, id, validBody({ stream, responses }), { path: responses ? '/v1/responses' : '/v1/chat/completions' });
    await eventually(() => operationQueueState(f.chrome).queued === 1, 'signal fixture must actually exercise queue admission');
    maintenance.release();
    const response = await pending.response;
    assert.equal(response.status, 200);
    assert.ok(exclusiveSignal instanceof AbortSignal);
    assert.equal(chatSignal, exclusiveSignal);
    assert.equal(observedAuthSignals.length, 1, 'authentication must receive a request AbortSignal');
    assert.equal(observedAuthSignals[0], exclusiveSignal, 'authentication must receive the same request AbortSignal');
    assert.equal(generations, 1);
    assert.equal(exclusiveSignal.aborted, false, 'normal completion of the request body must not cancel generation');
    if (stream) assert.match(response.text, /data: \[DONE\]/);
    else assert.match(response.text, /offline answer/);
    assert.equal(operationState(f.chrome), null);
    assert.equal(f.app.busy, false);
  });
}

test('disconnect during offline auth prevents generation after auth resolves', { timeout: 5_000 }, async t => {
  const f = await fixture(t), authEntered = deferred(), authGate = deferred();
  t.after(() => authGate.resolve());
  let generations = 0, requestSignal;
  const exclusive = f.app.handleChatExclusive;
  f.app.handleChatExclusive = async (...args) => { requestSignal = args[3]; return exclusive.apply(f.app, args); };
  authHandlers.set(f.chrome, async () => { authEntered.resolve(); await authGate.promise; return 'offline-placeholder'; });
  f.app.chat.run = async () => { generations++; throw Error('Cancelled auth must not start generation'); };
  const pending = post(f.base, 'cancel-during-auth', validBody());
  await authEntered.promise;
  pending.client.destroy();
  await assert.rejects(pending.response);
  await eventually(() => requestSignal.aborted, 'auth must share the request cancellation lifetime');
  authGate.resolve();
  await eventually(() => operationState(f.chrome) === null, 'auth cancellation must release the owner');
  assert.equal(generations, 0);
  assert.equal(f.app.busy, false);
});

test('the bridge deadline header bounds the same signal through the active adapter request', {timeout:5000}, async t => {
  const f=await fixture(t);let reason;
  f.app.handleChatExclusive=async(_req,res,_surface,signal)=>{
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    reason=signal.reason?.name;
    f.app.json(res,504,{error:{code:'fixture_deadline'}});
  };
  const result=await post(f.base,'fixture-budget','{}',{headers:{'x-dsh-deadline-ms':String(Date.now()+40)}}).response;
  assert.equal(result.status,504);assert.equal(reason,'TimeoutError');
  assert.equal(operationState(f.chrome),null);
});

test('an unresolved browser transaction stops the next HTTP request before authentication', async t => {
  const f=await fixture(t);let auth=0,generation=0;
  f.chrome.pendingGeneration={};
  f.app.chat.assertNoPendingSubmission=async()=>{throw Object.assign(new Error('Blocked fixture'),{code:'browser_generation_pending',phase:'prepare',generationSubmitted:false});};
  authHandlers.set(f.chrome,()=>{auth++;return 'fixture';});
  f.app.chat.run=async()=>{generation++;};
  const result=await post(f.base,'fixture-fenced',validBody()).response;
  assert.equal(JSON.parse(result.text).error.code,'browser_operation_failed');
  assert.equal(auth,0);assert.equal(generation,0);
});

test('an uncertain submission failure is returned once without replaying chat', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  let generations = 0;
  authHandlers.set(f.chrome, () => 'offline-placeholder');
  f.app.chat.run = async () => {
    generations++;
    operationPhase(f.chrome, 'generation-submit', 'unknown');
    throw Error('Offline execution context was destroyed');
  };
  const response = await post(f.base, 'single-submit-failure', validBody()).response;
  assert.equal(response.status, 502);
  const { error } = JSON.parse(response.text);
  assert.equal(error.code, 'browser_operation_failed');
  assert.equal(error.phase, 'generation-submit');
  assert.equal(error.generation_submitted, 'unknown');
  assert.equal(error.requestId, 'single-submit-failure');
  assert.equal(generations, 1);
  assert.equal(operationState(f.chrome), null);
});

test('DSH bridge still rejects a genuinely overlapping request with bridge_busy and one upstream POST', { timeout: 5_000 }, async t => {
  const entered = deferred(), gate = deferred();
  t.after(() => gate.resolve());
  let posts = 0;
  const bridge = createBridge({ ...bridgeAuth,
    upstream: 'http://127.0.0.1:9', logger: { info() {}, error() {} },
    fetchImpl: async (_url, init) => {
      posts++;
      assert.equal(init.method, 'POST');
      assert.ok(JSON.parse(init.body).messages.length);
      entered.resolve(); await gate.promise;
      return Response.json({ model: 'offline-model', choices: [{ finish_reason: 'stop', message: { content: 'offline answer' } }] });
    },
  });
  const base = await listen(t, bridge); bridgeBases.add(base);
  const first = post(base, 'bridge-first', JSON.stringify({ ...JSON.parse(validBody()), model: 'gpt-5-6-thinking' }));
  await entered.promise;
  const overlapping = await post(base, 'bridge-overlap', JSON.stringify({ ...JSON.parse(validBody()), model: 'gpt-5-6-thinking' })).response;
  assert.equal(overlapping.status, 429);
  assert.equal(JSON.parse(overlapping.text).error.code, 'bridge_busy');
  assert.equal(posts, 1);
  gate.resolve();
  assert.equal((await first.response).status, 200);
  assert.equal(posts, 1);
});

for (const observed of [null, 'fixture-other-model', 'fixture-web-handoff']) {
  test(`strict handoff through both HTTP layers requires final identity: ${observed ?? 'missing'}`, async t => {
    const f = await fixture(t);
    authHandlers.set(f.chrome, async () => 'synthetic-auth-placeholder');
    f.chrome.pageContext = async () => ({});
    const client = new ChatClient(f.chrome);
    client.prepare = async () => {};
    let submissions = 0, reads = 0, userId, nonce, captured;
    client.sendWithSentinel = async (_page, body) => {
      submissions++; captured = body; userId = body.messages[0].id;
      nonce = body.messages[0].content.parts[0].match(/<(dsh_reply_[a-f0-9]+)>JSON<\//)[1];
      return `data: ${JSON.stringify({ type: 'stream_handoff', conversation_id: 'synthetic-handoff', options: [] })}\n\ndata: [DONE]\n\n`;
    };
    client.fetchConversationDetail = async () => {
      reads++;
      return { current_node: 'answer', mapping: {
        [userId]: { message: { id: userId, author: { role: 'user' } } },
        answer: { parent: userId, message: { id: 'answer', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
          status: 'finished_successfully', end_turn: true, metadata: observed ? { model_slug: observed } : {},
          content: { content_type: 'text', parts: [`<${nonce}>{"tool_calls":[{"name":"fixture_tool","arguments":{}}]}</${nonce}>`] } } },
      } };
    };
    f.app.chat = client;
    const modelRegistry = createModelRegistry({ schema: 1, models: [{ slug: 'fixture-web-handoff', display_name: 'Synthetic handoff',
      thinking_efforts: ['fixture-effort'], reasoning_efforts: { max: 'fixture-effort' }, default_effort: 'max', context_window: 100000, max_output_tokens: 10000,
      evidence: { source: 'chatgpt-web-account-metadata', captured_at: '2026-10-09T00:00:00Z', sha256: 'b'.repeat(64) } }] });
    const bridge = createBridge({ ...bridgeAuth, upstream: f.base, modelRegistry, logger: { info() {}, error() {} } });
    const base = await listen(t, bridge); bridgeBases.add(base);
    const body = JSON.stringify({ model: 'fixture-web-handoff', reasoning_effort: 'max', stream: true,
      messages: [{ role: 'user', content: 'Synthetic only' }],
      tools: [{ type: 'function', function: { name: 'fixture_tool', parameters: { type: 'object', properties: {} } } }] });
    const response = await post(base, 'synthetic-handoff-bridge', body).response;
    assert.equal(captured.model, 'fixture-web-handoff'); assert.equal(captured.thinking_effort, 'fixture-effort');
    assert.equal(submissions, 1); assert.equal(reads, 1); assert.equal(f.requests.length, 1);
    if (observed === 'fixture-web-handoff') {
      assert.equal(response.status, 200); assert.match(response.text, /"finish_reason":"tool_calls"/);
    } else {
      assert.equal(response.status, 422);
      const result = JSON.parse(response.text);
      assert.equal(result.error.code, observed ? 'browser_model_identity_mismatch' : 'browser_model_identity_unverified');
      assert.equal(result.error.generation_submitted, true); assert.equal(result.error.retryable, false);
      assert.equal(result.choices, undefined);
      const duplicate = await post(base, 'synthetic-handoff-duplicate', body).response;
      assert.equal(JSON.parse(duplicate.text).error.code, 'recent_failed_request');
      assert.equal(submissions, 1); assert.equal(f.requests.length, 1);
    }
  });
}
