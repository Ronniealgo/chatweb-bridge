import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialLane } from '../bridge/queue.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a timed-out noncooperative adapter never overlaps the next request', async () => {
  const lane = new SerialLane({ requestTimeoutMs: 25, cancelGraceMs: 15, queueTimeoutMs: 200 });
  let active = 0, overlap = 0, nextRan = false;
  const first = lane.submit(async () => { active++; await sleep(100); active--; return 'late'; });
  const firstResult = first.catch(e => e);
  const secondResult = lane.submit(async () => { nextRan = true; overlap = active; return 'second'; }).catch(e => e);
  const failure = await firstResult;
  assert.equal(failure.code, 'request_timeout');
  await secondResult;
  await sleep(30); // allow the documented cancellation grace to expire
  assert.equal(overlap, 0);
  assert.equal(nextRan, false, 'quarantined lane must not drive the same browser');
  assert.equal(lane.snapshot().quarantined, true);
  await sleep(110);
  await lane.close();
});

test('expired queued requests are removed and never submitted', async () => {
  const lane = new SerialLane({ requestTimeoutMs: 1000, queueTimeoutMs: 20 });
  let ran = false;
  const first = lane.submit(async () => { await sleep(80); return 'ok'; });
  const queued = lane.submit(async () => { ran = true; return 'bad'; });
  await assert.rejects(queued, e => e.code === 'queue_timeout' && e.details.generation_submitted === false);
  await first;
  assert.equal(ran, false);
  assert.deepEqual(lane.snapshot(), { active: false, queued: 0, quarantined: false, closed: false });
  await lane.close();
});

test('a queued deadline is rechecked before dispatch even when timers were delayed', async () => {
  const lane = new SerialLane({ requestTimeoutMs: 500, queueTimeoutMs: 10 });
  const first = lane.submit(async () => { const until = Date.now() + 40; while (Date.now() < until) {} });
  let ran = false;
  const second = lane.submit(async () => { ran = true; }).catch(e => e);
  await first;
  assert.equal((await second).code, 'queue_timeout');
  assert.equal(ran, false);
  await lane.close();
});

test('capacity is bounded and a client abort frees its waiting slot', async () => {
  const lane = new SerialLane({ maxQueue: 1, requestTimeoutMs: 1000 });
  const first = lane.submit(async () => { await sleep(50); return 'ok'; });
  const ac = new AbortController();
  const queued = lane.submit(async () => 'never', { signal: ac.signal });
  assert.throws(() => lane.submit(async () => 'overflow'), e => e.code === 'queue_full');
  ac.abort();
  await assert.rejects(queued, e => e.code === 'request_cancelled');
  const replacement = lane.submit(async () => 'replacement');
  assert.equal(await replacement, 'replacement');
  await first;
  await lane.close();
});
