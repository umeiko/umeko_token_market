import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

mkdirSync('data', { recursive: true });
const directory = mkdtempSync('data/log-retention-');
process.env.DATA_PATH = `${directory}/market.db`;
process.env.ADMIN_PASSWORD = 'verification-password';
const { db, ensureAdmin } = await import('../server/db.js');
const { Gateway } = await import('../server/gateway.js');
const { adminRoutes } = await import('../server/admin.js');
ensureAdmin();

test('visible logs are capped at 300 with details intact and statistics preserved', async (t) => {
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const insert = db.prepare(`INSERT INTO usage_logs(request_id, model, total_tokens, status, category, ip, ip_region, headers_json, error, created_at)
    VALUES (?, 'fixture', 1, 200, 'success', '127.0.0.1', '本地地址', ?, ?, datetime('now', '-6 hours'))`);
  for (let id = 1; id <= 305; id++) insert.run(`request-${id}`, JSON.stringify({ authorization: '[redacted]', 'x-row': String(id) }), `error-${id}`);
  const gateway = new Gateway({ providers: new Map(), activeCount: () => 0 }, () => ({}));
  t.after(() => clearInterval(gateway.usageCleanup));

  assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_logs WHERE visible = 1').get().count, 300);
  assert.equal(db.prepare('SELECT MIN(id) id FROM usage_logs WHERE visible = 1').get().id, 6);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_logs WHERE visible = 0').get().count, 5);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM usage_logs WHERE visible = 0 AND (ip <> '' OR ip_region <> '' OR headers_json <> '{}' OR error <> '')").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM usage_logs WHERE visible = 1 AND (ip = '' OR headers_json = '{}' OR error = '')").get().count, 0);
  assert.equal(db.prepare('SELECT SUM(total_tokens) tokens FROM usage_logs').get().tokens, 305);

  gateway.record({
    requestId: 'request-306', key: { id: null }, model: { provider_id: null, name: 'fixture', input_price: 0, output_price: 0 },
    usage: { total_tokens: 1 }, status: 200, latency: 1, category: 'success',
    request: { ip: '127.0.0.1', headers: { 'user-agent': 'retention-test', authorization: 'Bearer test' } },
  });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_logs WHERE visible = 1').get().count, 300);
  assert.equal(db.prepare('SELECT MIN(id) id FROM usage_logs WHERE visible = 1').get().id, 7);
  assert.equal(db.prepare('SELECT SUM(total_tokens) tokens FROM usage_logs').get().tokens, 306);
  assert.equal(db.prepare("SELECT ip FROM usage_logs WHERE request_id = 'request-306'").get().ip, '127.0.0.1');

  const app = Fastify();
  await app.register(cookie);
  await app.register(adminRoutes, { tunnel: { providers: new Map() }, gateway });
  t.after(() => app.close());
  const login = await app.inject({
    method: 'POST', url: '/api/admin/login',
    headers: { host: 'example.test', origin: 'http://example.test', 'content-type': 'application/json' },
    payload: { username: 'admin', password: 'verification-password' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const session = login.headers['set-cookie'].split(';')[0];
  const response = await app.inject({ method: 'GET', url: '/api/admin/usage', headers: { cookie: session } });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.total, 300);
  assert.equal(result.pages, 10);
  assert.equal(result.logs.length, 30);
  assert.equal(result.logs[0].request_id, 'request-306');
  assert.equal(result.logs[0].headers['user-agent'], 'retention-test');
  assert.equal(result.logs[0].headers.authorization, '[redacted]');
  t.after(() => db.close());
});
