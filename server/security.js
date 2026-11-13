import { createHash, randomBytes } from 'node:crypto';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createApiKey() {
  const token = `umo-sk-${randomBytes(24).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: `${token.slice(0, 11)}••••` };
}

export function createAgentToken() {
  const token = `umo-agent-${randomBytes(24).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: `${token.slice(0, 14)}••••` };
}

export function bearerToken(header = '') {
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function verifySameOrigin(request) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    throw Object.assign(new Error('拒绝跨站请求'), { statusCode: 403 });
  }
  const origin = request.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { throw Object.assign(new Error('请求来源无效'), { statusCode: 403 }); }
    if (host !== request.headers.host) throw Object.assign(new Error('请求来源与站点不一致'), { statusCode: 403 });
  }
}

export function consumeRateLimit(windows, key, limit, windowMs) {
  const now = Date.now();
  const recent = (windows.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) {
    windows.set(key, recent);
    return false;
  }
  recent.push(now);
  windows.set(key, recent);
  return true;
}

export function sessionExpired(session, idleMs = 86400000) {
  return !session || session.expires < Date.now() || Date.now() - session.lastSeen > idleMs;
}

export function touchSession(session) {
  if (Date.now() - session.lastSeen > 300000) session.lastSeen = Date.now();
}

export function publicProvider(row, online = false) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    token_prefix: row.token_prefix,
    provider_type: row.provider_type || 'tunnel',
    base_url: row.base_url || '',
    api_key_prefix: row.api_key_prefix || '',
    client_mode: row.client_mode || 'regex',
    client_pattern: row.client_pattern || '',
    client_error_field: row.client_error_field || 'message',
    client_error_message: row.client_error_message || '',
    client_error_code: row.client_error_code || '',
    max_concurrency: row.max_concurrency,
    enabled: Boolean(row.enabled),
    online,
    healthy: online && Boolean(row.healthy),
    health_message: row.health_message || '',
    last_seen_at: row.last_seen_at,
    last_latency_ms: row.last_latency_ms,
    created_at: row.created_at,
  };
}
