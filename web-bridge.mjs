#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { loadConfig, loadToken } from './bridge/config.mjs';
import { createWebBridge } from './bridge/server.mjs';

const log = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const closeAdapters = adapters => Promise.allSettled(adapters.map(async adapter => {
  if (typeof adapter?.close === 'function') await adapter.close();
}));
export async function loadAdapters(config, externalToken) {
  const adapters = [];
  try {
    for (const provider of config.providers) {
      let factory;
      if (provider.type === 'gemini') factory = (await import('./bridge/adapters/gemini.mjs')).createGeminiAdapter;
      else if (provider.type === 'chatgpt') factory = (await import('./bridge/adapters/chatgpt.mjs')).createChatGPTAdapter;
      else factory = (await import(pathToFileURL(provider.modulePath).href)).createAdapter;
      if (typeof factory !== 'function') throw new Error('Adapter module must export createAdapter(options).');
      const adapter = await factory({ ...provider, externalToken });
      // Own returned resources even if contract validation or id assignment fails.
      adapters.push(adapter);
      if (!adapter || !Array.isArray(adapter.models) || !adapter.models.length || ['generate', 'status', 'close'].some(k => typeof adapter[k] !== 'function')) throw new Error('Invalid adapter contract.');
      adapter.id = provider.id;
    }
    return adapters;
  } catch (error) {
    await closeAdapters(adapters);
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0], option = args.indexOf('--config');
  if (!['init', 'serve', 'doctor'].includes(command) || option !== 1 || args.length !== 3 || !args[2]) {
    log({ usage: 'node web-bridge.mjs <init|serve|doctor> --config <path.json>' }); return 1;
  }
  const configPath = resolve(args[2]);
  if (command === 'init') {
    if (existsSync(configPath)) throw new Error('Configuration exists; refusing to overwrite it.');
    const base = dirname(configPath), stateDir = join(base, '.state'), authFile = join(stateDir, 'auth.json');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (!existsSync(authFile)) writeFileSync(authFile, JSON.stringify({ token: `cwb_${randomBytes(32).toString('base64url')}` }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    loadToken(authFile);
    const example = { schema: 1, host: '127.0.0.1', port: 1458, stateDir: '.state', authFile: '.state/auth.json',
      limits: { maxQueue: 4, queueTimeoutMs: 60000, requestTimeoutMs: 150000 },
      providers: [{ type: 'gemini', id: 'gemini', profileDir: '.state/gemini-profile', headless: false,
        models: [{ id: 'gemini-4-argon', label: 'Argon' }] }] };
    writeFileSync(configPath, JSON.stringify(example, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    log({ event: 'initialized', configPath, authFile, next: 'Set your Chrome executablePath and visible model label; log in manually on first use. Credentials were not printed.' }); return 0;
  }
  const config = loadConfig(configPath), token = loadToken(config.authFile);
  if (command === 'doctor') {
    const origin = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
    const health = await (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' })).json();
    if (health.service !== 'chatweb-bridge') throw new Error('Port belongs to a different service.');
    const response = await fetch(`${origin}/ready`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    const ready = await response.json(); log({ health, readiness: ready }); return response.ok ? 0 : 2;
  }
  const adapters = await loadAdapters(config, token);
  let bridge;
  try { bridge = createWebBridge({ token, adapters, limits: config.limits, logger: log }); }
  catch (error) { await closeAdapters(adapters); throw error; }
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return; stopping = true; clearInterval(watchdog);
    const fallback = setTimeout(() => process.exit(code || 1), 10000); fallback.unref();
    await bridge.close(); clearTimeout(fallback); process.exitCode = code;
    log({ event: 'stopped', code });
  };
  const watchdog = setInterval(() => { if (bridge.snapshot().quarantined) { log({ event: 'adapter_quarantined_restart' }); void stop(1); } }, 1000);
  watchdog.unref();
  bridge.server.on('shutdownRequested', () => void stop());
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  try {
    bridge.server.listen(config.port, config.host);
    await once(bridge.server, 'listening');
    log({ event: 'listening', ...bridge.snapshot(), host: config.host, port: config.port, browserReady: false });
  } catch (error) { await stop(1); throw error; }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const code = await main(); if (code) process.exitCode = code; }
  catch (error) {
    // Do not serialize configuration, environment, browser traces or credentials.
    log({ event: 'fatal', code: ['EADDRINUSE', 'ENOENT', 'EACCES'].includes(error.code) ? error.code : 'startup_failed',
      message: error.code === 'EADDRINUSE' ? 'Port already in use; existing process was not touched.' : 'Startup failed. Validate configuration, paths and credential-file format.' });
    process.exitCode = 1;
  }
}
