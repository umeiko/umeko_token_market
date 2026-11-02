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

export function publicProvider(row, online = false) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    token_prefix: row.token_prefix,
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
