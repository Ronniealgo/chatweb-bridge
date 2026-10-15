#!/usr/bin/env node
// Explicit opt-in: sends real prompts using the configured logged-in website.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, loadToken } from '../bridge/config.mjs';
const option = process.argv.indexOf('--config');
if (option < 0 || !process.argv[option + 1]) throw new Error('Usage: node scripts/accept-live.mjs --config <local.json> [--tools] [--concurrent]');
const config = loadConfig(resolve(process.argv[option + 1]));
const token = loadToken(config.authFile);
const model = config.providers[0].models[0].id;
const origin = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
const marker = `LIVE_${randomUUID().slice(0, 8)}`;
async function call(messages, extra = {}) {
  const started = Date.now();
  const response = await fetch(`${origin}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, ...extra }), signal: AbortSignal.timeout(180000) });
  const ttfbMs = Date.now() - started;
  let body;
  if (extra.stream && response.headers.get('content-type')?.includes('text/event-stream')) {
    const wire = await response.text();
    const chunks = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    const error = chunks.find(c => c.error)?.error;
    if (error) body = { error };
    else {
      const text = chunks.flatMap(c => c.choices ?? []).map(c => c.delta?.content ?? '').join('');
      body = { choices: [{ message: { content: text }, finish_reason: chunks.flatMap(c => c.choices ?? []).find(c => c.finish_reason)?.finish_reason }], done: wire.includes('data: [DONE]') };
    }
  } else body = await response.json();
  return { httpStatus: response.status, ttfbMs, elapsedMs: Date.now() - started, body };
}
const transcript = value => [{ role: 'system', content: `Return exactly ${value}. Do not add explanations.` }, { role: 'user', content: 'Follow the system instruction.' }];
const results = [];
if (process.argv.includes('--tools')) {
  const tools = [{ type: 'function', function: { name: 'echo_marker', description: 'Echo the supplied marker using the external executor.', parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } } }];
  const messages = [{ role: 'user', content: `Call echo_marker with marker ${marker}, then use its real result to return exactly that marker.` }];
  const first = await call(messages, { tools, tool_choice: 'required' });
  const choice = first.body.choices?.[0], tool = choice?.message?.tool_calls?.[0];
  const args = tool ? JSON.parse(tool.function.arguments) : null;
  const valid = first.httpStatus === 200 && choice.finish_reason === 'tool_calls' && tool.function.name === 'echo_marker' && args.marker === marker;
  results.push({ case: 'real-tool-request', ...first, pass: valid });
  if (valid) {
    // This is the real local executor result, not a fabricated website response.
    const toolResult = String(args.marker);
    const second = await call([...messages, choice.message, { role: 'tool', tool_call_id: tool.id, content: toolResult }], { tools, tool_choice: 'none' });
    results.push({ case: 'tool-result-roundtrip', ...second, pass: second.body.choices?.[0]?.message?.content?.trim() === marker });
  }
} else if (process.argv.includes('--concurrent')) {
  const pairs = [marker + '_A', marker + '_B'];
  const replies = await Promise.all(pairs.map(value => call(transcript(value), { stream: true })));
  replies.forEach((reply, i) => results.push({ case: `concurrent-${i + 1}`, ...reply, pass: reply.body.choices?.[0]?.message?.content?.trim() === pairs[i] && reply.body.done === true }));
} else {
  const reply = await call(transcript(marker), { stream: true });
  results.push({ case: 'system-role-and-sse', ...reply, pass: reply.body.choices?.[0]?.message?.content?.trim() === marker && reply.body.choices?.[0]?.finish_reason === 'stop' && reply.body.done === true });
}
console.log(JSON.stringify({ live: true, model, timestamp: new Date().toISOString(), results }, null, 2));
process.exitCode = results.length && results.every(r => r.pass) ? 0 : 1;
