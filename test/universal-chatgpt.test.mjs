import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createModelRegistry } from '../model-routes.mjs';
const externalToken = 'offline-external-fixture-0000000000000000';
const token = 'offline-internal-fixture-0000000000000000';
const registry = createModelRegistry({ schema: 1, models: [{ slug: 'fixture-chat', display_name: 'Fixture', thinking_efforts: ['standard'], reasoning_efforts: { medium: 'standard' }, default_effort: 'medium', context_window: 10000, max_output_tokens: 1000, evidence: { source: 'chatgpt-web-account-metadata', captured_at: '2026-10-15T00:00:00Z', sha256: 'a'.repeat(64) } }] });
async function fixture(t, reply) {
  let captured;
  const server = createServer(async (req, res) => { const parts = []; for await (const p of req) parts.push(p); captured = { headers: req.headers, body: JSON.parse(Buffer.concat(parts)) }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const { createChatGPTAdapter } = await import('../bridge/adapters/chatgpt.mjs');
  return { adapter: createChatGPTAdapter({ upstream: `http://127.0.0.1:${server.address().port}`, token, externalToken, modelRegistry: registry }), captured: () => captured };
}
const payload = { model: 'fixture-chat', messages: [{ role: 'system', content: 'preserve me' }, { role: 'user', content: 'fixture' }], stream: false };
const proof = { requested_model: 'fixture-chat', observed_model: 'fixture-chat', source: 'stream-final' };

test('ChatGPT adapter retains reviewed model routing and distinct service authentication', async t => {
  const { adapter, captured } = await fixture(t, { model: 'fixture-chat', model_evidence: proof, choices: [{ finish_reason: 'stop', message: { content: 'fixture-complete' } }] });
  const result = await adapter.generate(payload, { signal: new AbortController().signal, deadlineMs: Date.now() + 5000 });
  assert.equal(result.text, 'fixture-complete');
  assert.deepEqual(captured().body.messages, payload.messages);
  assert.equal(captured().body.thinking_effort, 'standard');
  assert.equal(captured().headers.authorization, `Bearer ${token}`);
  assert.equal(adapter.status().state, 'ready');
});

test('ChatGPT adapter rejects missing final model identity and incomplete generations', async t => {
  for (const reply of [{ model: 'fixture-chat', choices: [{ finish_reason: 'stop', message: { content: 'unverified' } }] }, { model: 'fixture-chat', model_evidence: proof, choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }]) {
    const { adapter } = await fixture(t, reply);
    await assert.rejects(adapter.generate(payload, { signal: new AbortController().signal, deadlineMs: Date.now() + 5000 }), e => ['model_identity_unverified', 'incomplete_upstream'].includes(e.code));
  }
});

test('ChatGPT adapter refuses external destinations and credential reuse', async () => {
  const { createChatGPTAdapter } = await import('../bridge/adapters/chatgpt.mjs');
  assert.throws(() => createChatGPTAdapter({ upstream: 'https://example.com', token, externalToken }));
  assert.throws(() => createChatGPTAdapter({ token, externalToken: token }));
});
