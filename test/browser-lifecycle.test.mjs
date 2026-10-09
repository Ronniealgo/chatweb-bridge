import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ManagedChrome } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/supervisor.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pcw-lifecycle-'));
  const names = ['PI_CHATGPT_WEB_PROFILE_DIR', 'PI_CHATGPT_WEB_CHROME'];
  const before = names.map(k => process.env[k]);
  process.env.PI_CHATGPT_WEB_PROFILE_DIR = dir;
  process.env.PI_CHATGPT_WEB_CHROME = process.execPath;
  t.after(() => {
    names.forEach((k, i) => before[i] === undefined ? delete process.env[k] : process.env[k] = before[i]);
    assert.ok(realpathSync(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  const chrome = new ManagedChrome({ closeTimeoutMs: 20 });
  const queue = []; const events = [];
  chrome.puppeteer = { launch: async () => {
    events.push('launch');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, 'unexpected additional launch');
    return next;
  } };
  function browser({ goto, close, pages } = {}) {
    const result = new EventEmitter();
    result.closed = false;
    result.connected = true;
    result.page = {
      isClosed: () => result.closed,
      evaluateOnNewDocument: async () => {},
      goto: async () => { events.push('goto'); await goto?.(); },
    };
    result.pages = pages ?? (async () => [result.page]);
    result.close = async () => {
      events.push('close');
      await close?.();
      result.closed = true;
      result.connected = false;
      result.emit('disconnected');
    };
    queue.push(result);
    return result;
  }
  return { chrome, queue, events, browser };
}

test('navigation timeout releases the profile owner before a later successful launch', async t => {
  const f = fixture(t);
  const first = f.browser({ goto: async () => { throw Error('net::ERR_CONNECTION_TIMED_OUT'); } });
  const second = f.browser();
  await assert.rejects(f.chrome.ensureRunning(), /ERR_CONNECTION_TIMED_OUT/);
  assert.equal(first.closed, true);
  assert.equal(f.chrome.browser, null);
  assert.equal(f.chrome.page, null);
  assert.equal(f.chrome.booting, null);
  assert.equal(await f.chrome.ensureRunning(), second.page);
  assert.deepEqual(f.events, ['launch', 'goto', 'close', 'launch', 'goto']);
});

test('initial page enumeration failure also closes the launched browser', async t => {
  const f = fixture(t);
  const b = f.browser({ pages: async () => { throw Error('page initialization failed'); } });
  await assert.rejects(f.chrome.ensureRunning(), /page initialization failed/);
  assert.equal(b.closed, true);
  assert.equal(f.chrome.browser, null);
});

test('hung close terminates only its owned child and waits for its exit', async t => {
  const f = fixture(t);
  const b = f.browser({ close: () => new Promise(() => {}) });
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.pid = 12345;
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    setImmediate(() => { child.signalCode = signal; child.emit('exit'); });
    return true;
  };
  b.process = () => child;
  await f.chrome.ensureRunning();
  await f.chrome.close();
  assert.deepEqual(signals, ['SIGKILL']);
  assert.equal(f.chrome.browser, null);
  assert.equal(child.listenerCount('exit'), 0);
});

test('failed termination preserves ownership and prevents another launch', async t => {
  const f = fixture(t);
  const b = f.browser({ close: async () => { throw Error('close rejected'); } });
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.pid = 12345;
  child.kill = () => false;
  b.process = () => child;
  await f.chrome.ensureRunning();
  b.page.isClosed = () => true;
  await assert.rejects(f.chrome.ensureRunning(), /Could not terminate/);
  assert.equal(f.chrome.browser, b);
  assert.equal(f.events.filter(x => x === 'launch').length, 1);
});

test('a closed tab closes the previous browser before replacing it', async t => {
  const f = fixture(t);
  const first = f.browser(); const second = f.browser();
  await f.chrome.ensureRunning();
  first.page.isClosed = () => true;
  assert.equal(await f.chrome.ensureRunning(), second.page);
  assert.deepEqual(f.events, ['launch', 'goto', 'close', 'launch', 'goto']);
});

test('disconnected transport retains ownership until the old process is closed', async t => {
  const f = fixture(t);
  const first = f.browser(); const second = f.browser();
  await f.chrome.ensureRunning();
  first.emit('disconnected');
  assert.equal(f.chrome.browser, first);
  assert.equal(f.chrome.page, null);
  await f.chrome.ensureRunning();
  assert.equal(first.closed, true);
  first.emit('disconnected');
  assert.equal(f.chrome.browser, second);
  assert.equal(f.chrome.page, second.page);
});

test('failed cleanup keeps ownership and blocks another launch', async t => {
  const f = fixture(t);
  const first = f.browser({ goto: async () => { throw Error('navigation failed'); }, close: async () => { throw Error('close failed'); } });
  await assert.rejects(f.chrome.ensureRunning(), /navigation failed; managed browser cleanup failed: close failed/);
  assert.equal(f.chrome.browser, first);
  await assert.rejects(f.chrome.ensureRunning(), /close failed/);
  assert.equal(f.events.filter(x => x === 'launch').length, 1);
});

test('concurrent callers share startup and receive the same initialized page', async t => {
  const f = fixture(t);
  let release; const gate = new Promise(r => { release = r; });
  const b = f.browser({ goto: () => gate });
  const calls = [f.chrome.ensureRunning(), f.chrome.ensureRunning(), f.chrome.ensureRunning()];
  release();
  assert.deepEqual(await Promise.all(calls), [b.page, b.page, b.page]);
  assert.equal(f.events.filter(x => x === 'launch').length, 1);
});

test('service close waits for startup then releases its browser', async t => {
  const f = fixture(t);
  let release; const gate = new Promise(r => { release = r; });
  const b = f.browser({ goto: () => gate });
  const boot = f.chrome.ensureRunning(); const close = f.chrome.close();
  release();
  await Promise.all([boot, close]);
  assert.equal(b.closed, true);
  assert.equal(f.chrome.browser, null);
  await assert.rejects(f.chrome.ensureRunning(), /Managed browser is closed/);
});

test('a launch rejection leaves no cached rejected startup and no automatic retry', async t => {
  const f = fixture(t);
  f.queue.push(Error('Failed to launch the browser process'));
  await assert.rejects(f.chrome.ensureRunning(), error => error.code === 'browser_launch_failed' && error.generationSubmitted === false);
  assert.equal(f.chrome.booting, null);
  assert.equal(f.chrome.browser, null);
  assert.deepEqual(f.events, ['launch']);
});

