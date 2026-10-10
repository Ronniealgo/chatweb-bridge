import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRequest, parseModelReply, completion, completionSSE, sweepStaleUploads } from '../protocol.mjs';

const readTool = {
  type: 'function',
  function: {
    name: 'read_file', description: 'Read a local text file.',
    parameters: {
      type: 'object', properties: {
        path: { type: 'string', minLength: 1 },
        mode: { enum: ['text', 'lines'] },
        count: { type: 'integer', minimum: 1, maximum: 10 },
      }, required: ['path'], additionalProperties: false,
    },
  },
};
const writeTool = {
  type: 'function', function: { name: 'write_file', parameters: {
    type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false,
  } },
};
const request = overrides => ({ model: 'test-model', messages: [{ role: 'user', content: 'Read example.txt' }], tools: [readTool, writeTool], ...overrides });
const envelope = (context, payload) => `<${context.nonce}>${JSON.stringify(payload)}</${context.nonce}>`;
const toolPayload = (name = 'read_file', args = { path: 'example.txt' }) => ({ tool_calls: [{ name, arguments: args }] });
const protocolError = err => err.status === 422 && err.code === 'invalid_tool_protocol';

test('compaction with historical tools keeps Markdown inside the strict current content envelope', () => {
  const summaryRequest = 'You are now acting as a compaction engine. Output EXACTLY the Markdown structure below. Output only the checkpoint text: do not call any tool or take any other action.';
  const { upstreamBody, context } = prepareRequest(request({ messages: [
    {role:'system',content:'Continue the local task using the external tools.'},
    {role:'user',content:'Build the original files.'},
    {role:'user',content:summaryRequest},
  ] }));
  const transcript = JSON.parse(upstreamBody.messages[1].content);
  assert.equal(transcript.conversation.at(-1).content, summaryRequest);
  assert.match(upstreamBody.messages[0].content, /describe the value of the content string/);
  assert.match(transcript.reply_contract, /checkpoint formatting belong inside the escaped content string/);
  const checkpoint = '## Files and Code\n- C:\\fixture\\answer.md: "verified"\n## Next Step\n- Continue.';
  const parsed = parseModelReply(envelope(context,{content:checkpoint}),context);
  assert.equal(parsed.message.content,checkpoint);assert.equal(parsed.finish_reason,'stop');
  assert.throws(()=>parseModelReply(checkpoint,context),protocolError);
  assert.throws(()=>parseModelReply(envelope(context,{content:checkpoint}).slice(0,-10),context),protocolError);
  assert.throws(()=>parseModelReply(envelope(context,{tool_calls:[{name:'unlisted',arguments:{}}]}),context),protocolError);
});

test('prepareRequest preserves complete roles, text, tool calls, IDs and result ordering', () => {
  const messages = [
    { role: 'system', content: 'System policy' },
    { role: 'developer', content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] },
    { role: 'user', content: 'Read it: <untrusted>中文</untrusted>' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"example.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_read_1', content: '{"contents":"real result"}' },
    { role: 'assistant', content: 'I have the result.' },
    { role: 'user', content: 'Summarize it.' },
  ];
  const { upstreamBody, context } = prepareRequest(request({ messages, stream: true, reasoning_effort: 'high' }));
  const history = JSON.parse(upstreamBody.messages[1].content).conversation;
  assert.deepEqual(history, [
    { role: 'system', content: 'System policy' },
    { role: 'developer', content: 'First\nSecond' },
    { role: 'user', content: 'Read it: <untrusted>中文</untrusted>' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_read_1', name: 'read_file', arguments: { path: 'example.txt' } }] },
    { role: 'tool', tool_call_id: 'call_read_1', content: '{"contents":"real result"}' },
    { role: 'assistant', content: 'I have the result.' },
    { role: 'user', content: 'Summarize it.' },
  ]);
  assert.equal(upstreamBody.model, 'test-model');
  assert.equal(upstreamBody.stream, false);
  assert.equal(upstreamBody.reasoning_effort, 'high');
  assert.equal(Object.hasOwn(upstreamBody, 'tools'), false);
  assert.ok(upstreamBody.messages[0].content.includes(`<${context.nonce}>JSON</${context.nonce}>`));
  assert.ok(upstreamBody.messages[0].content.includes(JSON.stringify(readTool.function.parameters)));
  assert.notEqual(context.nonce, prepareRequest(request()).context.nonce);
});

test('valid reply yields an OpenAI tool call with a generated ID and JSON argument string', () => {
  const { context } = prepareRequest(request());
  const result = parseModelReply(envelope(context, toolPayload()), context);
  assert.equal(result.finish_reason, 'tool_calls');
  assert.equal(result.message.role, 'assistant');
  assert.equal(result.message.content, null);
  assert.match(result.message.tool_calls[0].id, /^call_[a-f0-9]{32}$/);
  assert.equal(result.message.tool_calls[0].type, 'function');
  assert.deepEqual(result.message.tool_calls[0].function, { name: 'read_file', arguments: '{"path":"example.txt"}' });
});

test('content containing executable-looking text stays content', () => {
  const { context } = prepareRequest(request());
  const content = 'Example only: {"tool_calls":[{"name":"write_file","arguments":{"path":"x","content":"y"}}]}';
  assert.deepEqual(parseModelReply(envelope(context, { content }), context), {
    message: { role: 'assistant', content }, finish_reason: 'stop',
  });
});

for (const [name, makeText] of [
  ['plain JSON', c => JSON.stringify(toolPayload())],
  ['wrong nonce', c => '<dsh_reply_wrong>{"content":"x"}</dsh_reply_wrong>'],
  ['Markdown fence', c => '```json\n' + envelope(c, toolPayload()) + '\n```'],
  ['leading prose', c => 'I will call a tool.\n' + envelope(c, toolPayload())],
  ['trailing prose', c => envelope(c, toolPayload()) + '\nDone'],
  ['truncated envelope', c => `<${c.nonce}>{"content":"partial"}`],
  ['malformed JSON', c => `<${c.nonce}>{"tool_calls":[}</${c.nonce}>`],
  ['multiple envelopes', c => envelope(c, toolPayload()) + envelope(c, toolPayload())],
]) {
  test(`rejects ${name} without returning a tool call`, () => {
    const { context } = prepareRequest(request());
    assert.throws(() => parseModelReply(makeText(context), context), protocolError);
  });
}

for (const [name, payload] of [
  ['mixed content and calls', { content: 'x', ...toolPayload() }],
  ['extra top-level key', { ...toolPayload(), explanation: 'x' }],
  ['non-object payload', []],
  ['non-string content', { content: null }],
  ['empty calls', { tool_calls: [] }],
  ['missing calls', { unexpected: [] }],
  ['unknown tool', toolPayload('delete_everything')],
  ['extra call field', { tool_calls: [{ name: 'read_file', arguments: { path: 'x' }, extra: true }] }],
  ['arguments as JSON string', toolPayload('read_file', '{"path":"x"}')],
  ['arguments as array', toolPayload('read_file', ['x'])],
  ['missing required argument', toolPayload('read_file', {})],
  ['wrong argument type', toolPayload('read_file', { path: 12 })],
  ['extra argument', toolPayload('read_file', { path: 'x', execute: true })],
  ['enum violation', toolPayload('read_file', { path: 'x', mode: 'shell' })],
  ['integer violation', toolPayload('read_file', { path: 'x', count: 1.5 })],
  ['maximum violation', toolPayload('read_file', { path: 'x', count: 11 })],
  ['minimum string length violation', toolPayload('read_file', { path: '' })],
  ['valid first call followed by invalid call', { tool_calls: [toolPayload().tool_calls[0], { name: 'unknown', arguments: {} }] }],
]) {
  test(`rejects ${name} atomically`, () => {
    const { context } = prepareRequest(request());
    assert.throws(() => parseModelReply(envelope(context, payload), context), protocolError);
  });
}

test('tool_choice none permits content and rejects tools', () => {
  const { context } = prepareRequest(request({ tool_choice: 'none' }));
  assert.equal(parseModelReply(envelope(context, { content: 'Answer' }), context).finish_reason, 'stop');
  assert.throws(() => parseModelReply(envelope(context, toolPayload()), context), protocolError);
});
test('tool_choice required rejects content and permits tools', () => {
  const { context } = prepareRequest(request({ tool_choice: 'required' }));
  assert.throws(() => parseModelReply(envelope(context, { content: 'Answer' }), context), protocolError);
  assert.equal(parseModelReply(envelope(context, toolPayload()), context).finish_reason, 'tool_calls');
});
test('named tool_choice permits only the requested function', () => {
  const { context } = prepareRequest(request({ tool_choice: { type: 'function', function: { name: 'write_file' } } }));
  assert.throws(() => parseModelReply(envelope(context, { content: 'Answer' }), context), protocolError);
  assert.throws(() => parseModelReply(envelope(context, toolPayload()), context), protocolError);
  assert.equal(parseModelReply(envelope(context, toolPayload('write_file', { path: 'x', content: 'y' })), context).finish_reason, 'tool_calls');
});
test('parallel_tool_calls false rejects multiple calls while permitting one', () => {
  const { context } = prepareRequest(request({ parallel_tool_calls: false }));
  const payload = { tool_calls: [toolPayload().tool_calls[0], toolPayload().tool_calls[0]] };
  assert.throws(() => parseModelReply(envelope(context, payload), context), protocolError);
  assert.equal(parseModelReply(envelope(context, toolPayload()), context).message.tool_calls.length, 1);
});

test('SSE yields consistent completion metadata, contiguous call indices and intact IDs', () => {
  const { context } = prepareRequest(request());
  const payload = { tool_calls: [toolPayload().tool_calls[0], toolPayload('write_file', { path: 'out', content: '中文\nline' }).tool_calls[0]] };
  const parsed = parseModelReply(envelope(context, payload), context);
  const result = completion('actual-model', parsed);
  const events = completionSSE(result).trim().split('\n\n').map(line => line.slice('data: '.length));
  assert.equal(events.pop(), '[DONE]');
  const chunks = events.map(JSON.parse);
  assert.equal(chunks.length, 3);
  for (const c of chunks) {
    assert.equal(c.object, 'chat.completion.chunk');
    assert.equal(c.id, result.id);
    assert.equal(c.model, 'actual-model');
    assert.equal(c.created, result.created);
    assert.equal(c.choices[0].index, 0);
  }
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant' });
  assert.deepEqual(chunks[1].choices[0].delta.tool_calls, parsed.message.tool_calls.map((call, index) => ({ index, ...call })));
  assert.notEqual(parsed.message.tool_calls[0].id, parsed.message.tool_calls[1].id);
  assert.equal(chunks[2].choices[0].finish_reason, 'tool_calls');
});

test('no-tool requests retain plain-text transport behavior', () => {
  const { context } = prepareRequest(request({ tools: [] }));
  assert.equal(context.toolMode, false);
  assert.deepEqual(parseModelReply('Plain answer', context), { message: { role: 'assistant', content: 'Plain answer' }, finish_reason: 'stop' });
});

for (const [name, override] of [
  ['empty messages', { messages: [] }],
  ['missing model', { model: '' }],
  ['unknown role', { messages: [{ role: 'function', content: 'x' }] }],
  ['image input', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image' } }] }] }],
  ['unidentified tool result', { messages: [{ role: 'tool', content: 'x' }] }],
  ['non-JSON historical arguments', { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: 'broken' } }] }] }],
  ['duplicate tool name', { tools: [readTool, readTool] }],
  ['invalid JSON Schema', { tools: [{ type: 'function', function: { name: 'broken', parameters: { type: 'invalid-schema-type' } } }] }],
  ['required without tools', { tools: [], tool_choice: 'required' }],
  ['unknown forced name', { tool_choice: { type: 'function', function: { name: 'unknown' } } }],
  ['legacy function request', { functions: [] }],
  ['multiple choices', { n: 2 }],
  ['stop override', { stop: ['END'] }],
]) {
  test(`request validation rejects ${name}`, () => {
    assert.throws(() => prepareRequest(request(override)), err => err.status === 400 && err.code === 'invalid_request');
  });
}

// --- image attachments (local feature) ---------------------------------------
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pngUrl = `data:image/png;base64,${tinyPng.toString('base64')}`;
const uploadDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcw-img-test-'));
  process.env.PCW_UPLOAD_DIR = dir;
  return dir;
};

test('base64 image parts become temp files with markers, dedupe and a cleanup hook', async t => {
  const dir = uploadDir();
  t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PCW_UPLOAD_DIR; });
  const prepared = prepareRequest(request({ messages: [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: pngUrl } }, { type: 'text', text: 'Read the top line of the image' }] },
    { role: 'assistant', content: 'Understood.' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: pngUrl } }] },
  ] }));
  assert.equal(prepared.upstreamBody.images.length, 1, 'identical bytes dedupe to one upload');
  const image = prepared.upstreamBody.images[0];
  assert.equal(image.media_type, 'image/png');
  assert.equal(image.name, 'image-1.png');
  assert.deepEqual(readFileSync(image.path), tinyPng);
  const transcript = JSON.parse(prepared.upstreamBody.messages[1].content).conversation;
  assert.equal(transcript[0].content, `[图片 #1]\nRead the top line of the image`);
  assert.equal(transcript[1].content, 'Understood.');
  assert.equal(transcript[2].content, '[图片 #1]', 'the repeated image references the first marker');
  assert.match(prepared.upstreamBody.messages[0].content, /image file is attached/);
  assert.match(prepared.upstreamBody.messages[0].content, /\[图片 #1\]/);
  assert.equal(prepared.context.toolMode, true, 'tools stay available in image turns');
  prepared.cleanup();
  assert.equal(existsSync(image.path), false, 'cleanup deletes the temp file');
});

test('image content in the responses surface and whitespace-padded data URLs still parse', async t => {
  const dir = uploadDir();
  t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PCW_UPLOAD_DIR; });
  const padded = `data:image/png;base64, ${tinyPng.toString('base64').replace(/(.{20})/g, '$1\n')} `;
  const prepared = prepareRequest(request({ messages: [{ role: 'user', content: [
    { type: 'input_image', image_url: padded }, // responses-surface style part
  ] }] }));
  assert.equal(prepared.upstreamBody.images.length, 1);
  assert.deepEqual(readFileSync(prepared.upstreamBody.images[0].path), tinyPng);
});

test('text-only requests keep the original prepareRequest shape', () => {
  const prepared = prepareRequest(request());
  assert.equal('images' in prepared.upstreamBody, false);
  assert.equal('cleanup' in prepared, false);
  assert.doesNotMatch(prepared.upstreamBody.messages[0].content, /image file/);
  assert.equal(JSON.parse(prepared.upstreamBody.messages[1].content).attached_images, undefined);
});

for (const [name, parts] of [
  ['svg images', [{ type: 'image_url', image_url: { url: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` } }]],
  ['more than 8 images', Array.from({ length: 9 }, (_, i) => ({ type: 'image_url', image_url: { url: `data:image/gif;base64,${Buffer.from([i]).toString('base64')}` } }))],
  ['empty image data', [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' } }]],
]) test(`image validation rejects ${name}`, () => {
  assert.throws(() => prepareRequest(request({ messages: [{ role: 'user', content: parts }] })),
    err => err.status === 400 && err.code === 'invalid_request');
});

test('sweepStaleUploads removes only stale pcw-img files', t => {
  const dir = uploadDir();
  t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PCW_UPLOAD_DIR; });
  const stale = join(dir, 'pcw-img-stale.png'), fresh = join(dir, 'pcw-img-fresh.png'), foreign = join(dir, 'other.png');
  for (const path of [stale, fresh, foreign]) writeFileSync(path, 'x');
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.equal(sweepStaleUploads(), 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(foreign), true, 'non-bridge files are never touched');
});
