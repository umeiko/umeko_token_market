import { Readable } from 'node:stream';

export function withAdminContact(message) {
  const text = String(message || '上游服务异常').trim();
  if (text.includes('请联系管理员')) return text;
  return `${text}${/[。！？.!?]$/.test(text) ? '' : '。'}请联系管理员`;
}

function errorPayload(data, status) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: { message: withAdminContact(`上游返回 HTTP ${status}`), type: 'api_error' } };
  }
  if (data.error && typeof data.error === 'object' && !Array.isArray(data.error)) {
    data.error.message = withAdminContact(data.error.message || `上游返回 HTTP ${status}`);
  } else if (typeof data.error === 'string') {
    data.error = { message: withAdminContact(data.error), type: 'api_error' };
  } else if (data.message) {
    data.message = withAdminContact(data.message);
  } else {
    data.error = { message: withAdminContact(`上游返回 HTTP ${status}`), type: 'api_error' };
  }
  return data;
}

export async function upstreamErrorStream(stream, isStream, status) {
  let text = '';
  for await (const chunk of stream) {
    text += chunk.toString();
    if (text.length > 2 * 1024 * 1024) {
      return Readable.from([JSON.stringify(errorPayload(null, status))]);
    }
  }
  if (!isStream) {
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return Readable.from([JSON.stringify(errorPayload(data, status))]);
  }
  const output = text.split(/(\r?\n)/).map((line) => {
    if (!line.startsWith('data:') || line.trim() === 'data: [DONE]') return line;
    try {
      const data = JSON.parse(line.slice(5).trim());
      return `data: ${JSON.stringify(errorPayload(data, status))}`;
    } catch { return line; }
  }).join('');
  return Readable.from([output]);
}
