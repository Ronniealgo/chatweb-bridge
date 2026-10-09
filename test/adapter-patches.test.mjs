import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient, ChatError } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';
import { ManagedChrome } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/browser/supervisor.js';

const sse = text => 'event: delta\ndata: ' + JSON.stringify({ p: '', o: 'add', v: {
  message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', end_turn: true },
} }) + '\n\ndata: [DONE]\n\n';

async function withEnv(values, fn) {
  const before = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
function runWithBody(captured) {
  const client = new ChatClient({ pageContext: async () => ({}), mintSentinelHeaders: async () => ({ headers: {} }) });
  client.prepare = async () => {};
  client.postConversationInPage = async (_page, body) => { captured.body = body; return sse('ok'); };
  return client.run({ prompt: 'Mock task', model: 'mock-model' }, 'mock-placeholder');
}

test('temporary chat is requested only when PCW_TEMPORARY_CHAT=1', async () => {
  const off = {}; const on = {};
  await withEnv({ PCW_TEMPORARY_CHAT: '' }, () => runWithBody(off));
  await withEnv({ PCW_TEMPORARY_CHAT: '1' }, () => runWithBody(on));
  assert.equal(Object.hasOwn(off.body, 'history_and_training_disabled'), false);
  assert.equal(on.body.history_and_training_disabled, true);
});

test('raw response capture is disabled even when PCW_CAPTURE_DIR is set', async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pcw-capture-'));
  try {
    await withEnv({ PCW_CAPTURE_DIR: '' }, () => runWithBody({}));
    assert.equal(readdirSync(dir).length, 0);
    await withEnv({ PCW_CAPTURE_DIR: dir }, () => runWithBody({}));
    const files = readdirSync(dir);
    assert.equal(files.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('polling gives up after repeated unreadable conversations instead of spinning for minutes', async () => {
  await withEnv({ PCW_POLL_INTERVAL_MS: '1' }, async () => {
    const client = new ChatClient({});
    let reads = 0;
    client.fetchConversationDetail = async () => { reads++; return null; };
    await assert.rejects(
      client.pollToCompletion({}, 'conversation-id', 'mock-placeholder', {}),
      err => err.code === 'browser_stream_incomplete' && err.generationSubmitted === true && /could not be read back/.test(err.message),
    );
    assert.equal(reads, 8);
  });
});

test('polling still returns the finished answer when the conversation becomes readable', async () => {
  await withEnv({ PCW_POLL_INTERVAL_MS: '1' }, async () => {
    const client = new ChatClient({});
    let reads = 0;
    client.fetchConversationDetail = async () => {
      reads++;
      if (reads < 3) return null;
      return { current_node:'a', mapping: { 'fixture-user':{message:{id:'fixture-user',author:{role:'user'}}}, a: { parent:'fixture-user', message: { author: { role: 'assistant' }, create_time: 1, status: 'finished_successfully', end_turn: true, content: { parts: ['final answer'] } } } } };
    };
    const result = await client.pollToCompletion({}, 'conversation-id', 'mock-placeholder', {userMessageId:'fixture-user'});
    assert.equal(result.text, 'final answer');
    assert.equal(reads, 3);
  });
});
