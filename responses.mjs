import { randomUUID } from 'node:crypto';
import { BridgeError } from './protocol.mjs';

const fail = message => { throw new BridgeError(message, 400, 'unsupported_responses_request'); };
const text = value => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) fail('Responses content must be text.');
  return value.map(part => {
    if (!['input_text', 'output_text', 'text'].includes(part?.type) || typeof part.text !== 'string')
      fail('This ChatGPT Web route supports text only; images and files are not supported.');
    return part.text;
  }).join('\n');
};
const key = (name, namespace) => namespace ? `${namespace}.${name}` : name;

// Stateless conversion: all history is supplied by the local harness. No remote Responses IDs,
// API credentials, hosted tools or paid fallback are used by this module.
export function responsesRequest(body) {
  if (!body || typeof body !== 'object') fail('Expected a Responses object.');
  if (body.previous_response_id) fail('previous_response_id is unsupported; send the complete input history.');
  if (body.background) fail('background is unsupported.');
  if (body.text?.format && body.text.format.type !== 'text') fail('Structured response formats are unsupported.');
  const mapping = new Map(), reverse = new Map(), tools = [];
  function add(tool, namespace) {
    if (tool?.type === 'namespace') {
      if (namespace || typeof tool.name !== 'string' || !Array.isArray(tool.tools)) fail('Invalid namespace tool.');
      for (const child of tool.tools) add(child, tool.name);
      return;
    }
    if (!['function', 'custom'].includes(tool?.type)) fail(`Unsupported hosted tool: ${tool?.type}. Use local harness tools.`);
    if (typeof tool.name !== 'string' || !tool.name) fail('Tool name is required.');
    namespace ??= tool.namespace;
    const full = key(tool.name, namespace);
    if (reverse.has(full)) fail('Duplicate tool name.');
    let alias = namespace ? `ns_${tools.length}_${tool.name}` : tool.name;
    let suffix = 0;
    while (mapping.has(alias)) alias = `bridge_${suffix++}_${tool.name}`;
    const descriptor = { name: tool.name, namespace, type: tool.type };
    mapping.set(alias, descriptor); reverse.set(full, alias);
    tools.push({ type: 'function', function: {
      name: alias,
      description: `${namespace ? `Namespace ${namespace}. ` : ''}${tool.description ?? ''}${tool.type === 'custom' ? `\nFreeform tool: put the exact tool input in the input string.${tool.format ? ` Input format: ${JSON.stringify(tool.format)}` : ''}` : ''}`,
      parameters: tool.type === 'custom'
        ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
        : tool.parameters ?? { type: 'object', properties: {} },
    } });
  }
  if (body.tools != null && !Array.isArray(body.tools)) fail('tools must be an array.');
  // Codex advertises hosted web_search even for catalogs without search support. It cannot be
  // executed by the local harness; exclude that declaration explicitly, retaining browser/MCP tools.
  const omittedSearch = (body.tools ?? []).some(t => ['web_search', 'web_search_preview'].includes(t?.type));
  for (const tool of body.tools ?? []) if (!['web_search', 'web_search_preview'].includes(tool?.type)) add(tool);
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: text(body.instructions) });
  if (omittedSearch) messages.push({ role: 'system', content: 'Hosted web_search is unavailable on this ChatGPT Web bridge. Only the listed local tools can be called. Use an available browser tool when web access is needed; never invent web search results.' });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input)) fail('input must be text or an array.');
  for (const item of input) {
    if (!item || typeof item !== 'object') fail('Invalid input item.');
    if (item.type === 'message' || (!item.type && item.role)) {
      messages.push({ role: item.role, content: text(item.content) });
    } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
      if (!item.call_id || typeof item.name !== 'string') fail('Tool calls need call_id and name.');
      const name = reverse.get(key(item.name, item.namespace)) ?? item.name;
      if (item.type === 'custom_tool_call' && typeof item.input !== 'string') fail('Custom tool input must be text.');
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: {
        name, arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments,
      } }] });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: text(item.output) });
    } else if (item.type === 'reasoning') {
      // Opaque provider reasoning is not portable; visible summaries can be retained as context.
      const summary = (item.summary ?? []).filter(p => typeof p.text === 'string').map(p => p.text).join('\n');
      if (summary) messages.push({ role: 'assistant', content: summary });
    } else fail(`Unsupported input item: ${item.type}. Start a new chat if it contains opaque compacted history.`);
  }
  let choice = body.tool_choice;
  if (choice && typeof choice === 'object') {
    if (!['function', 'custom'].includes(choice.type)) fail('Unsupported tool_choice.');
    const alias = reverse.get(key(choice.name, choice.namespace));
    if (!alias) fail('tool_choice references an unknown tool.');
    choice = { type: 'function', function: { name: alias } };
  }
  const effort = body.reasoning?.effort;
  const legacyModel = ['chatgpt-web-gpt-5.6-sol', 'gpt-5-6-thinking', 'gpt-5-6', 'gpt-5.6-sol'].includes(body.model);
  return {
    body: { model: body.model === 'chatgpt-web-gpt-5.6-sol' ? 'gpt-5-6-thinking' : body.model,
      messages, tools, stream: body.stream === true, tool_choice: choice,
      parallel_tool_calls: body.parallel_tool_calls,
      reasoning_effort: legacyModel && ['xhigh', 'ultra', 'max'].includes(effort) ? 'high' : effort },
    mapping,
    // Estimated usage is only for harness context compaction, never billing/quota evidence.
    estimatedInputTokens: Math.ceil(JSON.stringify({ messages, tools }).length / 3),
  };
}

export function responsesResult(model, parsed, context) {
  const output = parsed.message.tool_calls?.map(call => {
    const tool = context.mapping.get(call.function.name);
    if (!tool) throw new BridgeError('Unknown translated tool.', 422, 'invalid_tool_protocol');
    const common = { id: `item_${randomUUID().replaceAll('-', '')}`, call_id: call.id,
      name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), status: 'completed' };
    return tool.type === 'custom'
      ? { ...common, type: 'custom_tool_call', input: JSON.parse(call.function.arguments).input }
      : { ...common, type: 'function_call', arguments: call.function.arguments };
  }) ?? [{ id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: parsed.message.content, annotations: [] }] }];
  const inputTokens = context.estimatedInputTokens, outputTokens = Math.ceil(JSON.stringify(output).length / 3);
  return { id: `resp_${randomUUID().replaceAll('-', '')}`, object: 'response', created_at: Math.floor(Date.now()/1000),
    status: 'completed', model, output, error: null, incomplete_details: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    metadata: { usage_source: 'local_character_estimate', transport: 'chatgpt-web-conversation' } };
}

export function responsesSSE(result) {
  let sequence = 0;
  const lines = [];
  const event = (type, data) => lines.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  const pending = { ...result, status: 'in_progress', output: [], usage: null };
  event('response.created', { response: pending });
  event('response.in_progress', { response: pending });
  result.output.forEach((item, output_index) => {
    const empty = { ...item, status: 'in_progress' };
    if (item.type === 'message') empty.content = [];
    else if (item.type === 'function_call') empty.arguments = '';
    else empty.input = '';
    event('response.output_item.added', { output_index, item: empty });
    const ref = { item_id: item.id, output_index };
    if (item.type === 'message') {
      const part = item.content[0], p = { ...ref, content_index: 0 };
      event('response.content_part.added', { ...p, part: { ...part, text: '' } });
      event('response.output_text.delta', { ...p, delta: part.text });
      event('response.output_text.done', { ...p, text: part.text });
      event('response.content_part.done', { ...p, part });
    } else if (item.type === 'function_call') {
      event('response.function_call_arguments.delta', { ...ref, delta: item.arguments });
      event('response.function_call_arguments.done', { ...ref, arguments: item.arguments });
    } else {
      event('response.custom_tool_call_input.delta', { ...ref, delta: item.input });
      event('response.custom_tool_call_input.done', { ...ref, input: item.input });
    }
    event('response.output_item.done', { output_index, item });
  });
  event('response.completed', { response: result });
  return lines.join('');
}
