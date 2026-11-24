import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { createAgentToken, hashToken, isTunnelProvider } from './security.js';

const TTL = 10 * 60 * 1000;

db.exec(`CREATE TABLE IF NOT EXISTS provider_pairing (
  provider_id INTEGER PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`);

export function issueProviderPairing(providerId) {
  const code = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TTL;
  db.prepare(`INSERT INTO provider_pairing (provider_id, code_hash, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at`)
    .run(providerId, hashToken(code), expiresAt);
  return { id: providerId, code, expires_at: expiresAt };
}

export function clearProviderPairing(providerId) {
  db.prepare('DELETE FROM provider_pairing WHERE provider_id = ?').run(providerId);
}

export async function pairingRoutes(app, { tunnel }) {
  app.post('/agent/pair', { bodyLimit: 1024 }, async (request, reply) => {
    const { id, code, service } = request.body || {};
    reply.header('Cache-Control', 'no-store');
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647 ||
      typeof code !== 'string' || !/^[\w-]{32}$/.test(code) || !['api', 'video'].includes(service)) {
      return reply.code(400).send({ error: '配对链接格式无效' });
    }
    const provider = db.prepare(`SELECT p.id, p.name, p.provider_type FROM providers p
      JOIN provider_pairing c ON c.provider_id=p.id
      WHERE p.id=? AND p.enabled=1 AND c.code_hash=? AND c.expires_at>?`)
      .get(id, hashToken(code), Date.now());
    if (!provider || !isTunnelProvider(provider.provider_type) ||
      service !== (provider.provider_type === 'video_tunnel' ? 'video' : 'api')) {
      return reply.code(401).send({ error: '配对链接已失效、已使用或与供应商类型不符，请从云端重新生成' });
    }
    if (tunnel.activeCount(id)) return reply.code(409).send({ error: '供应商正在处理请求，请稍后配对' });
    const credentials = createAgentToken();
    db.exec('BEGIN IMMEDIATE');
    try {
      clearProviderPairing(id);
      db.prepare('UPDATE providers SET token_hash=?, token_prefix=? WHERE id=?')
        .run(credentials.hash, credentials.prefix, id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    tunnel.providers.get(id)?.socket.close(1008, 'Connector paired');
    return { id, service, token: credentials.token };
  });
}
