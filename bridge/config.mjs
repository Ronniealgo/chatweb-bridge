import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, normalize } from 'node:path';
import { assertLoopbackListenHost, readServiceToken, requireServiceToken } from '../http-security.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const bad = message => { throw new Error(`Invalid bridge configuration: ${message}`); };
const bounded = (value, min, max, name) => { if (!Number.isSafeInteger(value) || value < min || value > max) bad(name); return value; };
export function loadConfig(filename) {
  const configPath = resolve(filename), base = dirname(configPath);
  if (statSync(configPath).size > 128 * 1024) bad('file too large');
  const raw = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!object(raw) || raw.schema !== 1) bad('schema must be 1');
  const allowed = ['schema', 'host', 'port', 'stateDir', 'authFile', 'limits', 'providers'];
  if (Object.keys(raw).some(k => !allowed.includes(k))) bad('unknown top-level option');
  const config = { host: '127.0.0.1', port: 1458, stateDir: '.state', authFile: '.state/auth.json', limits: {}, ...raw, configPath };
  assertLoopbackListenHost(config.host);
  bounded(config.port, 1, 65535, 'port');
  const path = value => { if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) bad('invalid path'); return resolve(base, value); };
  config.stateDir = path(config.stateDir); config.authFile = path(config.authFile);
  if (!object(config.limits)) bad('limits');
  const bounds = { maxQueue: [0, 64], queueTimeoutMs: [1, 600000], requestTimeoutMs: [1, 600000], cancelGraceMs: [1, 30000], bodyBytes: [128, 32 * 1024 * 1024], bodyTimeoutMs: [1, 60000], heartbeatMs: [1, 30000] };
  for (const [key, value] of Object.entries(config.limits)) { if (!bounds[key]) bad('unknown limit'); bounded(value, ...bounds[key], key); }
  if (!Array.isArray(config.providers) || !config.providers.length || config.providers.length > 16) bad('providers');
  const ids = new Set(), profiles = new Set(), modelIds = new Set();
  config.providers = config.providers.map(original => {
    if (!object(original) || !['gemini', 'chatgpt', 'module'].includes(original.type)) bad('provider type');
    const p = { ...original, id: original.id ?? original.type };
    if (typeof p.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(p.id) || ids.has(p.id)) bad('provider id');
    ids.add(p.id);
    for (const field of ['profileDir', 'executablePath', 'registryFile', 'tokenFile', 'modulePath']) if (p[field] !== undefined) p[field] = path(p[field]);
    if (p.type === 'gemini') {
      if (!p.profileDir) bad('Gemini requires an independent profileDir');
      const key = normalize(p.profileDir).toLowerCase();
      if (profiles.has(key)) bad('browser profile shared by independent adapters'); profiles.add(key);
      if (p.headless !== undefined && typeof p.headless !== 'boolean') bad('headless');
      for (const field of ['navigationTimeoutMs', 'responseTimeoutMs', 'pollMs']) if (p[field] !== undefined) bounded(p[field], 1, 600000, field);
      if (p.cdpPort !== undefined) bounded(p.cdpPort, 0, 65535, 'cdpPort');
      if (!Array.isArray(p.models) || !p.models.length) bad('explicit Gemini model labels required');
    }
    if (p.type === 'module' && !p.modulePath) bad('modulePath required');
    if (p.models !== undefined) {
      if (!Array.isArray(p.models) || !p.models.length) bad('models');
      for (const model of p.models) {
        if (!object(model) || typeof model.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(model.id) || modelIds.has(model.id)) bad('duplicate or invalid model');
        modelIds.add(model.id);
        if (p.type === 'gemini' && (typeof model.label !== 'string' || !model.label.trim() || model.label.length > 80)) bad('visible model label');
      }
    }
    return p;
  });
  return config;
}

export function loadToken(filename) {
  if (statSync(filename).size > 1024) throw new Error('Credential file is invalid.');
  let value;
  try { value = JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')).token; }
  catch { throw new Error('Credential file must contain a JSON token property.'); }
  return requireServiceToken(readServiceToken('WEB_BRIDGE_TOKEN', value ?? null));
}
