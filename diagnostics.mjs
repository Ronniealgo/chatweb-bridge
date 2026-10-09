import { safeDiagnosticRecord } from './diagnostic-policy.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const REASONS = new Set(['cdp_timeout', 'observation_timeout', 'context_lost', 'browser_disconnected',
  'generation_deadline', 'caller_cancelled', 'fetch_failed', 'response_read_failed', 'transaction_missing',
  'transaction_invalid', 'previous_request_pending', 'preparation_deadline', 'unknown']);
export function safeTransportDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return {
    ...(REASONS.has(value.reason) ? { reason: value.reason } : {}),
    ...(Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? { elapsedMs: Math.min(value.elapsedMs, 86_400_000) } : {}),
    ...(typeof value.terminationConfirmed === 'boolean' ? { terminationConfirmed: value.terminationConfirmed } : {}),
    ...(['start', 'metadata', 'response'].includes(value.observationStage) ? { observationStage: value.observationStage } : {}),
    ...(Number.isInteger(value.observationRecoveryCount) && value.observationRecoveryCount >= 0 && value.observationRecoveryCount <= 1 ? { observationRecoveryCount: value.observationRecoveryCount } : {}),
    ...(Number.isInteger(value.cleanupReadAttempts) && value.cleanupReadAttempts >= 0 && value.cleanupReadAttempts <= 100 ? { cleanupReadAttempts: value.cleanupReadAttempts } : {}),
    ...(Number.isFinite(value.observationElapsedMs) && value.observationElapsedMs >= 0 ? { observationElapsedMs: Math.min(value.observationElapsedMs, 86_400_000) } : {}),
    ...(Number.isFinite(value.observationTimerLagMs) && value.observationTimerLagMs >= 0 ? { observationTimerLagMs: Math.min(value.observationTimerLagMs, 86_400_000) } : {}),
    ...(Number.isFinite(value.cleanupElapsedMs) && value.cleanupElapsedMs >= 0 ? { cleanupElapsedMs: Math.min(value.cleanupElapsedMs, 86_400_000) } : {}),
    ...(['start', 'read', 'peek', 'abort', 'consume'].includes(value.observationAction) ? { observationAction: value.observationAction } : {}),
    ...(Number.isFinite(value.observationBudgetMs) && value.observationBudgetMs >= 0 ? { observationBudgetMs: Math.min(value.observationBudgetMs, 240_000) } : {}),
    ...(['settled', 'already_settled', 'pending', 'missing', 'transaction_invalid', 'cdp_timeout', 'observation_timeout', 'context_lost', 'browser_disconnected', 'unknown'].includes(value.cleanupOutcome) ? { cleanupOutcome: value.cleanupOutcome } : {}),
    ...(['read', 'peek', 'abort'].includes(value.cleanupAction) ? { cleanupAction: value.cleanupAction } : {}),
    ...(Number.isFinite(value.cleanupObservationBudgetMs) && value.cleanupObservationBudgetMs >= 0 ? { cleanupObservationBudgetMs: Math.min(value.cleanupObservationBudgetMs, 240_000) } : {}),
  };
}
export function protocolFailureSample(text, context) {
  const value = typeof text === 'string' ? text : '';
  const clean = value.trim(), open = `<${context.nonce}>`, close = `</${context.nonce}>`;
  const tags = [...clean.matchAll(/<(\/?)(dsh_reply_[a-zA-Z0-9_-]{1,80})>/g)].slice(0, 8)
    .map(m => ({ closing: !!m[1], expectedNonce: m[2] === context.nonce }));
  const sample = { characters: value.length, sha256: createHash('sha256').update(value).digest('hex'),
    startsWithExpected: clean.startsWith(open), endsWithExpected: clean.endsWith(close),
    format: clean.startsWith('```') ? 'markdown-fence' : clean.startsWith('<') ? 'tagged' : /^[\[{]/.test(clean) ? 'json' : 'plain-text', tags };
  let candidate = clean;
  if (sample.startsWithExpected && sample.endsWithExpected) candidate = clean.slice(open.length, -close.length);
  else if (/^```(?:json)?\s*[\s\S]*\s*```$/.test(candidate)) candidate = candidate.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    const payload = JSON.parse(candidate);
    sample.jsonValid = true;
    sample.topLevel = Array.isArray(payload) ? 'array' : payload === null ? 'null' : typeof payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      sample.keys = Object.keys(payload).slice(0, 12).map(k => ['content', 'tool_calls'].includes(k) ? k : '[other-key]');
      if ('content' in payload) sample.content = { type: typeof payload.content, characters: typeof payload.content === 'string' ? payload.content.length : null };
      if (Array.isArray(payload.tool_calls)) sample.toolCalls = payload.tool_calls.slice(0, 8).map(call => ({
        name: context.validators.has(call?.name) ? call.name : '[unavailable]',
        argumentsType: Array.isArray(call?.arguments) ? 'array' : typeof call?.arguments,
        argumentCount: call?.arguments && typeof call.arguments === 'object' ? Object.keys(call.arguments).length : null,
      }));
    }
  } catch { sample.jsonValid = false; }
  // Never retain natural language, arbitrary keys, argument values, or identity material.
  return sample;
}
export function saveFailureSample(directory, requestId, sample) {
  if (!directory || !/^[a-f0-9-]{36}$/.test(requestId)) return false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (readdirSync(directory).filter(name => /^protocol-[a-f0-9-]{36}\.json$/.test(name)).length >= 20) return false;
  writeFileSync(join(directory, `protocol-${requestId}.json`), JSON.stringify(safeDiagnosticRecord(sample), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return true;
}
