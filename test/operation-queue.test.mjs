import test, { after } from 'node:test';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  withBrowserOperation, operationState, operationPhase, operationQueueState,
} from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/operations.js';

// Keep the operation logger away from the running adapter's cache and logs.
const cache = mkdtempSync(join(tmpdir(), 'pcw-operation-queue-'));
const previousCache = process.env.PI_CHATGPT_WEB_CACHE_DIR;
const previousLevel = process.env.PI_CHATGPT_WEB_LOG_LEVEL;
process.env.PI_CHATGPT_WEB_CACHE_DIR = cache;
process.env.PI_CHATGPT_WEB_LOG_LEVEL = 'error';
after(() => {
  if (previousCache === undefined) delete process.env.PI_CHATGPT_WEB_CACHE_DIR;
  else process.env.PI_CHATGPT_WEB_CACHE_DIR = previousCache;
  if (previousLevel === undefined) delete process.env.PI_CHATGPT_WEB_LOG_LEVEL;
  else process.env.PI_CHATGPT_WEB_LOG_LEVEL = previousLevel;
  rmSync(cache, { recursive: true, force: true });
});

test('an expired waiter cannot run before its delayed timeout callback', async () => {
  const chrome = {};
  let release, executions = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const owner = withBrowserOperation(chrome, 'keep-warm', 'deadline-owner', () => gate);
  const pending = withBrowserOperation(chrome, 'chat', 'expired-waiter', () => { executions++; }, { queue: true, waitTimeoutMs: 5 });
  const rejected = assert.rejects(pending, error => error.code === 'adapter_queue_timeout' && error.generationSubmitted === false);
  const start = performance.now();
  while (performance.now() - start < 25) { /* Deliberately delay timers; fixture only. */ }
  release();
  await owner;
  await rejected;
  assert.equal(executions, 0);
  assert.equal(operationState(chrome), null);
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function hold(t, chrome, kind = 'keep-warm', requestId = 'maintenance') {
  const entered = deferred();
  const gate = deferred();
  const work = withBrowserOperation(chrome, kind, requestId, async () => {
    entered.resolve();
    await gate.promise;
  });
  t.after(async () => { gate.resolve(); await work; });
  await entered.promise;
  return { release: gate.resolve, releaseSignal: gate.promise, work };
}

function queueFailure(code, status, requestId) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.requestId, requestId);
    assert.equal(error.phase, 'queue');
    assert.equal(error.generationSubmitted, false);
    return true;
  };
}

test('an idle browser reports the bounded queue and executes foreground once', async () => {
  const chrome = {};
  assert.deepEqual(operationQueueState(chrome), { queued: 0, limit: 8 });
  let executions = 0;
  const result = await withBrowserOperation(chrome, 'chat', 'idle-user', async () => {
    executions++;
    assert.equal(operationState(chrome).requestId, 'idle-user');
    return 42;
  }, { queue: true });
  assert.equal(result, 42);
  assert.equal(executions, 1);
  assert.equal(operationState(chrome), null);
  assert.deepEqual(operationQueueState(chrome), { queued: 0, limit: 8 });
});

test('a 2.99-second maintenance hold scaled by 100 queues a chat without replay', async () => {
  const chrome = {};
  const events = [];
  const maintenance = withBrowserOperation(chrome, 'keep-warm', 'warm-sample', async () => {
    events.push('warm-start');
    await delay(2990 / 100);
    events.push('warm-end');
  });
  let submissions = 0;
  const chat = withBrowserOperation(chrome, 'chat', 'user-after-warm', async () => {
    submissions++;
    events.push('chat');
    return 'fixture-answer';
  }, { queue: true });
  assert.deepEqual(operationQueueState(chrome), { queued: 1, limit: 8 });
  assert.equal(submissions, 0);
  assert.equal(operationState(chrome).requestId, 'warm-sample');
  await maintenance;
  assert.equal(await chat, 'fixture-answer');
  assert.deepEqual(events, ['warm-start', 'warm-end', 'chat']);
  assert.equal(submissions, 1);
  assert.equal(operationState(chrome), null);
});

test('independent sessions sharing a browser execute in foreground FIFO order', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  const firstGate = deferred();
  const firstEntered = deferred();
  t.after(() => firstGate.resolve());
  const events = [];
  const sessions = ['session-a', 'session-b', 'session-c'];
  const jobs = sessions.map((id, index) => withBrowserOperation(chrome, 'chat', id, async () => {
    assert.equal(operationState(chrome).requestId, id);
    events.push(id);
    if (index === 0) { firstEntered.resolve(); await firstGate.promise; }
    return id;
  }, { queue: true }));
  assert.equal(operationQueueState(chrome).queued, 3);
  held.release();
  await firstEntered.promise;
  assert.deepEqual(events, ['session-a']);
  assert.equal(operationQueueState(chrome).queued, 2);
  firstGate.resolve();
  assert.deepEqual(await Promise.all(jobs), sessions);
  assert.deepEqual(events, sessions);
  assert.equal(operationQueueState(chrome).queued, 0);
});

test('separate browser objects can run while another browser has a full queue', async t => {
  const first = {};
  const second = {};
  const held = await hold(t, first);
  const queued = withBrowserOperation(first, 'chat', 'first-browser-user', () => 'first', { queue: true, maxQueued: 1 });
  let independentRuns = 0;
  assert.equal(await withBrowserOperation(second, 'chat', 'second-browser-user', () => {
    independentRuns++;
    return 'second';
  }, { queue: true }), 'second');
  assert.equal(independentRuns, 1);
  assert.equal(operationQueueState(first).queued, 1);
  assert.equal(operationQueueState(second).queued, 0);
  held.release();
  assert.equal(await queued, 'first');
});

test('navigation retains immediate adapter_busy rejection unless queueing was requested', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  let navigations = 0;
  await assert.rejects(withBrowserOperation(chrome, 'navigation', 'independent-navigation', () => {
    navigations++;
  }), queueFailure('adapter_busy', 429, 'independent-navigation'));
  assert.equal(navigations, 0);
  assert.equal(operationState(chrome).requestId, 'maintenance');
  assert.equal(operationQueueState(chrome).queued, 0);
  held.release();
});

test('owner reentry preserves transaction metadata while another session is queued', async t => {
  const chrome = {};
  const entered = deferred();
  const gate = deferred();
  t.after(() => gate.resolve());
  const owner = withBrowserOperation(chrome, 'chat', 'outer-user', async () => {
    operationPhase(chrome, 'prepare', false);
    entered.resolve();
    await gate.promise;
    return withBrowserOperation(chrome, 'composer', 'nested-id', async () => {
      assert.equal(operationState(chrome).requestId, 'outer-user');
      assert.equal(operationState(chrome).phase, 'prepare');
      assert.equal(operationQueueState(chrome).queued, 1);
      return 'nested-result';
    }, { background: true });
  }, { queue: true });
  await entered.promise;
  const next = withBrowserOperation(chrome, 'chat', 'next-session', () => 'next', { queue: true });
  gate.resolve();
  assert.equal(await owner, 'nested-result');
  assert.equal(await next, 'next');
  assert.equal(operationState(chrome), null);
});

test('cancelling a queued chat removes it immediately and never executes its action', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  const controller = new AbortController();
  let cancelledRuns = 0;
  const cancelled = withBrowserOperation(chrome, 'chat', 'cancelled-user', () => {
    cancelledRuns++;
  }, { queue: true, signal: controller.signal });
  const rejection = assert.rejects(cancelled, queueFailure('adapter_queue_cancelled', 499, 'cancelled-user'));
  const survivor = withBrowserOperation(chrome, 'chat', 'surviving-user', () => 'survived', { queue: true });
  assert.equal(operationQueueState(chrome).queued, 2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(new Error('fixture disconnect'));
  await rejection;
  assert.equal(operationQueueState(chrome).queued, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(operationState(chrome).requestId, 'maintenance');
  held.release();
  assert.equal(await survivor, 'survived');
  assert.equal(cancelledRuns, 0);
  assert.equal(operationState(chrome), null);
});

test('an already cancelled request does not enter the queue or acquire an idle browser', async t => {
  const chrome = {};
  const controller = new AbortController();
  controller.abort();
  let executions = 0;
  const action = () => { executions++; };
  await assert.rejects(withBrowserOperation(chrome, 'chat', 'cancelled-idle', action, {
    queue: true, signal: controller.signal,
  }), queueFailure('adapter_queue_cancelled', 499, 'cancelled-idle'));
  assert.equal(operationState(chrome), null);
  const held = await hold(t, chrome);
  await assert.rejects(withBrowserOperation(chrome, 'chat', 'cancelled-held', action, {
    queue: true, signal: controller.signal,
  }), queueFailure('adapter_queue_cancelled', 499, 'cancelled-held'));
  assert.equal(operationQueueState(chrome).queued, 0);
  assert.equal(executions, 0);
  held.release();
});

test('a queued timeout preserves the active maintenance owner and permits a later request', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  const controller = new AbortController();
  let expiredRuns = 0;
  const expired = withBrowserOperation(chrome, 'chat', 'expired-user', () => { expiredRuns++; }, {
    queue: true, waitTimeoutMs: 20, signal: controller.signal,
  });
  await assert.rejects(expired, queueFailure('adapter_queue_timeout', 429, 'expired-user'));
  assert.equal(operationState(chrome).requestId, 'maintenance');
  assert.equal(operationQueueState(chrome).queued, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const next = withBrowserOperation(chrome, 'chat', 'after-timeout', () => 'next', { queue: true });
  held.release();
  assert.equal(await next, 'next');
  assert.equal(expiredRuns, 0);
  assert.equal(operationState(chrome), null);
});

test('the default queue admits eight waiting requests and rejects the ninth without submission', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  const order = [];
  const jobs = Array.from({ length: 8 }, (_, index) => withBrowserOperation(chrome, 'chat', `waiting-${index}`, () => {
    order.push(index);
    return index;
  }, { queue: true }));
  assert.deepEqual(operationQueueState(chrome), { queued: 8, limit: 8 });
  let overflowRuns = 0;
  await assert.rejects(withBrowserOperation(chrome, 'chat', 'overflow-user', () => { overflowRuns++; }, {
    queue: true,
  }), queueFailure('adapter_queue_full', 429, 'overflow-user'));
  assert.equal(operationQueueState(chrome).queued, 8);
  assert.equal(operationState(chrome).requestId, 'maintenance');
  held.release();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(overflowRuns, 0);
  assert.equal(operationQueueState(chrome).queued, 0);
});

test('a caller can use a smaller queue limit and cancellation immediately frees capacity', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  const controller = new AbortController();
  const first = withBrowserOperation(chrome, 'chat', 'small-queue-first', () => 'first', {
    queue: true, maxQueued: 1, signal: controller.signal,
  });
  const rejection = assert.rejects(first, queueFailure('adapter_queue_cancelled', 499, 'small-queue-first'));
  await assert.rejects(withBrowserOperation(chrome, 'chat', 'small-queue-overflow', () => 'unexpected', {
    queue: true, maxQueued: 1,
  }), queueFailure('adapter_queue_full', 429, 'small-queue-overflow'));
  controller.abort();
  await rejection;
  const replacement = withBrowserOperation(chrome, 'chat', 'small-queue-replacement', () => 'replacement', {
    queue: true, maxQueued: 1,
  });
  held.release();
  assert.equal(await replacement, 'replacement');
});

test('a failed submitted operation releases ownership without replaying and drains its successor', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  let submissions = 0;
  const failed = withBrowserOperation(chrome, 'chat', 'submitted-failure', () => {
    submissions++;
    operationPhase(chrome, 'generation-submit', 'unknown');
    throw Error('fixture generation disconnect');
  }, { queue: true });
  const rejection = assert.rejects(failed, error => {
    assert.equal(error.requestId, 'submitted-failure');
    assert.equal(error.phase, 'generation-submit');
    assert.equal(error.generationSubmitted, 'unknown');
    return true;
  });
  const successor = withBrowserOperation(chrome, 'chat', 'after-failure', () => 'released', { queue: true });
  held.release();
  await rejection;
  assert.equal(await successor, 'released');
  assert.equal(submissions, 1);
  assert.equal(operationState(chrome), null);
});

test('maintenance yields to every queued foreground request without starvation', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  const gates = Array.from({ length: 3 }, () => deferred());
  const entries = Array.from({ length: 3 }, () => deferred());
  t.after(() => gates.forEach(gate => gate.resolve()));
  let backgroundRuns = 0;
  const events = [];
  const jobs = gates.map((gate, index) => withBrowserOperation(chrome, 'chat', `foreground-${index}`, async () => {
    events.push(index);
    entries[index].resolve();
    await gate.promise;
    return index;
  }, { queue: true }));
  const background = () => withBrowserOperation(chrome, 'keep-warm', 'background-tick', () => { backgroundRuns++; }, { background: true });
  assert.equal(await background(), undefined);
  held.release();
  await held.work;
  for (let index = 0; index < gates.length; index++) {
    await entries[index].promise;
    assert.equal(operationState(chrome).requestId, `foreground-${index}`);
    assert.equal(await background(), undefined);
    assert.equal(backgroundRuns, 0);
    gates[index].resolve();
    await jobs[index];
  }
  assert.deepEqual(events, [0, 1, 2]);
  assert.equal(operationState(chrome), null);
  assert.equal(await background(), undefined);
  assert.equal(backgroundRuns, 1);
  assert.equal(operationQueueState(chrome).queued, 0);
});

test('release reserves the FIFO owner before an independent maintenance microtask can run', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  const nextGate = deferred();
  const nextEntered = deferred();
  t.after(() => nextGate.resolve());
  const next = withBrowserOperation(chrome, 'chat', 'reserved-user', async () => {
    nextEntered.resolve();
    await nextGate.promise;
    return 'foreground';
  }, { queue: true });
  let overtakes = 0;
  // This reaction belongs to the caller's context and is already queued when
  // the previous owner resumes. A deferred reservation would let it overtake.
  const maintenance = held.releaseSignal.then(() => withBrowserOperation(chrome, 'keep-warm', 'release-tick', () => {
    overtakes++;
  }, { background: true }));
  held.release();
  await nextEntered.promise;
  assert.equal(await maintenance, undefined);
  assert.equal(overtakes, 0);
  assert.equal(operationState(chrome).requestId, 'reserved-user');
  nextGate.resolve();
  assert.equal(await next, 'foreground');
});

test('a queued signal listener is detached when ownership transfers successfully', async t => {
  const chrome = {};
  const held = await hold(t, chrome);
  const controller = new AbortController();
  let executions = 0;
  const queued = withBrowserOperation(chrome, 'chat', 'dequeued-user', () => { executions++; }, {
    queue: true, signal: controller.signal,
  });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  held.release();
  await queued;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  await delay(25);
  assert.equal(executions, 1);
  assert.equal(operationState(chrome), null);
});
