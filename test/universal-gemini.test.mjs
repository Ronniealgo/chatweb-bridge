import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const load = () => import('../bridge/adapters/gemini.mjs');

// Opt-in launches a new, headless browser with no user profile. ALL network
// requests are fulfilled/aborted locally. These are fixture tests, NOT live E2E.
describe('offline real-Chrome Gemini fixtures', { skip: process.env.GEMINI_FIXTURE_TESTS !== '1' }, () => {
  let browser, scratch;
  before(async () => {
    const { chromium } = await import(process.env.GEMINI_TEST_PLAYWRIGHT_MODULE || 'playwright-core');
    scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'gemini-fixtures-'));
    const harness = await chromium.launchPersistentContext(join(scratch, 'harness'), { headless: true,
      executablePath: process.env.GEMINI_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    browser = harness.browser();
  });
  after(async () => {
    await browser?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function fixture(t, fixtureOptions = {}, overrides = {}) {
    const { createGeminiAdapter } = await load();
    const html = await readFile(new URL('./fixtures/universal-gemini.html', import.meta.url), 'utf8');
    const state = { submits: [], modes: [], pages: [], contexts: [], launches: [] };
    const chromium = { async launchPersistentContext(profile, opts) {
      state.launches.push({ profile, ...opts });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      state.contexts.push(context);
      await context.addInitScript(options => { window.fixtureOptions = options; }, fixtureOptions);
      await context.exposeFunction('recordFixtureReady', () => { state.ready = true; });
      await context.exposeFunction('recordFixtureSubmit', (text, mode) => { state.submits.push(text); state.modes.push(mode); });
      await context.route('**/*', route => {
        if (route.request().isNavigationRequest() && route.request().url() === 'https://gemini.google.com/app') {
          return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        }
        return route.abort();
      });
      context.on('page', page => { state.pages.push(page); });
      return context;
    } };
    const adapter = createGeminiAdapter({ profileDir: join(scratch, 'adapter'), chromium,
      navigationTimeoutMs: 2000, responseTimeoutMs: 3000, pollMs: 20, ...overrides });
    t.after(() => adapter.close());
    return { adapter, state };
  }

  test('ignored submission is attempted once, fails uncertain, and is never replayed', async t => {
    const { adapter, state } = await fixture(t, { ignoreSubmission: true }, { responseTimeoutMs: 800 });
    await assert.rejects(adapter.generate(request()), error => error.code === 'generation_timeout' && error.details.generation_submitted === 'unknown' && error.details.retryable === false);
    assert.equal(state.submits.length, 1);
    assert.equal(state.pages[0].isClosed(), true);
  });

  test('unfinished generation never returns its visible partial text as success', async t => {
    const { adapter, state } = await fixture(t, { neverFinish: true }, { responseTimeoutMs: 800 });
    await assert.rejects(adapter.generate(request()), error => error.code === 'generation_timeout' && error.details.generation_submitted === true && error.details.retryable === false);
    assert.equal(state.submits.length, 1);
    assert.equal(state.pages[0].isClosed(), true);
  });

  test('editor text ignores CSS paragraph spacing but preserves semantic blank lines', async t => {
    const { readEditorText } = await import('../bridge/adapters/editor-text.mjs');
    const page = await browser.newPage(); t.after(() => page.close());
    await page.setContent('<div id="editor"><p>first</p><p><br></p><p>second</p></div>');
    assert.equal(await page.locator('#editor').evaluate(readEditorText), 'first\n\nsecond');
  });

  test('submits the complete prepared contract in a fresh reset chat', async t => {
    const { adapter, state } = await fixture(t);
    const payload = request('history, quotes " and Unicode 中文\nsecond line');
    const result = await adapter.generate(payload);
    assert.deepEqual(result, { text: 'Verified complete response.', model: payload.model });
    assert.equal(state.submits.length, 1);
    assert.equal(state.submits[0], payload.messages.map(m => m.content).join('\n\n'));
    assert.equal(state.pages.length, 1);
    assert.equal(state.pages[0].isClosed(), true);
    assert.equal(state.launches[0].headless, false, 'production default is visible, fixture injection stays headless');
    assert.ok(!(state.launches[0].args || []).some(arg => /debugging|AutomationControlled/.test(arg)));
  });

  test('a clean freshly navigated page does not require an extra reset navigation', async t => {
    const { adapter } = await fixture(t, { resetUnavailable: true });
    assert.equal((await adapter.generate(request())).text, 'Verified complete response.');
  });

  test('real layout: duplicate reset links, Quill clipboard, and mode hidden until input', async t => {
    const { adapter, state } = await fixture(t, { realLayout: true });
    const result = await adapter.generate(request());
    assert.equal(result.text, 'Verified complete response.');
    assert.equal(state.submits.length, 1);
    assert.equal(state.modes[0], 'Argon');
  });

  test('closed browser context is marked disconnected and recreated for the next request', async t => {
    const { adapter, state } = await fixture(t);
    await adapter.generate(request());
    await state.contexts[0].close();
    assert.equal(adapter.status().ready, false);
    assert.equal((await adapter.generate(request())).text, 'Verified complete response.');
    assert.equal(state.launches.length, 2);
  });

  test('dirty reset is rejected before submission', async t => {
    const { adapter, state } = await fixture(t, { ignoreReset: true });
    await assert.rejects(adapter.generate(request()), e => e.code === 'conversation_not_clean');
    assert.equal(state.submits.length, 0);
  });

  test('lost editor input is rejected before submission', async t => {
    const { adapter, state } = await fixture(t, { dropInput: true });
    await assert.rejects(adapter.generate(request()), e => e.code === 'input_unverified');
    assert.equal(state.submits.length, 0);
  });

  test('Chinese completed-response control is recognized', async t => {
    const { adapter } = await fixture(t, { copyLabel: '复制回答' });
    assert.equal((await adapter.generate(request())).text, 'Verified complete response.');
  });

  test('selects and verifies the configured visible model before submission', async t => {
    const { adapter, state } = await fixture(t, { selectedLabel: 'Fast' });
    await adapter.generate(request());
    assert.deepEqual(state.modes, ['Argon']);
  });

  test('confirms completed responses even when the emptied composer disables send', async t => {
    const { adapter, state } = await fixture(t, { disableAfterSubmit: true });
    assert.equal((await adapter.generate(request())).text, 'Verified complete response.');
    assert.equal(state.submits.length, 1);
  });

  test('fails closed when the model selection click does not change mode', async t => {
    const { adapter, state } = await fixture(t, { selectedLabel: 'Fast', ignoreSelection: true });
    await assert.rejects(adapter.generate(request()), error => {
      assert.equal(error.code, 'model_selection_failed');
      assert.equal(error.status, 422);
      assert.equal(error.details.generation_submitted, false);
      assert.equal(error.details.retryable, false);
      return true;
    });
    assert.equal(state.submits.length, 0);
    assert.equal(state.pages[0].isClosed(), true);
  });

  for (const phase of ['before submission', 'after submission']) {
    test(`abort closes and awaits the active page ${phase}`, async t => {
      const submitted = phase === 'after submission';
      const { adapter, state } = await fixture(t, { resetUnavailable: !submitted, neverFinish: true });
      const controller = new AbortController();
      const rejected = assert.rejects(adapter.generate(request(), { signal: controller.signal }), error => {
        assert.equal(error.code, 'request_cancelled');
        assert.equal(error.status, 499);
        assert.ok(submitted ? [true, 'unknown'].includes(error.details.generation_submitted)
          : error.details.generation_submitted === false);
        assert.equal(error.details.retryable, false);
        return true;
      });
      await until(() => submitted ? state.submits.length === 1 : state.ready === true);
      controller.abort();
      await rejected;
      assert.equal(state.pages[0].isClosed(), true);
      assert.equal(adapter.status().busy, false);
      assert.equal(state.submits.length, submitted ? 1 : 0);
      assert.equal(state.contexts[0].browser().isConnected(), true);
    });
  }

  test('the absolute request deadline interrupts an in-flight response', async t => {
    const { adapter, state } = await fixture(t, { neverFinish: true });
    await assert.rejects(adapter.generate(request(), { deadlineMs: Date.now() + 1500 }), error => {
      assert.equal(error.code, 'request_timeout');
      assert.equal(error.status, 504);
      assert.equal(error.details.generation_submitted, true);
      return true;
    });
    assert.equal(state.submits.length, 1);
    assert.equal(state.pages[0].isClosed(), true);
    assert.equal(adapter.status().busy, false);
  });

  for (const [access, code, status] of [['login', 'login_required', 401], ['challenge', 'challenge_required', 403]]) {
    test(`${access} UI is not reported as ready merely because a context exists`, async t => {
      const { adapter, state } = await fixture(t, { access });
      await assert.rejects(adapter.generate(request()), error => {
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.equal(error.details.generation_submitted, false);
      assert.equal(error.details.retryable, false);
        return true;
      });
      assert.deepEqual(adapter.status(), { state: code, ready: false, busy: false });
      assert.equal(state.submits.length, 0);
      assert.equal(state.pages[0].isClosed(), true);
    });
  }
});

async function until(predicate, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Fixture condition was not reached.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Gemini configuration is lazy, explicit and immutable', async () => {
  const { createGeminiAdapter } = await load();
  let launches = 0;
  const adapter = createGeminiAdapter({
    profileDir: 'unused-fixture-profile',
    chromium: { launchPersistentContext() { launches++; throw new Error('must stay lazy'); } },
  });
  assert.equal(adapter.id, 'gemini');
  assert.deepEqual(adapter.models, [{ id: 'gemini-4-argon', label: 'Argon' }]);
  assert.deepEqual(adapter.capabilities, { images: false });
  assert.equal(adapter.status().ready, false);
  assert.equal(launches, 0);
  await adapter.close();
  assert.equal(launches, 0);
});

const request = (content = 'current turn') => ({ model: 'gemini-4-argon', messages: [
  { role: 'system', content: 'Transport contract: preserve roles and return <nonce>JSON</nonce>.' },
  { role: 'user', content: JSON.stringify({ conversation: [{ role: 'user', content }] }) },
] });

for (const kind of ['cancelled', 'expired']) {
  test(`rejects ${kind} requests before starting any browser`, async () => {
    const { createGeminiAdapter } = await load();
    const controller = new AbortController();
    if (kind === 'cancelled') controller.abort();
    let launches = 0;
    const adapter = createGeminiAdapter({ chromium: {
      launchPersistentContext() { launches++; throw new Error('unexpected launch'); },
    } });
    await assert.rejects(adapter.generate(request(), {
      signal: controller.signal, deadlineMs: kind === 'expired' ? Date.now() - 1 : Date.now() + 1000,
    }), error => {
      assert.equal(error.code, kind === 'expired' ? 'request_timeout' : 'request_cancelled');
      assert.equal(error.details.generation_submitted, false);
      return true;
    });
    assert.equal(launches, 0);
    assert.equal(adapter.status().busy, false);
  });
}

test('rejects unconfigured models before starting any browser', async () => {
  const { createGeminiAdapter } = await load();
  let launches = 0;
  const adapter = createGeminiAdapter({ profileDir: 'unused', chromium: {
    launchPersistentContext() { launches++; throw new Error('unexpected launch'); },
  } });
  await assert.rejects(adapter.generate({ ...request(), model: 'unconfigured-model' }), error => {
    assert.equal(error.code, 'model_not_supported');
    assert.equal(error.details.generation_submitted, false);
    assert.equal(error.details.retryable, false);
    return true;
  });
  assert.equal(launches, 0);
});
