import { BridgeError } from '../errors.mjs';
import { readEditorText } from './editor-text.mjs';

const APP_URL = 'https://gemini.google.com/app';
const COMPOSER = 'rich-textarea .ql-editor[contenteditable="true"], textarea[aria-label="Enter a prompt here"]';
const SEND = 'button[aria-label="Send message"], button[aria-label="Send"], button[aria-label="发送"]';
const RESET = 'button[aria-label="New chat"], a[aria-label="New chat"], button[aria-label="发起新对话"], a[aria-label="发起新对话"]';
const MODE = 'button.input-area-switch, button[data-test-id="bard-mode-menu-button"], button[data-test-id="model-selector"]';

// Inspect UI markers only; never inspect credential values or cookies.
async function accessState(page) {
  return page.evaluate(() => {
    const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const has = selector => [...document.querySelectorAll(selector)].some(visible);
    const controls = [...document.querySelectorAll('button, a, h1, h2, [role="heading"]')].filter(visible);
    if (/\/sorry\//.test(location.pathname)
      || has('#captcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], form[action*="/sorry/"]')
      || controls.some(el => /^(Verify (?:it's you|you are human)|验证您的身份|验证您是真人)$/i.test(el.textContent.trim()))) {
      return 'challenge_required';
    }
    if (location.hostname === 'accounts.google.com'
      || has('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/v3/signin"], input[type="password"]')
      || controls.some(el => /^(Sign in|Log in|登录|登入)$/i.test(el.textContent.trim()))) {
      return 'login_required';
    }
    return null;
  });
}

export function createGeminiAdapter(options = {}) {
  const models = Object.freeze((options.models ?? [{ id: 'gemini-4-argon', label: 'Argon' }])
    .map(({ id, label }) => Object.freeze({ id, label })));
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 20_000;
  const responseTimeoutMs = options.responseTimeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;
  let context;
  let busy = false;
  let state = 'idle';
  const fail = (message, code, submitted = false, status = 422) => new BridgeError(message, status, code, {
    generation_submitted: submitted, retryable: false,
  });

  async function browserContext() {
    if (!context) {
      const chromium = options.chromium ?? (await import('playwright-core')).chromium;
      context = await chromium.launchPersistentContext(options.profileDir, {
        executablePath: options.executablePath, headless: options.headless ?? false,
        viewport: { width: 1280, height: 900 },
        timeout: navigationTimeoutMs,
        ...(options.cdpPort ? { args: [`--remote-debugging-port=${options.cdpPort}`, '--remote-debugging-address=127.0.0.1'] } : {}),
      });
      const owned = context;
      owned.on('close', () => { if (context === owned) { context = undefined; state = 'disconnected'; } });
    }
    return context;
  }

  return {
    id: 'gemini', models, capabilities: Object.freeze({ images: false }),
    status: () => ({ state: busy ? 'busy' : state, ready: Boolean(context) && state === 'ready', busy }),
    async generate(request, { signal, deadlineMs } = {}) {
      if (signal?.aborted) throw fail('Gemini request was cancelled.', 'request_cancelled', false, 499);
      if (deadlineMs <= Date.now()) throw fail('Gemini request deadline expired.', 'request_timeout', false, 504);
      const model = models.find(model => model.id === request?.model);
      if (!model) {
        throw fail('Gemini model is not configured.', 'model_not_supported');
      }
      const prompt = request.messages.map(message => message.content).join('\n\n');
      busy = true;
      state = 'checking';
      let page;
      let submitted = false;
      let phase = 'launch';
      let cancelled, pageClosing, wake;
      const closePage = () => {
        if (!page) return;
        pageClosing ??= page.close({ runBeforeUnload: false }).catch(error => {
          if (!page.isClosed()) throw error;
        });
        return pageClosing;
      };
      const cancel = code => {
        cancelled ??= code;
        wake?.();
        // Interrupt Playwright waits, then await the same close in finally.
        closePage()?.catch(() => {});
      };
      const onAbort = () => cancel(signal.reason?.code === 'request_timeout' ? 'request_timeout' : 'request_cancelled');
      const check = () => {
        if (signal?.aborted) onAbort();
        if (deadlineMs <= Date.now()) cancel('request_timeout');
        if (cancelled) throw fail(cancelled === 'request_timeout'
          ? 'Gemini request deadline expired.' : 'Gemini request was cancelled.',
        cancelled, submitted, cancelled === 'request_timeout' ? 504 : 499);
      };
      const assertAccess = async () => {
        const access = await accessState(page);
        if (access) {
          state = access;
          throw fail(access === 'login_required' ? 'Gemini sign-in is required.' : 'Gemini requires a human verification.',
            access, submitted, access === 'login_required' ? 401 : 403);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const deadlineTimer = Number.isFinite(deadlineMs)
        ? setTimeout(() => cancel('request_timeout'), Math.max(1, deadlineMs - Date.now())) : undefined;
      try {
        check();
        const browser = await browserContext();
        check();
        page = await browser.newPage();
        check();
        phase = 'navigation';
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
        await assertAccess();
        phase = 'composer';
        await page.bringToFront();
        const composer = page.locator(COMPOSER).filter({ visible: true }).first();
        await composer.waitFor({ state: 'visible', timeout: navigationTimeoutMs });
        // A fresh /app document is already a new conversation. Clicking New chat
        // again can asynchronously reset the editor AFTER successful readback.
        if (await page.locator('user-query, model-response').count()) {
          phase = 'reset';
          await page.locator(RESET).filter({ visible: true }).first().click({ timeout: navigationTimeoutMs });
          await composer.waitFor({ state: 'visible', timeout: navigationTimeoutMs });
        }
        try {
          await page.waitForFunction(() => document.querySelectorAll('user-query, model-response').length === 0, null, { timeout: navigationTimeoutMs });
        } catch { throw fail('New conversation still contains old messages.', 'conversation_not_clean'); }
        phase = 'input';
        await composer.click({ timeout: navigationTimeoutMs });
        if (await composer.evaluate(el => el.tagName === 'TEXTAREA')) await composer.fill(prompt, { timeout: navigationTimeoutMs });
        else {
          await composer.press('ControlOrMeta+A'); await composer.press('Backspace');
          // Blink's multiline insertText produces extra blank lines in a bare
          // contenteditable; explicit soft breaks preserve the exact contract.
          for (const [index, line] of prompt.split('\n').entries()) {
            check();
            if (index) await page.keyboard.press('Shift+Enter');
            if (line) await page.keyboard.insertText(line);
          }
        }
        await page.waitForTimeout(100);
        const entered = await composer.evaluate(readEditorText);
        const normalize = text => text.replace(/\r\n?/g, '\n').trim();
        if (normalize(entered) !== normalize(prompt)) throw fail('Editor did not retain the complete request.', 'input_unverified');
        phase = 'mode';
        const picker = page.locator(MODE).filter({ visible: true });
        const matchesMode = async () => (await picker.innerText({ timeout: navigationTimeoutMs })).trim() === model.label;
        try {
          if (!(await matchesMode())) {
            await picker.click({ timeout: navigationTimeoutMs });
            await page.getByRole('menuitemradio', { name: model.label, exact: true }).click({ timeout: navigationTimeoutMs });
          }
          if (!(await matchesMode())) throw new Error('unverified mode');
        } catch {
          const labels = await picker.allTextContents().catch(() => []);
          const error = fail('Configured Gemini mode could not be verified.', 'model_selection_failed');
          error.details.observed_modes = labels.slice(0, 2).map(text => text.trim().slice(0, 80));
          throw error;
        }
        state = 'ready';
        if (!(await matchesMode())) throw fail('Configured Gemini mode changed before submission.', 'model_selection_failed');
        check();
        phase = 'submit';
        submitted = 'unknown';
        await page.locator(SEND).filter({ visible: true }).click({ timeout: navigationTimeoutMs });
        phase = 'response';
        const until = Date.now() + responseTimeoutMs;
        let previous = '';
        let settledSince = 0;
        while (Date.now() < until) {
          check();
          await assertAccess();
          const snapshot = await page.evaluate(() => {
            const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
            const buttons = [...document.querySelectorAll('button')].filter(visible);
            const response = [...document.querySelectorAll('model-response')].filter(visible).at(-1);
            const content = response?.querySelector('message-content .markdown');
            return {
              users: document.querySelectorAll('user-query').length,
              text: visible(content) ? content.innerText.trim() : '',
              generating: buttons.some(b => /^(Stop response|Stop generating|停止生成|停止回答)$/i.test(b.getAttribute('aria-label') || ''))
                || response?.getAttribute('aria-busy') === 'true',
              complete: [...(response?.querySelectorAll('button') || [])].some(b => visible(b) && /^(Copy response|Copy|复制回答|复制)$/i.test(b.getAttribute('aria-label') || '')),

            };
          });
          if (snapshot.users > 0) submitted = true;
          if (submitted === true && snapshot.text && !snapshot.generating && snapshot.complete) {
            if (snapshot.text !== previous) { previous = snapshot.text; settledSince = Date.now(); }
            else if (Date.now() - settledSince >= Math.max(250, pollMs * 2)) {
              check();
              return { text: snapshot.text, model: request.model };
            }
          } else { previous = ''; settledSince = 0; }
          await new Promise(resolve => {
            const timer = setTimeout(resolve, pollMs);
            wake = () => { clearTimeout(timer); resolve(); };
          });
          wake = undefined;
        }
        throw fail('Gemini completion could not be confirmed.', 'generation_timeout', submitted, 504);
      } catch (error) {
        check();
        if (page && !page.isClosed()) await assertAccess();
        if (!['login_required', 'challenge_required', 'disconnected'].includes(state)) state = 'unavailable';
        if (error instanceof BridgeError) throw error;
        throw new BridgeError(`Gemini page operation failed during ${phase}; check network/login or changed page controls.`, 503, 'browser_operation_failed', { phase, generation_submitted: submitted, retryable: false });
      } finally {
        clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', onAbort);
        try { await closePage(); } finally { busy = false; }
      }
    },
    async close() { await context?.close(); context = undefined; state = 'idle'; },
  };
}
