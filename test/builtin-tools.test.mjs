import test from 'node:test';
import assert from 'node:assert/strict';
import { reassembleAll } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/sse-reassembler.js';
import { ChatClient } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';

// Shape captured from a live turn: ChatGPT ran its built-in Python tool twice, then answered.
// Earlier versions returned the first Python source as the reply instead of the final text.
const frame = value => 'event: delta\ndata: ' + JSON.stringify(value) + '\n\n';
const message = (id, role, content, extra = {}) => ({ message: { id, author: { role, ...(extra.name ? { name: extra.name } : {}) }, content,
  recipient: extra.recipient ?? 'all', status: 'finished_successfully', metadata: {}, ...(extra.channel ? { channel: extra.channel } : {}) } });

const builtInToolTurn =
  frame({ p: '', o: 'add', v: message('u1', 'user', { content_type: 'text', parts: ['count squarefree triples'] }) }) +
  frame({ p: '', o: 'add', v: message('c1', 'assistant', { content_type: 'code', language: 'python', text: 'import numpy as np\nprint(1)' }, { recipient: 'python' }) }) +
  frame({ p: '', o: 'add', v: message('t1', 'tool', { content_type: 'execution_output', text: 'np.int64(125476)' }, { name: 'python' }) }) +
  frame({ p: '', o: 'add', v: message('th1', 'assistant', { content_type: 'thoughts', thoughts: [] }) }) +
  frame({ p: '', o: 'add', v: message('c2', 'assistant', { content_type: 'code', language: 'python', text: 'print(2)' }, { recipient: 'python' }) }) +
  frame({ p: '', o: 'add', v: message('r1', 'assistant', { content_type: 'reasoning_recap', content: 'Thought for 6s' }) }) +
  frame({ p: '', o: 'add', v: message('a1', 'assistant', { content_type: 'text', parts: [''] }, { channel: 'final' }) }) +
  frame({ p: '/message/content/parts/0', o: 'append', v: '125' }) +
  frame({ v: '476' }) +
  'data: [DONE]\n\n';

test('a built-in tool turn returns the final text, never the tool source code', () => {
  const streamed = [];
  const result = reassembleAll(builtInToolTurn, { onTextDelta: text => streamed.push(text) });
  assert.equal(result.text, '125476');
  assert.equal(streamed.join(''), '125476');
});

test('a plain turn without built-in tools is unchanged, including multi-chunk text', () => {
  const stream = frame({ p: '', o: 'add', v: message('a1', 'assistant', { content_type: 'text', parts: ['Hel'] }) }) +
    frame({ p: '/message/content/parts/0', o: 'append', v: 'lo ' }) + frame({ v: '世界' }) + 'data: [DONE]\n\n';
  assert.equal(reassembleAll(stream, {}).text, 'Hello 世界');
});

test('reading a finished conversation back skips tool working messages as well', async () => {
  const client = new ChatClient({});
  client.fetchConversationDetail = async () => ({ current_node:'a', mapping: {
    'fixture-user': { message: { id:'fixture-user', author:{role:'user'} } },
    a: { parent:'b', message: { author: { role: 'assistant' }, recipient: 'python', create_time: 5, status: 'finished_successfully', end_turn: false, content: { content_type: 'code', text: 'print(1)' } } },
    b: { parent:'fixture-user', message: { author: { role: 'assistant' }, recipient: 'all', create_time: 4, status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: ['the real answer'] } } },
  } });
  process.env.PCW_POLL_INTERVAL_MS = '1';
  try {
    const result = await client.pollToCompletion({}, 'conversation-id', 'mock-placeholder', {userMessageId:'fixture-user'});
    assert.equal(result.text, 'the real answer');
  } finally { delete process.env.PCW_POLL_INTERVAL_MS; }
});
