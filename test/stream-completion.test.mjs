import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequest, parseModelReply } from '../protocol.mjs';
import { DeltaReassembler, reassembleAll } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/sse-reassembler.js';
import { ChatClient } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';
import { BrowserPreparationError } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/composer.js';

// All submission, preparation and readback methods below are mocks. This file
// does not start a browser, listen on a port or submit a real generation.
const envBefore = { PCW_CAPTURE_DIR: process.env.PCW_CAPTURE_DIR, PCW_POLL_INTERVAL_MS: process.env.PCW_POLL_INTERVAL_MS };
process.env.PCW_CAPTURE_DIR = '';
process.env.PCW_POLL_INTERVAL_MS = '1';
after(() => {
  for (const [name, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const conversationId = 'fixture-conversation';
const userMessageId = 'fixture-user';
const tool = { type: 'function', function: { name: 'fixture_tool', parameters: {
  type: 'object', properties: { value: { type: 'string', minLength: 1 } }, required: ['value'], additionalProperties: false,
} } };
const protocolContext = () => prepareRequest({ model: 'fixture-model', tools: [tool], messages: [{ role: 'user', content: 'Synthetic fixture only.' }] }).context;
const envelope = (context, value) => `<${context.nonce}>${JSON.stringify(value)}</${context.nonce}>`;
const message = (text, extra = {}) => ({
  id: 'fixture-final', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
  content: { content_type: 'text', parts: [text] }, metadata: {},
  status: 'finished_successfully', end_turn: true, create_time: 1, ...extra,
});
const delta = value => `event: delta\ndata: ${JSON.stringify(value)}\n\n`;
const rootDelta = msg => delta({ p: '', o: 'add', v: { conversation_id: conversationId, message: msg } });
const done = 'data: [DONE]\n\n';
const terminalStream = (text, extra) => rootDelta(message(text, extra)) + done;
const errorMatches = code => error => {
  assert.ok(error instanceof BrowserPreparationError);
  assert.equal(error.code, code);
  assert.equal(error.phase, 'response');
  assert.equal(error.generationSubmitted, true);
  return true;
};

function mockStreamClient(stream) {
  const client = new ChatClient({ pageContext: async () => ({}) });
  let submissions = 0, polls = 0;
  client.prepare = async () => {};
  client.sendWithSentinel = async (_page, body) => { submissions++; return typeof stream === 'function' ? stream(body) : stream; };
  client.pollToCompletion = async () => { polls++; throw new Error('Unexpected poll without an explicit handoff'); };
  return { client, counts: () => ({ submissions, polls }) };
}
const runMock = (client, extra = {}) => client.runExclusive({ prompt: 'Fixture only', model: 'fixture-model', signal: AbortSignal.timeout(2000), ...extra }, 'fixture-placeholder');

function detailFromMessages(entries, currentNode) {
  const mapping = { root: { id: 'root', parent: null, message: null } };
  for (const [id, parent, msg] of entries) mapping[id] = { id, parent, message: msg };
  return { mapping, current_node: currentNode };
}
const user = id => ({ id, author: { role: 'user' }, content: { content_type: 'text', parts: ['Fixture request'] } });
const currentDetail = (answer, extra = {}) => detailFromMessages([
  [userMessageId, 'root', user(userMessageId)],
  ['fixture-final', userMessageId, message(answer, extra)],
], 'fixture-final');

async function pollDetail(detail, boundUser = userMessageId) {
  const client = new ChatClient({});
  client.fetchConversationDetail = async () => detail;
  return client.pollToCompletion({}, conversationId, 'fixture-placeholder', { userMessageId: boundUser, signal: AbortSignal.timeout(2000) });
}

// Advance only this process's clock after one mocked read. No real timeout or
// twenty-minute wait is required, and the original clock is always restored.
async function rejectAfterReadback(detail, boundUser = userMessageId) {
  const client = new ChatClient({});
  const originalNow = Date.now;
  let expired = false, reads = 0;
  Date.now = () => expired ? 1_200_001 : 0;
  client.fetchConversationDetail = async () => { reads++; expired = true; return detail; };
  try {
    await assert.rejects(client.pollToCompletion({}, conversationId, 'fixture-placeholder', { userMessageId: boundUser }), errorMatches('browser_stream_incomplete'));
    assert.equal(reads, 1);
  } finally { Date.now = originalNow; }
}

test('long Maxwell final survives JSON escaping and fragmented SSE with confirmed completion', () => {
  const context = protocolContext();
  const paragraph = 'Maxwell: \\(\\nabla\\cdot\\mathbf E=\\rho/\\epsilon_0\\), \\(\\nabla\\times\\mathbf B=\\mu_0\\mathbf J+\\mu_0\\epsilon_0\\partial_t\\mathbf E\\).\nQuoted "text", C:\\fixture\\answer.txt, 中文 and \\backslash.\n';
  const content = paragraph.repeat(100);
  assert.ok(content.length > 6795);
  const text = envelope(context, { content });
  const stream = terminalStream(text);
  const reassembler = new DeltaReassembler();
  for (let offset = 0; offset < stream.length; offset += 23) reassembler.push(stream.slice(offset, offset + 23));
  reassembler.end();
  const result = reassembleAll(stream);
  assert.equal(reassembler.result().text, text);
  assert.equal(result.text, text);
  assert.equal(result.done, true);
  assert.equal(result.parseErrors, 0);
  assert.equal(result.selectedMessage.id, 'fixture-final');
  assert.equal(result.selectedMessage.status, 'finished_successfully');
  assert.equal(result.selectedMessage.endTurn, true);
  assert.equal(result.selectedMessage.channel, 'final');
  assert.equal(parseModelReply(result.text, context).message.content, content);
});

test('confirmed stream returns valid schema-checked tool calls once', async () => {
  const context = protocolContext();
  const text = envelope(context, { tool_calls: [{ name: 'fixture_tool', arguments: { value: 'harmless fixture' } }] });
  const fixture = mockStreamClient(terminalStream(text));
  const result = await runMock(fixture.client);
  const parsed = parseModelReply(result.text, context);
  assert.equal(parsed.finish_reason, 'tool_calls');
  assert.equal(parsed.message.tool_calls.length, 1);
  assert.equal(parsed.message.tool_calls[0].function.name, 'fixture_tool');
  assert.deepEqual(fixture.counts(), { submissions: 1, polls: 0 });
});

for (const [name, suffix, extra] of [
  ['missing DONE', '', {}],
  ['DONE with in-progress message', done, { status: 'in_progress', end_turn: false }],
  ['DONE with end_turn=false', done, { end_turn: false }],
  ['DONE with missing end_turn', done, { end_turn: undefined }],
  ['DONE with failed message', done, { status: 'failed' }],
  ['DONE with commentary only', done, { channel: 'commentary' }],
]) {
  test(`${name} rejects an otherwise valid tool envelope without another submission`, async () => {
    const context = protocolContext();
    const text = envelope(context, { tool_calls: [{ name: 'fixture_tool', arguments: { value: 'harmless' } }] });
    const fixture = mockStreamClient(rootDelta(message(text, extra)) + suffix);
    const published = [];
    await assert.rejects(runMock(fixture.client, { onTextDelta: value => published.push(value) }), errorMatches('browser_stream_incomplete'));
    assert.deepEqual(published, []);
    assert.deepEqual(fixture.counts(), { submissions: 1, polls: 0 });
  });
}

test('malformed delta is reported and rejects stale valid protocol text without resubmission', async () => {
  const context = protocolContext();
  const text = envelope(context, { tool_calls: [{ name: 'fixture_tool', arguments: { value: 'stale harmless value' } }] });
  const stream = rootDelta(message(text)) + 'event: delta\ndata: {"p":"/message/content/parts/0","o":"replace","v":"unfinished\n\n' + done;
  const reassembled = reassembleAll(stream);
  assert.equal(reassembled.done, true);
  assert.equal(reassembled.parseErrors, 1);
  const fixture = mockStreamClient(stream);
  await assert.rejects(runMock(fixture.client), errorMatches('browser_stream_invalid'));
  assert.deepEqual(fixture.counts(), { submissions: 1, polls: 0 });
});

test('truncated trailing delta is counted instead of allowing an earlier complete envelope', async () => {
  const context = protocolContext();
  const text = envelope(context, { content: 'previous fixture' });
  const stream = rootDelta(message(text)) + 'event: delta\ndata: {"p":"/message/content/parts/0","o":"replace","v":"cut off';
  const result = reassembleAll(stream);
  assert.equal(result.done, false);
  assert.equal(result.parseErrors, 1);
  const fixture = mockStreamClient(stream);
  await assert.rejects(runMock(fixture.client), errorMatches('browser_stream_invalid'));
  assert.deepEqual(fixture.counts(), { submissions: 1, polls: 0 });
});

test('commentary and analysis after final cannot replace the selected final or its terminal state', async () => {
  const context = protocolContext();
  const text = envelope(context, { content: 'visible final' });
  const stream = rootDelta(message(text)) +
    rootDelta(message('Fixture commentary', { id: 'commentary', channel: 'commentary', create_time: 2, end_turn: false })) +
    rootDelta(message('Fixture analysis', { id: 'analysis', channel: 'analysis', create_time: 3, end_turn: false })) + done;
  const result = reassembleAll(stream);
  assert.equal(result.text, text);
  assert.equal(result.selectedMessage.id, 'fixture-final');
  assert.equal(result.selectedMessage.endTurn, true);
  const fixture = mockStreamClient(stream);
  assert.equal((await runMock(fixture.client)).text, text);
});

test('legacy null channel is eligible only with strict terminal status and DONE', async () => {
  const fixture = mockStreamClient(terminalStream('legacy fixture', { channel: null }));
  const reassembled = reassembleAll(terminalStream('legacy fixture', { channel: null }));
  assert.equal(reassembled.selectedMessage.channel, null);
  assert.equal((await runMock(fixture.client)).text, 'legacy fixture');
});

test('the final document replacement and updated completion metadata remain authoritative', async () => {
  const context = protocolContext();
  const text = envelope(context, { content: 'final replacement' });
  const stream = rootDelta(message(text + 'STALE_SUFFIX', { status: 'in_progress', end_turn: false })) +
    delta({ p: '/message/content/parts/0', o: 'replace', v: text }) +
    delta({ p: '/message/status', o: 'replace', v: 'finished_successfully' }) +
    delta({ p: '/message/end_turn', o: 'replace', v: true }) + done;
  const fixture = mockStreamClient(stream);
  assert.equal((await runMock(fixture.client)).text, text);
});

test('delta updates after DONE cannot turn an unfinished message into a confirmed tool request', async () => {
  const context = protocolContext();
  const text = envelope(context, { tool_calls: [{ name: 'fixture_tool', arguments: { value: 'after terminal' } }] });
  const stream = rootDelta(message(text, { status: 'in_progress', end_turn: false })) + done +
    delta({ p: '/message/status', o: 'replace', v: 'finished_successfully' }) +
    delta({ p: '/message/end_turn', o: 'replace', v: true });
  const fixture = mockStreamClient(stream);
  await assert.rejects(runMock(fixture.client), errorMatches('browser_stream_invalid'));
  assert.deepEqual(fixture.counts(), { submissions: 1, polls: 0 });
});

for (const [name, pointer, value] of [
  ['analysis', '/message/channel', 'analysis'],
  ['commentary', '/message/channel', 'commentary'],
  ['hidden', '/message/metadata/is_visually_hidden_from_conversation', true],
]) {
  test(`a selected message reclassified as ${name} cannot retain a stale final candidate`, async () => {
    const context = protocolContext();
    const text = envelope(context, { tool_calls: [{ name: 'fixture_tool', arguments: { value: 'same-message reclassification' } }] });
    const stream = rootDelta(message(text)) + delta({ p: pointer, o: 'replace', v: value }) + done;
    const fixture = mockStreamClient(stream);
    await assert.rejects(runMock(fixture.client), errorMatches('browser_stream_incomplete'));
    assert.deepEqual(fixture.counts(), { submissions: 1, polls: 0 });
  });
}

test('an empty channel is not treated as the legacy null channel', async () => {
  const fixture = mockStreamClient(terminalStream('Unrecognized channel fixture', { channel: '' }));
  await assert.rejects(runMock(fixture.client), errorMatches('browser_stream_incomplete'));
  assert.deepEqual(fixture.counts(), { submissions: 1, polls: 0 });
});

test('polling selects final on current branch and ignores newer analysis, commentary and siblings', async () => {
  const detail = detailFromMessages([
    [userMessageId, 'root', user(userMessageId)],
    ['final', userMessageId, message('visible final', { id: 'final', create_time: 1 })],
    ['commentary', 'final', message('Fixture commentary', { id: 'commentary', channel: 'commentary', create_time: 2 })],
    ['analysis', 'commentary', message('Fixture analysis', { id: 'analysis', channel: 'analysis', create_time: 3 })],
    ['other-branch', userMessageId, message('Wrong sibling', { id: 'other-branch', create_time: 100 })],
  ], 'analysis');
  assert.equal((await pollDetail(detail)).text, 'visible final');
});

test('poll timeout rejects partial final instead of returning its previous text', async () => {
  await rejectAfterReadback(currentDetail('unfinished fixture', { status: 'in_progress', end_turn: false }));
});

test('polling requires end_turn to be explicitly true', async () => {
  await rejectAfterReadback(currentDetail('unconfirmed fixture', { end_turn: undefined }));
});

test('polling cannot cross the current user message to return an earlier completed answer', async () => {
  const detail = detailFromMessages([
    ['old-user', 'root', user('old-user')],
    ['old-final', 'old-user', message('Previous request answer', { id: 'old-final', create_time: 100 })],
    [userMessageId, 'old-final', user(userMessageId)],
    ['current-analysis', userMessageId, message('Current analysis only', { id: 'current-analysis', channel: 'analysis', create_time: 101 })],
  ], 'current-analysis');
  await rejectAfterReadback(detail);
});

test('polling cannot use a completed sibling while current branch is still in progress', async () => {
  const detail = detailFromMessages([
    [userMessageId, 'root', user(userMessageId)],
    ['partial', userMessageId, message('Current partial', { id: 'partial', status: 'in_progress', end_turn: false })],
    ['sibling', userMessageId, message('Wrong sibling final', { id: 'sibling', create_time: 100 })],
  ], 'partial');
  await rejectAfterReadback(detail);
});

test('polling rejects a finished current branch that is not descended from this request user', async () => {
  await rejectAfterReadback(currentDetail('Other request final'), 'different-request-user');
});

test('polling cannot fall back to all mapping entries when current_node is absent', async () => {
  const detail = currentDetail('Unbound final');
  delete detail.current_node;
  await rejectAfterReadback(detail);
});

test('polling follows branch order rather than timestamps when a newer final is still incomplete', async () => {
  const detail = detailFromMessages([
    [userMessageId, 'root', user(userMessageId)],
    ['earlier-final', userMessageId, message('Earlier completed candidate', { id: 'earlier-final', create_time: 1 })],
    ['newer-final', 'earlier-final', message('Current unfinished candidate', { id: 'newer-final', create_time: 1, status: 'in_progress', end_turn: false })],
  ], 'newer-final');
  await rejectAfterReadback(detail);
});

test('unreadable handoff conversation reports an incomplete submitted response after bounded reads', async () => {
  const client = new ChatClient({});
  let reads = 0;
  client.fetchConversationDetail = async () => { reads++; return null; };
  await assert.rejects(client.pollToCompletion({}, conversationId, 'fixture-placeholder', { userMessageId, signal: AbortSignal.timeout(2000) }), errorMatches('browser_stream_incomplete'));
  assert.equal(reads, 8);
});

test('handoff reads the submitted user branch and returns its completed final without a second POST', async () => {
  const client = new ChatClient({ pageContext: async () => ({}) });
  let submissions = 0, reads = 0, submittedUser;
  client.prepare = async () => {};
  client.sendWithSentinel = async (_page, body) => {
    submissions++;
    submittedUser = body.messages[0].id;
    return `data: ${JSON.stringify({ type: 'stream_handoff', conversation_id: conversationId, options: [] })}\n\n` + done;
  };
  client.fetchConversationDetail = async () => {
    reads++;
    return detailFromMessages([
      [submittedUser, 'root', user(submittedUser)],
      ['final', submittedUser, message('Handoff final', { id: 'final' })],
    ], 'final');
  };
  const result = await runMock(client);
  assert.equal(result.text, 'Handoff final');
  assert.equal(result.viaPoll, true);
  assert.equal(submissions, 1);
  assert.equal(reads, 1);
});
