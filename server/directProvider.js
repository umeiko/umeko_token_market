import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { decryptProviderKey } from './providerCrypto.js';

const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
const finishReason = (reason) => ({ end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls' }[reason] || 'stop');

function upstreamUrl(baseUrl, path) {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}${base.endsWith('/v1') ? path.slice(3) : path}`;
}

function contentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type === 'text') return { type: 'text', text: block.text || '' };
    if (block?.type === 'image_url') {
      const url = block.image_url?.url || '';
      const match = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (!match) throw invalid('Anthropic 图片当前仅支持 base64 data URL');
      return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    }
    throw invalid('Anthropic 当前仅支持 text 与 image_url 内容块');
  });
}

function openAIToAnthropic(body) {
  if (body.tools || body.tool_choice) throw invalid('Anthropic 直连暂不支持工具调用');
  const system = [];
  const messages = [];
  for (const message of body.messages || []) {
    if (message.role === 'system') system.push(...(Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text) : [String(message.content || '')]));
    else if (['user', 'assistant'].includes(message.role)) messages.push({ role: message.role, content: contentToAnthropic(message.content) });
  }
  const result = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens || body.max_completion_tokens || 1024,
    stream: Boolean(body.stream),
  };
  if (system.length) result.system = system.join('\n');
  for (const key of ['temperature', 'top_p']) if (body[key] !== undefined) result[key] = body[key];
  const stop = body.stop && (Array.isArray(body.stop) ? body.stop : [body.stop]);
  if (stop?.length) result.stop_sequences = stop;
  return result;
}

function anthropicResponse(data, requestId) {
  const text = (data.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
  return {
    id: data.id || `chatcmpl-${requestId}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: data.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason(data.stop_reason) }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

function anthropicStream(stream, requestId) {
  const output = new Readable({ read() {} });
  let buffer = '';
  let promptTokens = 0;
  let completionTokens = 0;
  const emit = (data) => output.push(`data: ${JSON.stringify(data)}\n\n`);
  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    let data;
    try { data = JSON.parse(line.slice(5).trim()); } catch { return; }
    if (data.type === 'message_start') {
      promptTokens = data.message?.usage?.input_tokens || 0;
      emit({ id: data.message?.id || `chatcmpl-${requestId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: data.message?.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    } else if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      emit({ id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }] });
    } else if (data.type === 'message_delta') {
      completionTokens = data.usage?.output_tokens || completionTokens;
      emit({ id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta: {}, finish_reason: finishReason(data.delta?.stop_reason) }] });
    }
  };
  stream.on('data', (chunk) => {
    const lines = (buffer + chunk.toString()).split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach(consume);
  });
  stream.on('end', () => {
    if (buffer) consume(buffer);
    emit({ id: `chatcmpl-${requestId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
    output.push('data: [DONE]\n\n');
    output.push(null);
  });
  stream.on('error', (error) => output.destroy(error));
  return output;
}

export async function forwardDirectProvider(provider, { path, body, timeoutMs, signal }) {
  const requestId = randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const anthropic = provider.provider_type === 'anthropic';
  const normalizedPath = path.startsWith('/v1/') ? path : `/v1/${path}`;
  if (anthropic && normalizedPath !== '/v1/chat/completions') throw invalid('Anthropic 直连当前仅支持聊天接口');
  const source = JSON.parse(body);
  const targetBody = anthropic ? openAIToAnthropic(source) : source;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (anthropic) {
    headers['x-api-key'] = decryptProviderKey(provider);
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${decryptProviderKey(provider)}`;
  }
  const targetPath = anthropic ? '/v1/messages' : normalizedPath;
  let response;
  try {
    response = await fetch(upstreamUrl(provider.base_url, targetPath), {
      method: 'POST', headers, body: JSON.stringify(targetBody), signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    throw Object.assign(new Error(`云端供应商请求失败：${error.message}`), { statusCode: 502 });
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)) responseHeaders[key] = value;
  });
  if (!anthropic) return { requestId, status: response.status, headers: responseHeaders, stream: Readable.fromWeb(response.body) };
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return {
      requestId, status: response.status, headers: { 'content-type': 'application/json' },
      stream: Readable.from([JSON.stringify({ error: { message: data.error?.message || `Anthropic 返回 HTTP ${response.status}`, type: 'api_error' } })]),
    };
  }
  if (targetBody.stream) return { requestId, status: response.status, headers: { 'content-type': 'text/event-stream' }, stream: anthropicStream(Readable.fromWeb(response.body), requestId) };
  const data = await response.json();
  return { requestId, status: response.status, headers: { 'content-type': 'application/json' }, stream: Readable.from([JSON.stringify(anthropicResponse(data, requestId))]) };
}
