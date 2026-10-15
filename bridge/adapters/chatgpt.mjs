import { readFileSync, statSync } from 'node:fs';
import { loadModelRegistry, applyModelRoute, verifyModelResult } from '../../model-routes.mjs';
import { readServiceToken, requireServiceToken, requireIndependentTokens } from '../../http-security.mjs';
import { BridgeError } from '../errors.mjs';

// Uses the existing reconstructed ChatGPT browser runtime, NOT the paid API.
// Start that runtime with the legacy launcher; it owns its browser/account state.
export function createChatGPTAdapter(options = {}) {
  const origin = new URL(options.upstream ?? 'http://127.0.0.1:1456');
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('ChatGPT runtime must be an explicit loopback HTTP origin.');
  let token = options.token;
  if (options.tokenFile) {
    if (token !== undefined || statSync(options.tokenFile).size > 1024) throw new Error('Invalid runtime credential configuration.');
    token = readFileSync(options.tokenFile, 'utf8').trim();
  }
  token = requireServiceToken(readServiceToken(options.tokenEnv ?? 'PCW_INTERNAL_TOKEN', token));
  requireIndependentTokens(options.externalToken, token);
  const registry = options.modelRegistry ?? loadModelRegistry(options.registryFile ?? new URL('../../web-model-metadata.json', import.meta.url));
  const catalog = registry.catalog();
  const models = options.models ? options.models.map(({ id }) => {
    const row = catalog.find(m => m.id === id);
    if (!row) throw new Error('ChatGPT model is absent from reviewed metadata.');
    return row;
  }) : catalog;
  let state = 'idle', lastErrorCode;
  return {
    id: options.id ?? 'chatgpt', models, capabilities: { images: true },
    status: () => ({ state, ...(lastErrorCode ? { lastErrorCode } : {}) }),
    async generate(request, { signal, requestId, deadlineMs = Date.now() + 150000 } = {}) {
      if (!models.some(m => m.id === request.model)) throw new BridgeError('Model is not configured.', 400, 'unsupported_model');
      const body = structuredClone(request), route = registry.route(body);
      applyModelRoute(body, route);
      state = 'busy';
      try {
        const response = await fetch(`${origin.origin}/v1/chat/completions`, {
          method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            'x-dsh-request-id': requestId ?? '', 'x-dsh-deadline-ms': String(deadlineMs - 500) }, body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadlineMs - Date.now()))]) : AbortSignal.timeout(Math.max(1, deadlineMs - Date.now())),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new BridgeError(`ChatGPT browser runtime returned HTTP ${response.status}. No replay performed.`, response.status, 'chatgpt_runtime_error', { generation_submitted: 'unknown' });
        }
        const reader = response.body.getReader(); let size = 0; const parts = [];
        try {
          for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
            if (size > 4 * 1024 * 1024) throw new BridgeError('Runtime response exceeded the safety limit.', 502, 'upstream_response_too_large', { generation_submitted: true });
            parts.push(Buffer.from(value)); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (result.choices?.[0]?.finish_reason !== 'stop') throw new BridgeError('Runtime did not confirm complete generation.', 502, 'incomplete_upstream', { generation_submitted: true });
        verifyModelResult(result, route);
        const text = result.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new BridgeError('Runtime returned no complete text.', 502, 'empty_upstream', { generation_submitted: true });
        state = 'ready'; lastErrorCode = undefined;
        return { text, model: request.model };
      } catch (error) {
        state = 'unavailable'; lastErrorCode = error.code ?? 'chatgpt_runtime_unavailable';
        if (error.status) throw error;
        if (signal?.aborted) throw signal.reason;
        throw new BridgeError('ChatGPT browser runtime is unavailable or timed out. Start its managed runtime and check its diagnostics.', 503, 'chatgpt_runtime_unavailable', { generation_submitted: 'unknown' });
      }
    },
    async close() { state = 'idle'; },
  };
}
