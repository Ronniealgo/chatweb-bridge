import { createHash, timingSafeEqual } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';

// These are service credentials, never ChatGPT account/session credentials.
// There are no generated, built-in, development or placeholder credentials.
export class SecurityError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.phase = 'ingress';
    this.generationSubmitted = false;
    this.details = { phase: 'ingress', generation_submitted: false, retryable: false };
  }
}
const configurationError = () => new SecurityError('Local service authentication is not configured correctly.', 503, 'service_auth_unconfigured');
const digest = value => createHash('sha256').update(value).digest();
const equal = (left, right) => timingSafeEqual(digest(left), digest(right));

export function readServiceToken(name, explicit, env = process.env) {
  // Explicit null is useful for fail-closed offline tests; undefined uses configuration.
  let value = explicit;
  if (value === undefined) {
    const inline = env[name], file = env[`${name}_FILE`];
    if (inline !== undefined && file !== undefined) throw configurationError();
    value = inline ?? null;
    if (file !== undefined) {
      let fd;
      try {
        fd = openSync(file, 'r');
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024) throw configurationError();
        value = readFileSync(fd, 'utf8').trim();
      } catch { throw configurationError(); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(value)) throw configurationError();
  return value;
}

export function requireServiceToken(token) {
  if (!token) throw configurationError();
  return token;
}

export function requireIndependentTokens(externalToken, upstreamToken) {
  if (externalToken && upstreamToken && equal(externalToken, upstreamToken)) throw configurationError();
}

export function isLoopbackPeer(address) {
  if (typeof address !== 'string') return false;
  if (address === '::1') return true;
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(mapped) === 4 && mapped.startsWith('127.');
}

export function assertLoopbackListenHost(host) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host))
    throw new SecurityError('Local service must listen on loopback.', 503, 'service_bind_forbidden');
}

function singleHeader(req, name) {
  const entries = req.rawHeaders ?? [];
  let count = 0;
  for (let index = 0; index < entries.length; index += 2) if (entries[index].toLowerCase() === name) count++;
  const value = req.headers[name];
  if (count > 1 || Array.isArray(value)) throw new SecurityError('Ambiguous request headers.', 400, 'invalid_request_headers');
  return value;
}

export function authorizeLocalRequest(req, token) {
  if (!isLoopbackPeer(req.socket?.remoteAddress))
    throw new SecurityError('Only loopback peers are accepted.', 403, 'loopback_required');
  const host = singleHeader(req, 'host');
  const match = typeof host === 'string' && /^(127\.0\.0\.1|localhost|\[::1\])(?::([1-9][0-9]{0,4}))?$/i.exec(host);
  if (!match || Number(match[2] ?? 80) !== req.socket.localPort)
    throw new SecurityError('The Host header must name this loopback service.', 403, 'invalid_host');
  if (req.headers.origin !== undefined || req.headers.referer !== undefined ||
      req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-dest'] !== undefined ||
      ['navigate', 'no-cors', 'same-origin'].includes(req.headers['sec-fetch-mode']))
    throw new SecurityError('Browser-origin requests are not accepted.', 403, 'browser_origin_forbidden');
  // Accept origin-form targets only; do not normalize encoded/absolute paths into routes.
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || /[\\#]/.test(req.url))
    throw new SecurityError('Invalid request target.', 400, 'invalid_request_target');
  const authorization = singleHeader(req, 'authorization');
  if (req.method === 'GET' && req.url === '/health' && authorization === undefined) return false;
  requireServiceToken(token);
  const bearer = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9._~-]{32,256})$/i.exec(authorization);
  if (!bearer || !equal(bearer[1], token))
    throw new SecurityError('A valid service Bearer credential is required.', 401, 'service_auth_required');
  req[Symbol.for('dsh.http.authenticated')] = true;
  if (req.method === 'POST') {
    const mediaType = singleHeader(req, 'content-type');
    if (typeof mediaType !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(mediaType))
      throw new SecurityError('Expected application/json with optional UTF-8 charset.', 415, 'unsupported_media_type');
    if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')
      throw new SecurityError('Encoded request bodies are not accepted.', 415, 'unsupported_content_encoding');
  }
  return true;
}
