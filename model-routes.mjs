import { readFileSync } from 'node:fs';
import { BridgeError } from './protocol.mjs';

const legacy = [
  ['gpt-5-6-thinking', 'GPT-5.6 Thinking (Chat Web)'],
  ['gpt-5-6', 'GPT-5.6 (Chat Web)'],
  ['gpt-5.6-sol', 'gpt-5.6-sol (legacy configured ID)'],
];
const effortKeys = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
const word = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const configError = () => { throw new Error('Invalid reviewed Chat Web model metadata; no new models enabled.'); };
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const reject = (message, code, submitted = false) => {
  throw Object.assign(new BridgeError(message, submitted ? 422 : 400, code), {
    details: { phase: submitted ? 'response' : 'prepare', generation_submitted: submitted, retryable: false },
  });
};

// Input is a locally reviewed metadata projection, never a credential or an account probe.
// Presence in this catalog is not a claim that the account still has access.
export function createModelRegistry(document = { schema: 1, models: [] }) {
  if (!keys(document, ['schema', 'models']) || document.schema !== 1 || !Array.isArray(document.models) || document.models.length > 32) configError();
  const entries = new Map(legacy.map(([id, displayName]) => [id, { id, displayName, legacy: true }]));
  for (const original of document.models) {
    const row = structuredClone(original);
    if (!keys(row, ['slug', 'display_name', 'thinking_efforts', 'reasoning_efforts', 'default_effort', 'context_window', 'max_output_tokens', 'image_input', 'evidence']) ||
        !word(row.slug) || entries.has(row.slug) || typeof row.display_name !== 'string' || !row.display_name.trim() || row.display_name.length > 120 || /[\x00-\x1f]/.test(row.display_name) ||
        !Array.isArray(row.thinking_efforts) || !row.thinking_efforts.length || row.thinking_efforts.some(value => !word(value)) || new Set(row.thinking_efforts).size !== row.thinking_efforts.length ||
        !object(row.reasoning_efforts) || !Object.keys(row.reasoning_efforts).length || Object.entries(row.reasoning_efforts).some(([key, value]) => !effortKeys.has(key) || !row.thinking_efforts.includes(value)) ||
        !Object.hasOwn(row.reasoning_efforts, row.default_effort) ||
        !Number.isSafeInteger(row.context_window) || !Number.isSafeInteger(row.max_output_tokens) || row.max_output_tokens < 1 || row.context_window <= row.max_output_tokens ||
        (row.image_input !== undefined && row.image_input !== true) ||
        !keys(row.evidence, ['source', 'captured_at', 'sha256']) || row.evidence.source !== 'chatgpt-web-account-metadata' ||
        typeof row.evidence.captured_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.evidence.captured_at) || !Number.isFinite(Date.parse(row.evidence.captured_at)) ||
        !/^[a-f0-9]{64}$/.test(row.evidence.sha256 ?? '')) configError();
    entries.set(row.slug, { id: row.slug, displayName: row.display_name, metadata: row, legacy: false });
  }
  return {
    catalog: () => [...entries.values()].map(row => ({ id: row.id, object: 'model', owned_by: 'chatgpt-web', display_name: row.displayName,
      availability: row.legacy ? 'legacy-configured-not-live-verified' : 'metadata-recorded-not-live-verified' })),
    route(body) {
      const route = entries.get(body?.model);
      if (!route) reject('This model is not configured from reviewed Chat Web metadata. No request was submitted.', 'unsupported_model');
      if (route.legacy) return { model: route.id, strict: false };
      const effort = body.reasoning_effort ?? route.metadata.default_effort;
      if (typeof effort !== 'string' || !Object.hasOwn(route.metadata.reasoning_efforts, effort))
        reject('This reasoning effort is not recorded for the selected Chat Web model. No request was submitted.', 'unsupported_reasoning_effort');
      return { model: route.id, strict: true, thinkingEffort: route.metadata.reasoning_efforts[effort] };
    },
    dshPatch() {
      const models = [{ id: legacy[0][0], name: legacy[0][1], contextWindow: 140000, maxTokens: 32768,
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'max' } }];
      for (const row of entries.values()) if (!row.legacy) models.push({ id: row.id, name: row.displayName,
        contextWindow: row.metadata.context_window, maxTokens: row.metadata.max_output_tokens,
        ...(row.metadata.image_input ? { input: ['text', 'image'] } : {}),
        reasoningEfforts: Object.fromEntries(Object.keys(row.metadata.reasoning_efforts).map(key => [key, key])) });
      // Add after the existing route patch. No agent-default-model or profile mutation.
      return [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'chatgpt-chat-tools': { models } } } }];
    },
  };
}

export function loadModelRegistry(path) {
  return createModelRegistry(path ? JSON.parse(readFileSync(path, 'utf8')) : undefined);
}

export function applyModelRoute(upstreamBody, route) {
  if (upstreamBody.model !== route.model) reject('The outgoing model differs from the selected route. No request was submitted.', 'model_route_mismatch');
  if (route.strict) {
    delete upstreamBody.reasoning_effort;
    upstreamBody.thinking_effort = route.thinkingEffort;
    upstreamBody.dsh_require_model_evidence = true;
  }
}

export function verifyModelResult(result, route) {
  if (!route.strict) return;
  const proof = result?.model_evidence;
  if (!proof || !['stream-final', 'conversation-final'].includes(proof.source) ||
      typeof proof.observed_model !== 'string' || !proof.observed_model)
    reject('The completed answer has no final-message model evidence. No tools were delivered; no replay was made.', 'model_identity_unverified', true);
  if (proof.requested_model !== route.model || proof.observed_model !== route.model || result.model !== route.model)
    reject('The completed answer model differs from the selected Chat Web model. No tools were delivered; no replay was made.', 'model_identity_mismatch', true);
}
