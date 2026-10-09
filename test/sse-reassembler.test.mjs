import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaReassembler, reassembleAll } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/sse-reassembler.js';

const doc = text => ({
  conversation_id: 'test-conversation',
  message: { id: 'test-message', author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, metadata: {} },
});
const delta = (value, newline = '\n') => `event: delta${newline}data: ${JSON.stringify(value)}${newline}${newline}`;

test('a shorter replacement is authoritative and does not retain stale protocol text', () => {
  const good='<dsh_reply_current>{"content":"ok"}</dsh_reply_current>';
  const initial=good+'STILL_STREAMING_STALE_SUFFIX';
  const replacements=[];
  const result=reassembleAll(delta({p:'',o:'add',v:doc(initial)})+delta({p:'/message/content/parts/0',o:'replace',v:good})+'data: [DONE]\n\n',{onTextReplace:value=>replacements.push(value)});
  assert.equal(result.text,good);assert.deepEqual(replacements,[good]);
});
test('a same-length rewritten prefix uses the final document and excludes analysis text', () => {
  const first=doc('wrong');const analysis=doc('private analysis text');analysis.message.id='separate-analysis-message';analysis.message.channel='analysis';
  const result=reassembleAll(delta({p:'',o:'add',v:first})+delta({p:'/message/content/parts/0',o:'replace',v:'right'})+delta({p:'',o:'add',v:analysis})+'data: [DONE]\n\n');
  assert.equal(result.text,'right');
});

test('compact append frames inherit the previous top-level path and operation', () => {
  const chunks = [];
  const result = reassembleAll(
    delta({ p: '', o: 'add', v: doc('A') }) +
    delta({ p: '/message/content/parts/0', o: 'append', v: 'B' }) +
    delta({ v: 'C' }) +
    delta({ v: '中文' }) +
    'data: [DONE]\n\n',
    { onTextDelta: text => chunks.push(text) },
  );
  assert.equal(result.text, 'ABC中文');
  assert.equal(chunks.join(''), 'ABC中文');
  assert.equal(result.conversationId, 'test-conversation');
});

test('patch children do not replace the top-level inheritance used by the following compact patch frame', () => {
  const reassembler = new DeltaReassembler();
  reassembler.push(delta({ p: '', o: 'add', v: doc('A') }));
  reassembler.push(delta({ p: '/message/content/parts/0', o: 'append', v: 'B' }));
  reassembler.push(delta({ v: 'C' }));
  reassembler.push(delta({ p: '', o: 'patch', v: [
    { p: '/message/content/parts/0', o: 'append', v: 'D' },
    { p: '/message/metadata', o: 'append', v: { marker: 'first' } },
  ] }));
  reassembler.push(delta({ v: [
    { p: '/message/content/parts/0', o: 'append', v: 'E' },
    { p: '/message/metadata', o: 'append', v: { second: true } },
  ] }));
  reassembler.end();
  assert.equal(reassembler.result().text, 'ABCDE');
  assert.deepEqual(reassembler.doc.message.metadata, { marker: 'first', second: true });
});

test('object append merges metadata fields without stringifying or dropping earlier entries', () => {
  const reassembler = new DeltaReassembler();
  reassembler.push(delta({ p: '', o: 'add', v: doc('Visible answer') }));
  reassembler.push(delta({ p: '/message/metadata', o: 'append', v: { first: 1 } }));
  reassembler.push(delta({ v: { second: { nested: true } } }));
  reassembler.end();
  assert.equal(reassembler.result().text, 'Visible answer');
  assert.deepEqual(reassembler.doc.message.metadata, { first: 1, second: { nested: true } });
});

test('CRLF SSE split at every character preserves the complete answer and DONE control', () => {
  const reassembler = new DeltaReassembler();
  const stream = 'event: delta_encoding\r\ndata: "v1"\r\n\r\n' +
    delta({ p: '', o: 'add', v: doc('Start ') }, '\r\n') +
    delta({ p: '/message/content/parts/0', o: 'append', v: '中' }, '\r\n') +
    delta({ v: '文 end' }, '\r\n') +
    'data: [DONE]\r\n\r\n';
  for (const character of stream) reassembler.push(character);
  reassembler.end();
  assert.equal(reassembler.result().text, 'Start 中文 end');
  assert.equal(reassembler.isDone, true);
});
