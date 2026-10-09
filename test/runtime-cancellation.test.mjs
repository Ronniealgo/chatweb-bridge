import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/conversation.js';

test('cancellation during header preparation prevents the generation POST', async () => {
  const controller = new AbortController();
  let posts = 0;
  const client = new ChatClient({
    mintSentinelHeaders: async () => {
      controller.abort();
      return { headers: {} };
    },
  });
  client.postConversationInPage = async () => {
    posts++;
    return 'Generation must not start after cancellation.';
  };
  await assert.rejects(
    client.sendWithSentinel({}, {}, 'mock-placeholder', controller.signal),
    /abort/i,
  );
  assert.equal(posts, 0);
});

test('cancellation as generation returns propagates without delivering model text', async () => {
  const controller = new AbortController();
  const client = new ChatClient({
    pageContext: async () => ({}),
    mintSentinelHeaders: async () => ({ headers: {} }),
  });
  client.prepare = async () => {};
  let posts = 0;
  let deliveredText = '';
  client.postConversationInPage = async () => {
    posts++;
    controller.abort();
    return 'event: delta\ndata: ' + JSON.stringify({ p: '', o: 'add', v: {
      message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Do not deliver this cancelled answer.'] } },
    } }) + '\n\ndata: [DONE]\n\n';
  };
  await assert.rejects(client.run({
    prompt: 'Mock task', signal: controller.signal,
    onTextDelta: text => { deliveredText += text; },
  }, 'mock-placeholder'), /abort/i);
  assert.equal(posts, 1);
  assert.equal(deliveredText, '');
});

test('a transient page-context failure does not replay the generation POST', async () => {
  const client = new ChatClient({});
  let posts = 0;
  const page = {
    evaluate: async fn => {
      if (fn.name === 'startConversationTransaction') { posts++; throw new Error('Execution context was destroyed'); }
      return { state: 'missing' };
    },
  };
  await assert.rejects(
    client.postConversationInPage(page, {}, {}, new AbortController().signal),
    error => error.code === 'browser_submission_uncertain' && error.generationSubmitted === 'unknown' && error.phase === 'generation-submit',
  );
  assert.equal(posts, 1);
  assert.ok(client.chrome.pendingGeneration, 'lost observation must block future navigation until termination is confirmed');
});
