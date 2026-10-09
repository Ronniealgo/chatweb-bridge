import { readServiceToken, requireServiceToken, requireIndependentTokens } from './http-security.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const directory = dirname(fileURLToPath(import.meta.url));
export const services = [
  { name: 'pi-chatgpt-web-adapter', port: 1456, file: 'pcw.mjs', args: ['serve'] },
  { name: 'dsh-chat-tool-bridge', port: 1457, file: 'server.mjs', args: [] },
];
const safeCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EACCES', 'EAGAIN', 'ENOENT', 'ENOMEM', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const safeNames = new Set(['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'AbortError']);
const safeKinds = new Set(['invalid_budget', 'health_http', 'service_identity_mismatch', 'child_exited', 'startup_budget_exhausted', 'health_get_budget_exhausted', 'service_auth_unverified']);
const kindOf = (error, fallback) => safeKinds.has(error?.kind) ? error.kind : fallback;
function errorInfo(error) {
  const code = error?.cause?.code ?? error?.code;
  return { type: safeNames.has(error?.name) ? error.name : 'Error', code: safeCodes.has(code) ? code : 'OTHER' };
}
function fault(kind, details = {}) {
  return Object.assign(new Error(kind), { kind, details });
}
function retryable(error) {
  const info = errorInfo(error);
  return info.type === 'TimeoutError' || info.type === 'AbortError' || ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(info.code);
}

export function createManager(options = {}) {
  const root = options.directory ?? directory;
  const list = options.services ?? services;
  const fetchHealth = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const healthMs = options.healthMs ?? 1500;
  const attempts = options.attempts ?? 40;
  // Retain the old worst-case budget: 40 * (250ms delay + 1500ms health).
  // Spread fast connection refusals across that budget instead of spending it in 10s.
  const startupMs = options.startupMs ?? 70000;
  const firstDelay = options.firstDelay ?? 250;
  if (attempts < 1 || startupMs < healthMs + firstDelay) throw fault('invalid_budget');
  const spacing = attempts === 1 ? 0 : (startupMs - healthMs - firstDelay) / (attempts - 1);
  const maxGET = options.maxGET ?? list.length * (attempts + 1);
  if (!Number.isInteger(maxGET) || maxGET < 1 || maxGET > list.length * (attempts + 1)) throw fault('invalid_budget');
  let healthGET = 0;
  const runId = options.runId ?? randomUUID();
  const started = now();
  const out = options.out ?? (line => console.log(line));
  const err = options.err ?? (line => console.error(line));
  const env = { PCW_TEMPORARY_CHAT: '1', ...(options.env ?? process.env) };
  let authenticatedHealth = false;
  const tokenFor = service => options.serviceTokens ? options.serviceTokens[service.port] : readServiceToken(service.port === 1456 ? 'PCW_INTERNAL_TOKEN' : 'DSH_CHAT_API_TOKEN', undefined, env);
  if (options.minimized) env.PCW_CHROME_ARGS = [env.PCW_CHROME_ARGS, '--start-minimized'].filter(Boolean).join(' ');
  const journal = options.journal ?? (event => {
    mkdirSync(join(root, '.runtime'), { recursive: true });
    appendFileSync(join(root, '.runtime', 'startup.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  });
  let journalFailed = false;
  function emit(event) {
    try { journal({ runId, utc: new Date().toISOString(), elapsedMs: Math.round((now() - started) * 1000) / 1000, ...event }); }
    catch {
      journalFailed = true;
      try { err('startup_log_write_failed'); } catch { /* logging must not block another service */ }
    }
  }
  const launch = options.launch ?? (async service => {
    mkdirSync(join(root, '.runtime'), { recursive: true });
    const fd = openSync(join(root, '.runtime', `${service.port}.log`), 'a');
    let child;
    let launchError;
    let exit;
    let spawned;
    try {
      child = (options.spawn ?? spawn)(process.execPath, [join(root, service.file), ...service.args], {
        cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env,
      });
      spawned = new Promise((resolveSpawn, rejectSpawn) => {
        child.once('spawn', resolveSpawn);
        child.on('error', error => { launchError = error; rejectSpawn(error); });
        child.once('exit', (code, signal) => { exit = { code, signal: signal ? 'signal' : null }; });
      });
    } finally { closeSync(fd); }
    await spawned;
    child.unref();
    return { pid: child.pid, get error() { return launchError; }, get exit() { return exit; } };
  });

  async function health(service, phase, attempt, budgetMs = healthMs) {
    if (healthGET >= maxGET) {
      emit({ event: 'health_budget_exhausted', service: service.name, port: service.port, phase, attempt, maxGET, healthGET });
      throw fault('health_get_budget_exhausted');
    }
    healthGET++;
    const begin = now();
    let headersReceived = false;
    let status;
    emit({ event: 'health_attempt', service: service.name, port: service.port, phase, attempt, budgetMs });
    try {
      const response = await fetchHealth(`http://127.0.0.1:${service.port}/health`, { headers: tokenFor(service) ? {authorization: `Bearer ${tokenFor(service)}`} : {}, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.floor(budgetMs))) });
      headersReceived = true;
      status = response.status;
      if (!response.ok) throw fault('health_http', { status });
      const value = await response.json();
      if (value?.service !== service.name) throw fault('service_identity_mismatch');
      if (authenticatedHealth && value.security !== 'service-bearer-v1') throw fault('service_auth_unverified');
      emit({ event: 'health_result', service: service.name, port: service.port, phase, attempt, outcome: 'healthy', status, headersReceived, durationMs: now() - begin });
      return value;
    } catch (error) {
      const info = errorInfo(error);
      const unavailable = info.code === 'ECONNREFUSED';
      emit({ event: 'health_result', service: service.name, port: service.port, phase, attempt, outcome: unavailable ? 'unavailable' : 'error', kind: kindOf(error, 'health_transport_or_body'), ...info, status, headersReceived, durationMs: now() - begin });
      if (unavailable) return null;
      throw error;
    }
  }

  async function one(service, command) {
    let phase = 'initial_health';
    emit({ event: 'service_begin', service: service.name, port: service.port, command });
    try {
      const initial = await health(service, phase, 0);
      if (command === 'status') {
        out(JSON.stringify({ name: service.name, port: service.port, health: initial }));
        emit({ event: 'service_result', service: service.name, port: service.port, outcome: initial ? 'healthy' : 'unavailable' });
        return { name: service.name, port: service.port, ok: true, outcome: initial ? 'healthy' : 'unavailable' };
      }
      if (initial) {
        out(`${service.name}: already running (${service.port})`);
        emit({ event: 'service_result', service: service.name, port: service.port, outcome: 'already_running' });
        return { name: service.name, port: service.port, ok: true, outcome: 'already_running' };
      }
      phase = 'spawn';
      emit({ event: 'spawn_attempt', service: service.name, port: service.port, file: service.file });
      const child = await launch(service);
      emit({ event: 'spawn_result', service: service.name, port: service.port, pid: child.pid, outcome: 'spawned' });
      const spawnedAt = now();
      phase = 'startup_health';
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (child.error) throw child.error;
        if (child.exit) throw fault('child_exited', child.exit);
        const due = spawnedAt + firstDelay + (attempt - 1) * spacing;
        const delay = due - now();
        if (delay > 0) await wait(delay);
        if (child.error) throw child.error;
        if (child.exit) throw fault('child_exited', child.exit);
        const remaining = spawnedAt + startupMs - now();
        if (remaining <= 0) break;
        try {
          if (await health(service, phase, attempt, Math.min(healthMs, remaining))) {
            out(`${service.name}: started (${service.port})`);
            emit({ event: 'service_result', service: service.name, port: service.port, pid: child.pid, outcome: 'started' });
            return { name: service.name, port: service.port, ok: true, outcome: 'started', pid: child.pid };
          }
        } catch (error) {
          // Retry only the child we just launched. Unknown initial health never spawns a duplicate.
          if (!retryable(error)) throw error;
        }
      }
      throw fault('startup_budget_exhausted');
    } catch (error) {
      const info = errorInfo(error);
      const kind = kindOf(error, 'service_error');
      emit({ event: 'service_result', service: service.name, port: service.port, phase, outcome: 'failed', kind, ...info, ...(kind === 'child_exited' ? { exitCode: error.details.code, termination: error.details.signal } : {}) });
      err(`${service.name}: failed during ${phase}; ${kind} (${info.type}/${info.code}); see .runtime/startup.jsonl and .runtime/${service.port}.log`);
      return { name: service.name, port: service.port, ok: false, phase, kind, ...info };
    }
  }

  async function run(command = 'start') {
    if (!['start', 'status'].includes(command)) {
      emit({ event: 'manager_result', outcome: 'invalid_command' });
      return { exitCode: 1, results: [], journalFailed };
    }
    authenticatedHealth = command === 'start';
    if (authenticatedHealth) {
      try { for (const service of list) requireServiceToken(tokenFor(service)); requireIndependentTokens(tokenFor(services[1]), tokenFor(services[0])); }
      catch { err('Local service authorization is missing or inconsistent; no service started.'); return {exitCode:1, results:[], healthGET:0, journalFailed}; }
    }
    emit({ event: 'manager_begin', command, healthMs, startupMs, attempts, maxGET: Math.min(maxGET, command === 'status' ? list.length : list.length * (attempts + 1)) });
    // Each service runs independently, including initial health. A stalled adapter cannot
    // prevent the bridge from being attempted; preserve an aggregate failure exit code.
    const settled = await Promise.allSettled(list.map(service => one(service, command)));
    const results = settled.map((item, i) => item.status === 'fulfilled' ? item.value : { name: list[i].name, port: list[i].port, ok: false, kind: 'unexpected_manager_error', ...errorInfo(item.reason) });
    const exitCode = results.every(item => item.ok) ? 0 : 1;
    emit({ event: 'manager_result', outcome: exitCode ? 'failed' : 'succeeded', exitCode, healthGET, results });
    return { exitCode, results, journalFailed, healthGET };
  }
  return { run };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const limitIndex = process.argv.indexOf('--max-health-get');
  const maxGET = limitIndex < 0 ? undefined : Number(process.argv[limitIndex + 1]);
  const manager = createManager({ minimized: process.argv.includes('--minimized'), maxGET });
  const result = await manager.run(process.argv[2] ?? 'start');
  process.exitCode = result.exitCode;
}
