import { bridgeAuth, adapterAuth, externalToken, upstreamToken, authFetch } from './http-auth-fixture.mjs';
const fetch = authFetch(upstreamToken);
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ChatClient } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';
import { observeConversationTransaction } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/submission.js';
import { operationState, withBrowserOperation } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js';
import { AdapterServer } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/server/http.js';
import { safeTransportDetails } from '../diagnostics.mjs';

// Run the real in-page functions in a fresh VM with a fake fetch. No browser,
// model requests, token files or external endpoint is used by these tests.
function fixture({ ignoreAbort = false, text = 'fixture-result', rejectFetch = false, rejectText = false } = {}) {
  let resolve, reject, posts = 0, observations = 0, aborts = 0, startCalls = 0;
  const network = new Promise((yes, no) => { resolve = yes; reject = no; });
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout,
    fetch: (_route, init) => {
      posts++;
      init.signal.addEventListener('abort', () => { aborts++; if (!ignoreAbort) reject(new Error('synthetic abort')); }, { once: true });
      return rejectFetch ? Promise.reject(new TypeError('SYNTHETIC_PRIVATE_TEXT')) : network;
    } });
  const page = { evaluate: async (fn, ...args) => {
    if (fn.name === 'startConversationTransaction') startCalls++; else observations++;
    context.args = args;
    const result = vm.runInContext(`(${fn.toString()})(...args)`, context);
    assert.equal(typeof result?.then, 'undefined', 'CDP must never await a fetch promise');
    return structuredClone(result);
  } };
  const chrome = {};
  const client = new ChatClient(chrome, { pollMs: 2, cleanupMs: 20, observationTimeoutMs: 30 });
  const finish = () => resolve({ status: 200, ok: true, text: async () => {
    if (rejectText) throw new TypeError('SYNTHETIC_PRIVATE_TEXT');
    return text;
  } });
  const rejectRequest = () => reject(new TypeError('SYNTHETIC_PRIVATE_TEXT'));
  return { client, chrome, page, finish, rejectRequest, counts: () => ({ posts, observations, aborts, startCalls }) };
}
const waitFor = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(r => setTimeout(r, 2)); assert.ok(predicate()); };

test('a response beyond 180s uses one POST and short CDP observations, with the lock held', async () => {
  const f = fixture(); let clock = 0, maintenance = 0;
  f.client.submission.now = () => clock;
  f.client.submission.wait = async () => {
    clock += 25_000;
    assert.ok(operationState(f.chrome), 'generation owner must cover the entire browser fetch');
    await withBrowserOperation(f.chrome, 'keep-warm', null, () => { maintenance++; }, { background: true });
    if (clock >= 200_000) f.finish();
  };
  const result = await withBrowserOperation(f.chrome, 'chat', 'fixture-long',
    () => f.client.postConversationInPage(f.page, { model: 'fixture-model' }, {}, new AbortController().signal));
  assert.equal(result, 'fixture-result');
  assert.ok(clock >= 200_000 && clock < 240_000);
  assert.equal(f.counts().posts, 1);
  assert.equal(f.counts().startCalls, 1);
  assert.ok(f.counts().observations > 2);
  assert.equal(maintenance, 0);
  assert.equal(f.chrome.pendingGeneration, null);
  assert.equal(operationState(f.chrome), null);
});

test('caller cancellation aborts once and confirms browser termination before releasing the owner', async () => {
  const f = fixture(), ac = new AbortController();
  const run = withBrowserOperation(f.chrome, 'chat', 'fixture-cancel',
    () => f.client.postConversationInPage(f.page, {}, {}, ac.signal));
  const failure = assert.rejects(run, e => e.code === 'adapter_request_cancelled' &&
    e.generationSubmitted === 'unknown' && e.details.reason === 'caller_cancelled' && e.details.terminationConfirmed);
  await waitFor(() => f.counts().posts === 1);
  ac.abort(); await failure;
  assert.equal(f.counts().posts, 1); assert.equal(f.counts().aborts, 1);
  assert.equal(f.chrome.pendingGeneration, null); assert.equal(operationState(f.chrome), null);
});

test('unconfirmed abort fences later generations and maintenance, then clears only after settlement', async () => {
  const f = fixture({ ignoreAbort: true }), ac = new AbortController();
  const run = withBrowserOperation(f.chrome, 'chat', 'fixture-unknown',
    () => f.client.postConversationInPage(f.page, {}, {}, ac.signal));
  const failure = assert.rejects(run, e => e.code === 'adapter_request_cancelled' && !e.details.terminationConfirmed);
  await waitFor(() => f.counts().posts === 1); ac.abort(); await failure;
  assert.ok(f.chrome.pendingGeneration);
  await assert.rejects(f.client.postConversationInPage(f.page, {}, {}), e => e.code === 'browser_generation_pending' && e.generationSubmitted === false);
  let background = 0;
  await withBrowserOperation(f.chrome, 'keep-warm', null, () => { background++; }, { background: true });
  assert.equal(background, 0); assert.equal(f.counts().posts, 1);
  f.finish(); await new Promise(r => setTimeout(r, 1));
  await f.client.assertNoPendingSubmission();
  assert.equal(f.chrome.pendingGeneration, null);
  assert.equal(f.counts().posts, 1, 'settlement discards the old result; never replays it');
});

test('generation deadline aborts an in-flight fetch without misclassifying it as destroyed context', async () => {
  const f = fixture(); f.client.submission.timeoutMs = 15;
  await assert.rejects(f.client.postConversationInPage(f.page, {}, {}), e =>
    e.code === 'browser_generation_timeout' && e.details.reason === 'generation_deadline' && e.details.terminationConfirmed);
  assert.equal(f.counts().posts, 1); assert.equal(f.counts().aborts, 1);
});

for (const mode of ['rejectFetch', 'rejectText']) test(`${mode} classifies status0/read failure without leaking exceptions or replaying`, async () => {
  const f = fixture({ [mode]: true });
  const pending = f.client.postConversationInPage(f.page, {}, {});
  if (mode === 'rejectText') f.finish();
  await assert.rejects(pending, e => {
    assert.equal(e.code, 'browser_fetch_failed');
    assert.equal(e.generationSubmitted, mode === 'rejectText' ? true : 'unknown');
    assert.equal(e.details.reason, mode === 'rejectText' ? 'response_read_failed' : 'fetch_failed');
    assert.equal(e.details.terminationConfirmed, true);
    assert.equal(JSON.stringify(e).includes('SYNTHETIC_PRIVATE_TEXT'), false);
    return true;
  });
  assert.equal(f.counts().posts, 1);
});

test('lost context retains an uncertainty fence; a second call cannot navigate or submit', async () => {
  const f = fixture(); const evaluate = f.page.evaluate;
  f.page.evaluate = async (fn, ...args) => {
    if (fn.name === 'observeConversationTransaction') throw new Error('Execution context was destroyed: SYNTHETIC_PRIVATE_TEXT');
    return evaluate(fn, ...args);
  };
  await assert.rejects(f.client.postConversationInPage(f.page, {}, {}), e => e.code === 'browser_submission_uncertain' &&
    e.details.reason === 'context_lost' && !e.details.terminationConfirmed && !JSON.stringify(e).includes('SYNTHETIC_PRIVATE_TEXT'));
  let navigation = 0; f.chrome.pageContext = async () => { navigation++; return f.page; };
  await assert.rejects(f.client.runExclusive({ prompt: 'fixture' }, 'fixture'), e => e.code === 'browser_generation_pending');
  assert.equal(navigation, 0); assert.equal(f.counts().posts, 1);
  f.finish(); await new Promise(r => setTimeout(r, 1)); f.page.evaluate = evaluate;
  await f.client.assertNoPendingSubmission();
});

test('a hanging state read is bounded and cannot clear the uncertainty fence', async () => {
  const f = fixture(); const evaluate = f.page.evaluate;
  f.page.evaluate = (fn, ...args) => fn.name === 'observeConversationTransaction' ? new Promise(() => {}) : evaluate(fn, ...args);
  await assert.rejects(f.client.postConversationInPage(f.page, {}, {}), e => e.details.reason === 'observation_timeout' && !e.details.terminationConfirmed);
  assert.ok(f.chrome.pendingGeneration); assert.equal(f.counts().posts, 1);
  f.finish();
});

test('diagnostics on a fenced generation never inspect the page or authenticate', async () => {
  const app = new AdapterServer(adapterAuth);
  app.chrome = { pendingGeneration: {}, page: { isClosed() { throw Error('Must not touch page'); } } };
  const body = await app.doctorReport();
  assert.equal(body.generationBlocked, true); assert.equal(body.authenticated, null);
  assert.equal(body.authenticationCheck, 'not_performed');
});

test('diagnostic pass-through accepts only enums, bounded numbers and booleans', () => {
  assert.deepEqual(safeTransportDetails({ reason: 'SYNTHETIC_PRIVATE_TEXT', elapsedMs: Infinity, token: 'SYNTHETIC_PRIVATE_TEXT', terminationConfirmed: 'true' }), {});
  assert.deepEqual(safeTransportDetails({ reason: 'cdp_timeout', elapsedMs: 100_000_000, terminationConfirmed: false }),
    { reason: 'cdp_timeout', elapsedMs: 86_400_000, terminationConfirmed: false });
});
