import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError as ProtocolError, prepareRequest, parseModelReply, completion, completionSSE } from '../protocol.mjs';
import { authorizeLocalRequest, readServiceToken, requireServiceToken, SecurityError } from '../http-security.mjs';
import { BridgeError } from './errors.mjs';
import { SerialLane } from './queue.mjs';
import { responsesRequest, responsesResult, responsesSSE } from '../responses.mjs';

function readBody(req, { bodyBytes, bodyTimeoutMs }) {
  if (Number(req.headers['content-length']) > bodyBytes) throw new BridgeError('Request body is too large.', 413, 'body_too_large');
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    const done = (error, value) => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', failed);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const data = part => { size += part.length; if (size > bodyBytes) done(new BridgeError('Request body is too large.', 413, 'body_too_large')); else parts.push(part); };
    const end = () => {
      let value; try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { return done(new BridgeError('Invalid JSON.', 400, 'invalid_json')); }
      done(null, value);
    };
    const aborted = () => done(new BridgeError('Request body was interrupted.', 400, 'body_incomplete'));
    const failed = () => done(new BridgeError('Request body could not be read.', 400, 'body_incomplete'));
    const timer = setTimeout(() => done(new BridgeError('Request body deadline expired.', 408, 'body_timeout')), bodyTimeoutMs);
    req.on('data', data); req.on('end', end); req.on('aborted', aborted); req.on('error', failed);
  });
}

export function createWebBridge({ token, adapters, logger = () => {}, limits = {} }) {
  token = requireServiceToken(readServiceToken('WEB_BRIDGE_TOKEN', token));
  limits = { bodyBytes: 1024 * 1024, bodyTimeoutMs: 10000, heartbeatMs: 10000, ...limits };
  const routes = new Map();
  const lanes = new Map(adapters.map(a => [a, new SerialLane(limits)]));
  for (const adapter of adapters) for (const model of adapter.models) {
    if (routes.has(model.id)) throw new Error('Duplicate model route');
    routes.set(model.id, { adapter, model });
  }
  const instanceId = randomUUID();
  const recentFailures = new Map();
  const counters = { received: 0, completed: 0, failed: 0, cancelled: 0 };
  let closing = false, closingPromise;
  const log = row => { try { logger({ timestamp: new Date().toISOString(), ...row }); } catch { /* telemetry cannot change outcomes */ } };
  const json = (res, status, body) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const snapshot = () => {
    const states = [...lanes.values()].map(l => l.snapshot());
    return { service: 'chatweb-bridge', version: '0.3.0', instanceId, pid: process.pid,
      status: closing || states.some(s => s.quarantined) ? 'degraded' : 'ok',
      active: states.filter(s => s.active).length, queued: states.reduce((n, s) => n + s.queued, 0),
      quarantined: states.some(s => s.quarantined), ...counters };
  };
  const readiness = () => {
    const providers = adapters.map(a => ({ id: a.id, ...a.status(), queue: lanes.get(a).snapshot() }));
    return { ready: !closing && providers.every(a => a.state === 'ready' && !a.queue.quarantined), providers };
  };
  const server = createServer({ requestTimeout: limits.bodyTimeoutMs + 1000, headersTimeout: limits.bodyTimeoutMs }, async (req, res) => {
    let cleanup, startedOperation = false, heartbeat, fingerprint;
    const requestId = randomUUID(), started = Date.now(), ac = new AbortController();
    const disconnect = () => { if (!res.writableEnded) ac.abort(); };
    res.on('close', disconnect);
    res.setHeader('x-request-id', requestId);
    try {
      authorizeLocalRequest(req, token);
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, snapshot());
      if (req.method === 'GET' && req.url === '/ready') { const value = readiness(); return json(res, value.ready ? 200 : 503, value); }
      if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, { object: 'list', data: [...routes.values()].map(({ adapter, model }) => ({ ...model, object: 'model', owned_by: adapter.id, capabilities: { ...adapter.capabilities, tools: 'validated-text-protocol', streaming: 'buffered-sse' } })) });
      if (req.method === 'POST' && req.url === '/admin/shutdown') {
        await readBody(req, limits); json(res, 202, { stopping: true, instanceId });
        setImmediate(() => server.emit('shutdownRequested')); return;
      }
      if (closing) throw new BridgeError('Service is stopping.', 503, 'service_stopping');
      const isResponses = req.url === '/v1/responses';
      if (req.method !== 'POST' || (!isResponses && req.url !== '/v1/chat/completions')) throw new BridgeError('Unknown route.', 404);
      const incoming = await readBody(req, limits);
      fingerprint = createHash('sha256').update(JSON.stringify(incoming)).digest('hex');
      const failedUntil = recentFailures.get(fingerprint);
      if (failedUntil > Date.now()) throw new BridgeError('Identical request recently failed after possible submission. No replay was made; wait before deliberately trying again.', 422, 'recent_failed_request', { generation_submitted: 'unknown', retry_after_ms: failedUntil - Date.now() });
      recentFailures.delete(fingerprint);
      const translated = isResponses ? responsesRequest(incoming) : null;
      const body = translated?.body ?? incoming;
      const route = routes.get(body?.model);
      if (!route) throw new BridgeError('Model is not configured.', 400, 'unsupported_model');
      if (!route.adapter.capabilities?.images && Array.isArray(body.messages) && body.messages.some(m => Array.isArray(m?.content) && m.content.some(p => ['image_url', 'input_image'].includes(p?.type))))
        throw new BridgeError('This adapter does not support image input.', 400, 'unsupported_image_input');
      const prepared = prepareRequest(body); cleanup = prepared.cleanup;
      const resultPromise = lanes.get(route.adapter).submit(async ({ signal, deadlineMs }) => {
        startedOperation = true;
        try { return await route.adapter.generate(prepared.upstreamBody, { requestId, signal, deadlineMs }); }
        finally { cleanup?.(); }
      }, { signal: ac.signal });
      counters.received++;
      log({ event: 'request', requestId, provider: route.adapter.id, model: body.model });
      const id = `chatcmpl-${requestId}`, created = Math.floor(Date.now() / 1000);
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        if (isResponses) res.write(': accepted\n\n');
        else res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, limits.heartbeatMs);
        heartbeat.unref?.();
      }
      const output = await resultPromise;
      if (ac.signal.aborted) return;
      if (output.model !== body.model) throw new BridgeError('Adapter returned a different model.', 422, 'model_identity_mismatch', { generation_submitted: true });
      const parsed = parseModelReply(output.text, prepared.context);
      const result = isResponses ? responsesResult(body.model, parsed, translated) : { ...completion(body.model, parsed), id, created };
      if (isResponses) { result.usage = null; result.metadata = { transport: 'web-model-bridge', usage_source: 'unavailable' }; }
      clearInterval(heartbeat);
      if (body.stream === true) res.end(isResponses ? responsesSSE(result) : completionSSE(result));
      else json(res, 200, result);
      counters.completed++;
      log({ event: 'completion', requestId, elapsedMs: Date.now() - started, finishReason: parsed.finish_reason });
    } catch (error) {
      clearInterval(heartbeat);
      if (fingerprint && startedOperation && error.details?.generation_submitted !== false) {
        if (recentFailures.size >= 100) recentFailures.delete(recentFailures.keys().next().value);
        recentFailures.set(fingerprint, Date.now() + 60000);
      }
      if (ac.signal.aborted) { counters.cancelled++; return; }
      const known = error instanceof ProtocolError || error instanceof SecurityError;
      const status = known ? error.status : 502;
      const detail = { message: known ? error.message : 'Adapter failed. Check the service diagnostics; no automatic replay was performed.',
        type: 'bridge_error', code: known ? error.code : 'adapter_error', request_id: requestId, ...(known ? error.details : {}) };
      counters.failed++;
      log({ event: 'error', requestId, status, code: detail.code, elapsedMs: Date.now() - started });
      if (res.destroyed) return;
      if (res.headersSent) res.end(`data: ${JSON.stringify({ error: detail })}\n\ndata: [DONE]\n\n`);
      else {
        if (['body_too_large', 'body_timeout', 'body_incomplete'].includes(detail.code)) res.setHeader('connection', 'close');
        if (status === 429) res.setHeader('retry-after', '5');
        json(res, status, { error: detail });
      }
    } finally {
      clearInterval(heartbeat); res.off('close', disconnect);
      if (!startedOperation) cleanup?.();
    }
  });
  return { server, snapshot, readiness, close() {
    if (closingPromise) return closingPromise;
    closing = true;
    closingPromise = (async () => {
      const closed = new Promise(resolve => server.close(resolve));
      try {
        await Promise.allSettled([...lanes.values()].map(async l => l.close()));
        await Promise.allSettled(adapters.map(async a => a.close()));
      } finally {
        server.closeAllConnections();
        await closed;
      }
    })();
    return closingPromise;
  } };
}
