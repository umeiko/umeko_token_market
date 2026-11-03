import { Readable } from 'node:stream';

const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });

function textOnly(content, field) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type !== 'text') throw invalid(`${field} 当前仅支持 text 内容块`);
    return block.text || '';
  }).join('\n');
}

function messageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block?.type === 'text') return { type: 'text', text: block.text || '' };
    if (block?.type === 'image' && block.source?.type === 'base64') {
      return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
    }
    throw invalid('暂支持 text 与 base64 image 内容块，其他内容块请使用 OpenAI 兼容接口');
  });
}

export function anthropicToOpenAI(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('请求体必须为 JSON 对象');
  if (!body.model) throw invalid('请求中缺少 model');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0) throw invalid('max_tokens 必须是正整数');
  if (!Array.isArray(body.messages) || !body.messages.length) throw invalid('messages 必须是非空数组');
  if (body.tools || body.tool_choice) throw invalid('Anthropic 工具调用暂未支持，请使用 OpenAI 兼容接口');
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: textOnly(body.system, 'system') });
  for (const message of body.messages) {
    if (!['user', 'assistant'].includes(message.role)) throw invalid('messages.role 仅支持 user 或 assistant');
    messages.push({ role: message.role, content: messageContent(message.content) });
  }
  const result = { model: body.model, messages, max_tokens: body.max_tokens, stream: Boolean(body.stream) };
  for (const key of ['temperature', 'top_p']) if (body[key] !== undefined) result[key] = body[key];
  if (body.stop_sequences?.length) result.stop = body.stop_sequences;
  return result;
}

const stopReason = (reason) => ({ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' }[reason] || 'end_turn');
const messageId = (requestId) => `msg_${String(requestId).replace(/[^a-zA-Z0-9]/g, '')}`;
const responseText = (choice) => {
  const content = choice?.message?.content ?? choice?.text ?? '';
  return Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text).join('') : content;
};

function errorBody(error, status) {
  const type = status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : 'api_error';
  return { type: 'error', error: { type, message: error.message || '中转服务内部错误' } };
}

export function sendAnthropicError(reply, error) {
  const status = error.statusCode || 500;
  return reply.code(status).send(errorBody(error, status));
}

export function anthropicResponseStream(upstream, { isStream, status, model, requestId }) {
  const output = new Readable({ read() {} });
  if (!isStream) {
    let plain = '';
    upstream.on('data', (chunk) => { plain += chunk.toString(); });
    upstream.on('end', () => {
      try {
        const data = JSON.parse(plain || '{}');
        if (status < 200 || status >= 400) {
          output.push(JSON.stringify(errorBody(new Error(data.error?.message || `上游返回 HTTP ${status}`), status)));
        } else {
          const choice = data.choices?.[0];
          output.push(JSON.stringify({
            id: data.id || messageId(requestId), type: 'message', role: 'assistant',
            model: data.model || model, content: [{ type: 'text', text: responseText(choice) }],
            stop_reason: stopReason(choice?.finish_reason), stop_sequence: null,
            usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
          }));
        }
      } catch {
        output.push(JSON.stringify(errorBody(new Error('上游响应不是有效 JSON'), 502)));
      }
      output.push(null);
    });
    upstream.on('error', (error) => output.destroy(error));
    return output;
  }

  let buffer = '';
  let started = false;
  let blockOpen = false;
  let stopped = false;
  let finalReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;
  const emit = (event, data) => output.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const start = () => {
    if (started) return;
    started = true;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId(requestId), type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const startBlock = () => {
    if (blockOpen) return;
    start();
    blockOpen = true;
    emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  };
  const closeBlock = () => {
    if (!blockOpen) return;
    blockOpen = false;
    emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  };
  const finish = () => {
    if (stopped) return;
    stopped = true;
    start();
    closeBlock();
    emit('message_delta', {
      type: 'message_delta', delta: { stop_reason: finalReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    emit('message_stop', { type: 'message_stop' });
    output.push(null);
  };
  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { finish(); return; }
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    if (data.usage) {
      inputTokens = data.usage.prompt_tokens || inputTokens;
      outputTokens = data.usage.completion_tokens || outputTokens;
    }
    for (const choice of data.choices || []) {
      const text = choice.delta?.content || choice.text || '';
      if (text) {
        startBlock();
        emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      }
      if (choice.finish_reason) finalReason = stopReason(choice.finish_reason);
    }
  };
  upstream.on('data', (chunk) => {
    if (stopped) return;
    const lines = (buffer + chunk.toString()).split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach(consume);
  });
  upstream.on('end', () => {
    if (buffer) consume(buffer);
    finish();
  });
  upstream.on('error', (error) => output.destroy(error));
  return output;
}
