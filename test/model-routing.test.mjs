import { bridgeAuth, adapterAuth, externalToken, upstreamToken, authFetch } from './http-auth-fixture.mjs';
const fetch = authFetch(externalToken);
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createModelRegistry, applyModelRoute, verifyModelResult } from '../model-routes.mjs';
import { createBridge } from '../server.mjs';
import { ChatClient } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';
import { parseOpenAIRequest } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/translate.js';

// These intentionally fictitious IDs are fixtures, never real account model metadata.
const slug = 'fixture-web-exact';
const row = () => ({ slug, display_name: 'Synthetic web model', thinking_efforts: ['fixture-intensive', 'standard'],
  reasoning_efforts: { low: 'standard', max: 'fixture-intensive' }, default_effort: 'low', context_window: 100000, max_output_tokens: 10000,
  evidence: { source: 'chatgpt-web-account-metadata', captured_at: '2026-10-09T00:00:00Z', sha256: 'a'.repeat(64) } });
const registry = () => createModelRegistry({ schema: 1, models: [row()] });
const request = extra => ({ model: slug, reasoning_effort: 'max', messages: [{ role: 'user', content: 'Synthetic input' }], ...extra });
const final = (model, text = 'synthetic answer', extra = {}) => ({ id: 'answer', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
  metadata: model === undefined ? {} : { model_slug: model }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', end_turn: true, ...extra });
const delta = message => 'event: delta\ndata: ' + JSON.stringify({ p: '', o: 'add', v: { message } }) + '\n\n';
const stream = (...messages) => messages.map(delta).join('') + 'data: [DONE]\n\n';
const proof = (model = slug) => ({ requested_model: slug, observed_model: model, source: 'stream-final' });
const reply = (model = slug, evidence = proof(model)) => ({ model, model_evidence: evidence, choices: [{ finish_reason: 'stop', message: { content: 'synthetic answer' } }] });

async function fixture(t, fetchImpl, modelRegistry = registry()) {
  const server = createBridge({ ...bridgeAuth, modelRegistry, upstream: 'http://127.0.0.1:9', fetchImpl, logger: { info() {}, error() {} } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: path => fetch(base + path), post: (body, path = '/v1/chat/completions') => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}

test('shipped catalog preserves legacy routes and has no invented new model options', () => {
  const metadata = JSON.parse(readFileSync(new URL('../web-model-metadata.json', import.meta.url)));
  assert.deepEqual(metadata, { schema: 1, models: [] });
  assert.deepEqual(createModelRegistry(metadata).catalog().map(row => row.id), ['gpt-5-6-thinking', 'gpt-5-6', 'gpt-5.6-sol']);
});

test('reviewed metadata cannot replace legacy IDs or omit provenance and supported efforts', () => {
  for (const change of [{ slug: 'gpt-5-6-thinking' }, { evidence: {} }, { default_effort: 'unknown' },
    { reasoning_efforts: { max: 'not-in-metadata' } }, { slug: '../unsafe' }, { access_token: 'synthetic-forbidden-field' }])
    assert.throws(() => createModelRegistry({ schema: 1, models: [{ ...row(), ...change }] }), /Invalid reviewed/);
});

test('DSH overlay contains exact metadata labels, declared effort keys, and no default selection', () => {
  const patch = registry().dshPatch();
  assert.equal(patch.length, 1); assert.equal(patch[0].id, 'llm-pi-ai');
  const models = patch[0].config.providers['chatgpt-chat-tools'].models;
  assert.equal(models[0].id, 'gpt-5-6-thinking');
  assert.deepEqual(models[1], { id: slug, name: 'Synthetic web model', contextWindow: 100000, maxTokens: 10000, reasoningEfforts: { low: 'low', max: 'max' } });
  assert.equal(JSON.stringify(patch).includes('agent-default-model'), false);
});

test('unknown model and unrecorded effort fail before any upstream request', async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; throw new Error('must not send'); });
  for (const [body, code] of [[request({ model: 'fixture-unconfigured' }), 'unsupported_model'], [request({ reasoning_effort: 'high' }), 'unsupported_reasoning_effort']]) {
    const response = await f.post(body); assert.equal(response.status, 400);
    const error = (await response.json()).error; assert.equal(error.code, code); assert.equal(error.generation_submitted, false);
  }
  assert.equal(calls, 0);
});

test('catalog is metadata only and route application detects a model rewritten before sending', async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; });
  const catalog = await (await f.get('/v1/models')).json();
  assert.equal(catalog.data.at(-1).display_name, row().display_name); assert.equal(calls, 0);
  assert.throws(() => applyModelRoute({ model: 'wrong' }, registry().route(request())), error => error.code === 'model_route_mismatch' && error.details.generation_submitted === false);
});

for (const surface of ['chat', 'responses']) test(`${surface} sends exact model and metadata effort without legacy max-to-high conversion`, async t => {
  let sent; const f = await fixture(t, async (_url, init) => { sent = JSON.parse(init.body); return Response.json(reply()); });
  const response = await f.post(surface === 'chat' ? request() : { model: slug, reasoning: { effort: 'max' }, input: 'fixture' }, surface === 'chat' ? '/v1/chat/completions' : '/v1/responses');
  assert.equal(response.status, 200); assert.equal(sent.model, slug); assert.equal(sent.thinking_effort, 'fixture-intensive');
  assert.equal(sent.reasoning_effort, undefined); assert.equal(sent.dsh_require_model_evidence, true);
  assert.equal(parseOpenAIRequest(sent).effort, 'fixture-intensive');
});

for (const [name, result, code] of [
  ['missing observed identity', reply(slug, undefined), 'model_identity_unverified'],
  ['null observed identity', reply(slug, proof(null)), 'model_identity_unverified'],
  ['different observed identity', reply('fixture-other', proof('fixture-other')), 'model_identity_mismatch'],
  ['wrong requested identity', reply(slug, { ...proof(), requested_model: 'fixture-other' }), 'model_identity_mismatch'],
]) test(`${name} blocks even a valid tool envelope and suppresses identical replay`, async t => {
  // undefined defaults in reply() are removed explicitly for this case.
  if (name === 'missing observed identity') delete result.model_evidence;
  let calls = 0;
  const f = await fixture(t, async (_url, init) => {
    calls++; const body = JSON.parse(init.body), nonce = body.messages[0].content.match(/<(dsh_reply_[a-f0-9]+)>JSON<\//)[1];
    return Response.json({ ...result, choices: [{ finish_reason: 'stop', message: { content: `<${nonce}>{"tool_calls":[{"name":"read_file","arguments":{}}]}</${nonce}>` } }] });
  });
  const body = request({ tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }], stream: true });
  const response = await f.post(body); assert.equal(response.status, 422); assert.match(response.headers.get('content-type'), /application\/json/);
  const value = await response.json(); assert.equal(value.error.code, code); assert.equal(value.error.generation_submitted, true); assert.equal(value.choices, undefined);
  assert.equal((await f.post(body)).status, 422); assert.equal(calls, 1);
});

test('final message identity is authoritative after commentary from another model', async () => {
  const client = new ChatClient({ pageContext: async () => ({}) }); let sent;
  client.prepare = async () => {}; client.sendWithSentinel = async (_page, body) => { sent = body; return stream(final(slug), final('fixture-other', 'commentary', { id: 'later', channel: 'commentary', end_turn: false })); };
  const result = await client.runExclusive({ prompt: 'fixture', model: slug, effort: 'fixture-intensive', requireModelEvidence: true }, 'synthetic-placeholder');
  assert.equal(sent.model, slug); assert.equal(sent.thinking_effort, 'fixture-intensive');
  assert.equal(result.model, slug); assert.equal(result.observedModel, slug);
});

for (const observed of [undefined, 'fixture-other']) test(`adapter blocks ${observed ?? 'absent'} final identity before publishing text`, async () => {
  const client = new ChatClient({ pageContext: async () => ({}) }); let submissions = 0, published = 0;
  client.prepare = async () => {}; client.sendWithSentinel = async () => { submissions++; return stream(final(observed)); };
  await assert.rejects(client.runExclusive({ prompt: 'fixture', model: slug, requireModelEvidence: true, onTextDelta: () => published++ }, 'synthetic-placeholder'),
    error => error.code === (observed ? 'browser_model_identity_mismatch' : 'browser_model_identity_unverified') && error.generationSubmitted === true);
  assert.equal(submissions, 1); assert.equal(published, 0);
});

test('handoff identity comes from the final answer bound to this user message', async () => {
  const client = new ChatClient({});
  client.fetchConversationDetail = async () => ({ current_node: 'answer', mapping: {
    user: { message: { id: 'user', author: { role: 'user' } } }, answer: { parent: 'user', message: final(slug) },
    unrelated: { message: final('fixture-other') },
  } });
  const result = await client.pollToCompletion({}, 'synthetic-conversation', 'synthetic-placeholder', { userMessageId: 'user' });
  assert.equal(result.observedModel, slug);
  verifyModelResult(reply(slug, { ...proof(), observed_model: result.observedModel, source: 'conversation-final' }), registry().route(request()));
});
