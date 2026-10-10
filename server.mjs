import { safeLogger } from './diagnostic-policy.mjs';
import {attachHealthTelemetry} from './health-telemetry.mjs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { protocolFailureSample, saveFailureSample, safeTransportDetails } from './diagnostics.mjs';
import { BridgeError, prepareRequest, parseModelReply, completion, completionSSE, sweepStaleUploads } from './protocol.mjs';
import { responsesRequest, responsesResult, responsesSSE } from './responses.mjs';
import { loadModelRegistry, applyModelRoute, verifyModelResult } from './model-routes.mjs';
import { SecurityError, authorizeLocalRequest, readServiceToken, requireIndependentTokens, requireServiceToken } from './http-security.mjs';

export function createBridge({ upstream = 'http://127.0.0.1:1456', timeoutMs = 240_000, fetchImpl = fetch, logger = console, now = Date.now, diagnosticDirectory, externalToken, upstreamToken, modelRegistry = loadModelRegistry(new URL('./web-model-metadata.json', import.meta.url)) } = {}) {
  logger = safeLogger(logger);
  const origin = new URL(upstream);
  if (origin.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/')
    throw new Error('The upstream must be a loopback HTTP origin.');
  externalToken = readServiceToken('DSH_CHAT_API_TOKEN', externalToken);
  upstreamToken = readServiceToken('PCW_INTERNAL_TOKEN', upstreamToken);
  requireIndependentTokens(externalToken, upstreamToken);
  let busy = false;
  const failures = new Map();
  const counters = { requests: 0, completed: 0, toolRounds: 0, failed: 0 };
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  return createServer(async (req, res) => {
    let acquired = false, fingerprint, cleanupUploads = null;
    const requestId = randomUUID();
    res.setHeader('x-dsh-request-id', requestId);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const authenticated = authorizeLocalRequest(req, externalToken);
      if (!authenticated) return json(res, 200, { service: 'dsh-chat-tool-bridge', status: 'ok' });
      requireServiceToken(upstreamToken);
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { service: 'dsh-chat-tool-bridge', status: 'ok', security: 'service-bearer-v1', revision: 'image-input-20261010', upstream: origin.origin, busy, ...counters });
      if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, { object: 'list', data: modelRegistry.catalog() });
      const isResponses = req.url === '/v1/responses';
      if (req.method !== 'POST' || (!isResponses && req.url !== '/v1/chat/completions')) throw new BridgeError('Use POST /v1/chat/completions or /v1/responses.', 404);
      if (busy) throw Object.assign(new BridgeError('The managed browser is busy; wait for the active request.', 429, 'bridge_busy'), { details: { phase: 'queue', generation_submitted: false, retryable: false } });
      busy = true; acquired = true;
      let size = 0; const parts = [];
      for await (const part of req) {
        size += part.length;
        // 32 MiB: base64 image data URLs inflate ~4/3x; DSH sends up to 8 images
        // of ~1 MiB each plus the full transcript, and this bridge forwards the
        // decoded bytes to the adapter as temp file paths.
        if (size > 32*1024*1024) throw new BridgeError('Request too large.', 413);
        parts.push(part);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new BridgeError('Invalid JSON.'); }
      fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const previous = failures.get(fingerprint);
      if (previous && now() < previous.until) throw Object.assign(new BridgeError(
        `${previous.message} Identical request suppressed locally for ${previous.until - now()} ms; no new upstream request was made.`, 422, 'recent_failed_request'),
        { details: { ...previous.details, original_code: previous.code, retry_after_ms: previous.until - now() } });
      if (previous) failures.delete(fingerprint);
      const translated = isResponses ? responsesRequest(body) : null;
      const chatBody = translated?.body ?? body;
      const prepared = prepareRequest(chatBody);
      const { upstreamBody, context } = prepared;
      cleanupUploads = prepared.cleanup;
      const modelRoute = modelRegistry.route(chatBody);
      applyModelRoute(upstreamBody, modelRoute);
      logger.info(JSON.stringify({ timestamp: new Date().toISOString(), requestId, event: 'request', model: body.model, upstreamModel: chatBody.model, api: isResponses ? 'responses' : 'chat-completions', tools: [...context.validators.keys()], messageCount: chatBody.messages.length }));
      counters.requests++;
      const started = Date.now();
      const response = await fetchImpl(`${origin.origin}/v1/chat/completions`, {
        // Give the adapter the same overall budget, reserving time to confirm
        // browser abort and return its structured outcome before this socket expires.
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${upstreamToken}`, 'x-dsh-request-id': requestId,
          'x-dsh-deadline-ms': String(started + timeoutMs - Math.min(2500, Math.floor(timeoutMs / 10))) }, body: JSON.stringify(upstreamBody),
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.ok) {
        let detail = '', upstreamError;
        try {
          const errorBody = await response.json();
          upstreamError = errorBody.error;
          detail = String(errorBody.error?.message ?? '').slice(0, 600).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_.-]{40,}/g, '[redacted token]');
        } catch {}
        // ChatGPT rejects an over-long message with HTTP 413 / code input_too_large (its text is
        // localized). DSH recognizes a context overflow only by English wording, so say it that way
        // and DSH compacts the transcript and retries instead of failing the whole task.
        if (response.status === 413 || /input_too_large/.test(detail))
          throw new BridgeError('Prompt too long: the ChatGPT message size limit was exceeded (input_too_large). The harness should compact the conversation and retry.', 413, 'context_length_exceeded');
        if (response.status >= 400 && response.status <= 599 && (
          /^browser_[a-z_]+$/.test(upstreamError?.code ?? '') ||
          ['adapter_busy','adapter_queue_timeout','adapter_queue_full','adapter_queue_cancelled','adapter_request_cancelled','adapter_body_timeout'].includes(upstreamError?.code))) {
          throw Object.assign(new BridgeError(detail, response.status, upstreamError.code), { details: {
            phase: ['queue','acquire','auth','prepare','submit','ui-submit','generation-submit','response'].includes(upstreamError.phase) ? upstreamError.phase : 'unknown',
            generation_submitted: [true,false].includes(upstreamError.generation_submitted) ? upstreamError.generation_submitted : 'unknown',
            retryable: false,
            ...safeTransportDetails(upstreamError.details),
          } });
        }
        throw new BridgeError(`Chat transport returned HTTP ${response.status}${detail ? ': ' + detail : ''}. No automatic retry or alternate provider was used.`, response.status >= 400 && response.status < 600 ? response.status : 502, 'upstream_error');
      }
      // Buffer completely so malformed or partial tool calls never reach the harness.
      const upstreamResult = await response.json();
      const upstreamChoice = upstreamResult.choices?.[0];
      if (upstreamChoice?.finish_reason !== 'stop') throw Object.assign(new BridgeError('Upstream response did not confirm completion. No generation replay was made.', 502, 'incomplete_upstream'), { details: { phase: 'response', generation_submitted: true, retryable: false } });
      verifyModelResult(upstreamResult, modelRoute);
      let parsed;
      try { parsed = parseModelReply(upstreamChoice?.message?.content, context); }
      catch (error) {
        if (error.code === 'invalid_tool_protocol') {
          const sample = { timestamp: new Date().toISOString(), requestId, stage: 'protocol-parse', generation_submitted: true,
            requestedModel: body.model, ...protocolFailureSample(upstreamChoice?.message?.content, context) };
          let saved = false;
          try { saved = saveFailureSample(diagnosticDirectory, requestId, sample); } catch { /* diagnostics must not permit tools */ }
          logger.error(JSON.stringify({ event: 'protocol-failure-sample', saved, ...sample }));
          error.details = { phase: 'protocol-parse', generation_submitted: true, retryable: false };
        }
        throw error;
      }
      const result = isResponses ? responsesResult(body.model, parsed, translated) : completion(upstreamResult.model ?? body.model, parsed);
      if (ac.signal.aborted) return;
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        res.end(isResponses ? responsesSSE(result) : completionSSE(result));
      } else json(res, 200, result);
      counters.completed++;
      if (parsed.finish_reason === 'tool_calls') counters.toolRounds++;
      logger.info(JSON.stringify({ timestamp: new Date().toISOString(), requestId, event: 'completion', elapsedMs: Date.now()-started, model: result.model, finish: parsed.finish_reason, tools: parsed.message.tool_calls?.map(c => c.function.name) ?? [] }));
    } catch (err) {
      if (ac.signal.aborted) return;
      if (acquired) counters.failed++;
      const status = err.status ?? (err.name === 'TimeoutError' ? 504 : 502);
      const message = err instanceof BridgeError || err instanceof SecurityError ? err.message : 'Local transport failed or timed out. No automatic retry was made.';
      const code = err instanceof BridgeError || err instanceof SecurityError ? err.code : 'transport_error';
      if (fingerprint && err.code !== 'recent_failed_request') {
        if (failures.size >= 50) failures.delete(failures.keys().next().value);
        failures.set(fingerprint, { until: now() + (err.details?.generation_submitted === false ? 3000 : 60000), message, code, details: err.details });
      }
      logger.error(JSON.stringify({ timestamp: new Date().toISOString(), requestId, event: 'error', status, code, message, ...err.details }));
      if (!res.headersSent) json(res, status, { error: { message, type: 'bridge_error', code, requestId, ...err.details } });
      else res.end();
    } finally {
      if (acquired) busy = false;
      // Image temp files are consumed by the adapter during the upstream call;
      // delete them whatever happened (abort leaves the sweep to finish the job).
      cleanupUploads?.();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const swept = sweepStaleUploads(); if (swept) console.log(`swept ${swept} stale image upload${swept === 1 ? '' : 's'}`); } catch { /* best effort */ }
  const port = Number(process.env.DSH_CHAT_TOOL_PORT ?? 1457);
  const externalToken = requireServiceToken(readServiceToken('DSH_CHAT_API_TOKEN'));
  const upstreamToken = requireServiceToken(readServiceToken('PCW_INTERNAL_TOKEN'));
  const server = createBridge({ externalToken, upstreamToken, upstream: process.env.DSH_CHAT_UPSTREAM ?? 'http://127.0.0.1:1456', diagnosticDirectory: join(dirname(fileURLToPath(import.meta.url)), '.runtime', 'protocol-failures') });
  attachHealthTelemetry(server);
  server.listen(port, '127.0.0.1', () => console.log(`DSH tool bridge listening on http://127.0.0.1:${port}/v1`));
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
}
