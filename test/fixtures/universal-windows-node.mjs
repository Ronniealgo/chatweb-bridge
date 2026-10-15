// Copied into an isolated scratch checkout as web-bridge.mjs by the tests.
import http from 'node:http';
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
if (process.argv[2] !== 'serve' || process.argv[3] !== '--config') process.exit(91);
const config = JSON.parse(readFileSync(process.argv[4], 'utf8'));
const options = config.fixture || {};
const events = join(config.stateDir, 'fixture-launches.jsonl');
appendFileSync(events, JSON.stringify({ pid: process.pid, at: Date.now(), args: process.argv.slice(1) }) + '\n');
const instanceId = randomUUID();
const auth = readFileSync(config.authFile, 'utf8').trim();
const token = auth.startsWith('{') ? JSON.parse(auth).token : auth;
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ service: options.service || 'chatweb-bridge', version: '0.3.0', instanceId, pid: process.pid, status: options.ready ? 'ok' : 'degraded', quarantined: !!options.quarantined }));
  } else if (request.url === '/ready') {
    const authorized = request.headers.authorization === `Bearer ${token}`;
    response.writeHead(authorized ? (options.ready ? 200 : 503) : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready: authorized && !!options.ready }));
  } else if (request.url === '/admin/shutdown' && request.method === 'POST') {
    const authorized = request.headers.authorization === `Bearer ${token}`;
    response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: authorized }));
    if (authorized && !options.ignoreShutdown) {
      appendFileSync(join(config.stateDir, 'fixture-shutdowns.jsonl'), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');
      server.close(() => process.exit(0));
    }
  } else { response.writeHead(404); response.end(); }
});
server.listen(config.port, config.host);
console.log('fixture-started');
console.error('fixture-stderr');
if (options.logs) {
  for (let i = 0; i < 1800; i++) {
    console.log(`${i} ${'x'.repeat(1000)}`);
    console.error(`${i} ${'e'.repeat(1000)}`);
  }
  console.log(`raw value ${token}`);
  console.error(`Authorization: Bearer ${token}`);
  console.log('prompt: PRIVATE-PROMPT-SHOULD-NOT-APPEAR');
  console.error('z'.repeat(100000));
}
if (options.crashOnce) {
  const marker = join(config.stateDir, 'fixture-crashed');
  if (!existsSync(marker)) setTimeout(() => { writeFileSync(marker, 'once'); process.exit(23); }, 1200);
}
