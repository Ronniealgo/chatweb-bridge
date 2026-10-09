// Default diagnostics deliberately exclude all free-form request/model/error text.
import { createHash } from 'node:crypto';
const events = new Set(['request','completion','error','protocol-failure-sample','raw-capture-disabled']);
const numbers = new Set(['status','elapsedMs','messageCount','toolCount','characters','attempt','cleanupReadAttempts','observationRecoveryCount']);
const flags = new Set(['saved','generation_submitted','retryable','terminationConfirmed','done','handoff']);
const phases = new Set(['queue','acquire','auth','prepare','submit','ui-submit','generation-submit','response','protocol-parse','unknown']);
export function safeDiagnosticRecord(value = {}) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  if (events.has(value.event)) out.event = value.event;
  if (typeof value.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(value.requestId)) out.requestId = value.requestId;
  if (typeof value.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.timestamp)) out.timestamp = value.timestamp;
  for (const k of numbers) if (Number.isFinite(value[k]) && value[k] >= 0) out[k] = Math.min(value[k], 86400000);
  for (const k of flags) if (typeof value[k] === 'boolean') out[k] = value[k];
  if (['plain-text','tagged','json','markdown-fence'].includes(value.format)) out.format = value.format;
  if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) out.sha256 = value.sha256;
  if (phases.has(value.phase)) out.phase = value.phase;
  if (['stop','tool_calls'].includes(value.finish)) out.finish = value.finish;
  if (Array.isArray(value.tools)) out.toolCount = value.tools.length;
  // Hashes aid correlation without retaining arbitrary text or model/tool identifiers.
  for (const k of ['code','message','model','upstreamModel','requestedModel']) if (typeof value[k] === 'string') out[k+'SHA256'] = createHash('sha256').update(value[k]).digest('hex');
  return out;
}
export function safeLogger(logger = console) {
  return Object.fromEntries(['info','error','warn','debug'].map(level => [level, value => {
    let parsed; try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { parsed = {message:String(value)}; }
    logger[level]?.(JSON.stringify(safeDiagnosticRecord(parsed)));
  }]));
}
