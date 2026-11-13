import { randomBytes } from 'node:crypto';
import { changePassword, db, getSettings, getUserUsage, setSetting, verifyAdmin } from './db.js';
import { createAgentToken, createApiKey, publicProvider, sessionExpired, touchSession, verifySameOrigin } from './security.js';
import { encryptProviderKey } from './providerCrypto.js';
import { parsePublicKey, verifySshSignature } from './sshAuth.js';

const sessions = new Map();
const loginAttempts = new Map();
const sshChallenges = new Map();
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const number = (value, fallback = 0) => value === '' || value === undefined ? fallback : Number(value);
const bool = (value) => value ? 1 : 0;

function keyView(row, gateway) {
  return {
    ...row,
    key_hash: undefined,
    enabled: Boolean(row.enabled),
    allow_user_apply: Boolean(row.allow_user_apply),
    active: gateway.activeForKey(row.id),
    used_cost: row.used_cost_micros / 1e6,
    budget_quota: row.budget_quota_micros / 1e6,
  };
}

export async function adminRoutes(app, { tunnel, gateway }) {
  app.setErrorHandler((cause, request, reply) => {
    request.log.error({ err: cause }, 'Admin API request failed');
    if (reply.sent) return;
    const status = cause.statusCode || 500;
    reply.code(status).send({ error: status === 500 ? '管理服务内部错误' : cause.message });
  });
  app.addHook('onRequest', async (request) => {
    if (['POST', 'PATCH', 'DELETE'].includes(request.method)) verifySameOrigin(request);
  });

  async function requireAdmin(request, reply) {
    const token = request.cookies.umeko_session;
    const session = token && sessions.get(token);
    if (sessionExpired(session)) {
      if (token) sessions.delete(token);
      return reply.code(401).send({ error: '登录已失效，请重新登录' });
    }
    touchSession(session);
    request.admin = session;
  }

  app.post('/api/admin/login', async (request, reply) => {
    const ip = request.ip;
    const attempts = (loginAttempts.get(ip) || []).filter((time) => Date.now() - time < 600000);
    if (attempts.length >= 10) return reply.code(429).send({ error: '登录尝试过多，请十分钟后再试' });
    const { username = '', password = '' } = request.body || {};
    const user = verifyAdmin(username, password);
    if (!user) {
      attempts.push(Date.now());
      loginAttempts.set(ip, attempts);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { ...user, expires: Date.now() + SESSION_AGE, lastSeen: Date.now() });
    reply.setCookie('umeko_session', token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: SESSION_AGE / 1000,
    });
    return { user };
  });

  app.post('/api/admin/ssh/challenge', async (request, reply) => {
    let key;
    try { key = parsePublicKey(request.body?.publicKey); } catch { return reply.code(401).send({ error: '公钥未授权或格式无效' }); }
    const authorized = db.prepare('SELECT * FROM admin_authorized_keys WHERE public_key = ? AND enabled = 1').get(key.publicKey);
    if (!authorized) return reply.code(401).send({ error: '公钥未授权或格式无效' });
    const id = randomBytes(18).toString('base64url');
    const challenge = randomBytes(32).toString('base64url');
    sshChallenges.set(id, { ...authorized, publicKey: key.publicKey, challenge, expires: Date.now() + 300000 });
    return { id, challenge, namespace: 'umeko-admin' };
  });

  app.post('/api/admin/ssh/login', async (request, reply) => {
    const { id, publicKey, signature } = request.body || {};
    const challenge = id && sshChallenges.get(id);
    if (!challenge || challenge.expires < Date.now() || challenge.publicKey !== publicKey) return reply.code(401).send({ error: '签名挑战已失效，请重新获取' });
    sshChallenges.delete(id);
    try {
      if (!verifySshSignature({ publicKey, challenge: challenge.challenge, signature })) return reply.code(401).send({ error: 'SSH 签名验证失败' });
    } catch (cause) { return reply.code(401).send({ error: cause.message }); }
    db.prepare("UPDATE admin_authorized_keys SET last_used_at = datetime('now') WHERE id = ?").run(challenge.id);
    const user = db.prepare('SELECT id, username FROM admin_users WHERE id = ?').get(challenge.admin_id);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { ...user, expires: Date.now() + SESSION_AGE, lastSeen: Date.now() });
    reply.setCookie('umeko_session', token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: SESSION_AGE / 1000,
    });
    return { user, method: 'ssh' };
  });

  app.get('/api/admin/ssh-keys', { preHandler: requireAdmin }, async (request) => ({
    keys: db.prepare('SELECT id, name, public_key, fingerprint, enabled, last_used_at, created_at FROM admin_authorized_keys WHERE admin_id = ? ORDER BY id DESC').all(request.admin.id)
      .map((key) => ({ ...key, enabled: Boolean(key.enabled) })),
  }));

  app.post('/api/admin/ssh-keys', { preHandler: requireAdmin }, async (request) => {
    const name = String(request.body?.name || '管理员 SSH Key').trim().slice(0, 60);
    let key;
    try { key = parsePublicKey(request.body?.publicKey); } catch (cause) { throw badRequest(cause.message); }
    try {
      const result = db.prepare('INSERT INTO admin_authorized_keys(admin_id, name, public_key, fingerprint) VALUES (?, ?, ?, ?)')
        .run(request.admin.id, name || '管理员 SSH Key', key.publicKey, key.fingerprint);
      return { id: Number(result.lastInsertRowid), fingerprint: key.fingerprint };
    } catch { throw badRequest('该公钥已添加'); }
  });

  app.delete('/api/admin/ssh-keys/:id', { preHandler: requireAdmin }, async (request) => {
    db.prepare('DELETE FROM admin_authorized_keys WHERE id = ? AND admin_id = ?').run(request.params.id, request.admin.id);
    return { ok: true };
  });

  app.post('/api/admin/logout', async (request, reply) => {
    const token = request.cookies.umeko_session;
    if (token) sessions.delete(token);
    reply.clearCookie('umeko_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/admin/me', { preHandler: requireAdmin }, async (request) => ({ user: { id: request.admin.id, username: request.admin.username } }));

  app.get('/api/admin/overview', { preHandler: requireAdmin }, async () => {
    const today = db.prepare(`SELECT COUNT(*) requests, COALESCE(SUM(total_tokens), 0) tokens,
      COALESCE(SUM(cost_micros), 0) cost_micros,
      COALESCE(SUM(CASE WHEN status BETWEEN 200 AND 399 THEN 1 ELSE 0 END), 0) successful
      FROM usage_logs WHERE date(created_at) = date('now')`).get();
    const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM api_keys WHERE enabled = 1) active_keys,
      (SELECT COUNT(*) FROM providers WHERE enabled = 1) providers,
      (SELECT COALESCE(SUM(total_tokens), 0) FROM usage_logs) tokens,
      (SELECT COALESCE(SUM(cost_micros), 0) FROM usage_logs) cost_micros`).get();
    const rows = db.prepare(`SELECT date(created_at) day, COUNT(*) requests, SUM(total_tokens) tokens,
      SUM(cost_micros) cost_micros FROM usage_logs
      WHERE created_at >= datetime('now', '-13 days', 'start of day') GROUP BY date(created_at)`).all();
    const byDay = new Map(rows.map((row) => [row.day, row]));
    const series = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      series.push(byDay.get(day) || { day, requests: 0, tokens: 0, cost_micros: 0 });
    }
    const recent = db.prepare(`SELECT l.*, k.name key_name, p.name provider_name FROM usage_logs l
      LEFT JOIN api_keys k ON k.id = l.key_id LEFT JOIN providers p ON p.id = l.provider_id
      ORDER BY l.id DESC LIMIT 8`).all();
    return { today: { ...today, cost: today.cost_micros / 1e6 }, totals: { ...totals, cost: totals.cost_micros / 1e6, online: tunnel.providers.size }, series, recent };
  });

  function validateClientConfig(body) {
    if (!['regex', 'template'].includes(body.client_mode || 'regex')) throw badRequest('客户端匹配模式无效');
    if (body.client_mode !== 'template' && body.client_pattern) {
      try { new RegExp(body.client_pattern); } catch { throw badRequest('客户端正则表达式无效'); }
    }
    if (body.client_error_field && !/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(body.client_error_field)) throw badRequest('自定义错误字段仅支持字母、数字和下划线');
  }

  app.get('/api/admin/providers', { preHandler: requireAdmin }, async () => {
    const providers = db.prepare('SELECT * FROM providers ORDER BY id DESC').all().map((row) => ({
      ...publicProvider(row, row.provider_type !== 'tunnel' ? Boolean(row.base_url) : tunnel.isOnline(row.id)),
      active: gateway.providerActive(row.id),
      models: db.prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY id').all(row.id).map((model) => ({ ...model, enabled: Boolean(model.enabled) })),
    }));
    return { providers };
  });

  app.post('/api/admin/providers', { preHandler: requireAdmin }, async (request) => {
    const body = request.body || {};
    const { name, description = '', max_concurrency = 4, models = [], provider_type = 'tunnel' } = body;
    if (!name?.trim()) throw badRequest('请填写供应商名称');
    if (!['tunnel', 'openai', 'anthropic'].includes(provider_type)) throw badRequest('供应商类型无效');
    if (!models.length || models.some((model) => !model.name?.trim())) throw badRequest('请至少添加一个模型名称');
    validateClientConfig(body);
    if (provider_type !== 'tunnel') {
      if (!body.base_url || !/^https?:\/\//.test(body.base_url)) throw badRequest('云端供应商需要有效的 Base URL');
      if (!body.api_key) throw badRequest('云端供应商需要 API Key');
    }
    const credentials = createAgentToken();
    const encrypted = provider_type === 'tunnel' ? encryptProviderKey('') : encryptProviderKey(body.api_key);
    const result = db.prepare(`INSERT INTO providers
      (name, description, token_hash, token_prefix, max_concurrency, provider_type, base_url,
       api_key_ciphertext, api_key_iv, api_key_tag, api_key_prefix,
       client_mode, client_pattern, client_error_field, client_error_message, client_error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name.trim(), description, credentials.hash, credentials.prefix, Math.max(0, number(max_concurrency, 4)),
        provider_type, body.base_url || '', encrypted.api_key_ciphertext, encrypted.api_key_iv, encrypted.api_key_tag, encrypted.api_key_prefix,
        body.client_mode || 'regex', body.client_pattern || '', body.client_error_field || 'message', body.client_error_message || '', body.client_error_code || '');
    const providerId = Number(result.lastInsertRowid);
    const insert = db.prepare('INSERT INTO models(provider_id, name, upstream_name, input_price, output_price) VALUES (?, ?, ?, ?, ?)');
    for (const model of models) insert.run(providerId, model.name.trim(), model.upstream_name?.trim() || model.name.trim(), Math.max(0, number(model.input_price)), Math.max(0, number(model.output_price)));
    return { id: providerId, token: provider_type === 'tunnel' ? credentials.token : null };
  });

  app.patch('/api/admin/providers/:id', { preHandler: requireAdmin }, async (request) => {
    const body = request.body || {};
    const current = db.prepare('SELECT * FROM providers WHERE id = ?').get(request.params.id);
    if (!current) return { ok: false };
    validateClientConfig({ ...current, ...body });
    const encrypted = body.api_key ? encryptProviderKey(body.api_key) : {
      api_key_ciphertext: current.api_key_ciphertext, api_key_iv: current.api_key_iv,
      api_key_tag: current.api_key_tag, api_key_prefix: current.api_key_prefix,
    };
    db.prepare(`UPDATE providers SET name = ?, description = ?, max_concurrency = ?, enabled = ?, base_url = ?,
      api_key_ciphertext = ?, api_key_iv = ?, api_key_tag = ?, api_key_prefix = ?,
      client_mode = ?, client_pattern = ?, client_error_field = ?, client_error_message = ?, client_error_code = ? WHERE id = ?`).run(
      body.name?.trim() || current.name, body.description ?? current.description,
      Math.max(0, number(body.max_concurrency, current.max_concurrency)),
      body.enabled === undefined ? current.enabled : bool(body.enabled), body.base_url ?? current.base_url,
      encrypted.api_key_ciphertext, encrypted.api_key_iv, encrypted.api_key_tag, encrypted.api_key_prefix,
      body.client_mode ?? current.client_mode, body.client_pattern ?? current.client_pattern,
      body.client_error_field ?? current.client_error_field, body.client_error_message ?? current.client_error_message,
      body.client_error_code ?? current.client_error_code, current.id,
    );
    if (body.enabled === false && tunnel.providers.get(current.id)) tunnel.providers.get(current.id).socket.close(1008, 'Provider disabled');
    return { ok: true };
  });

  app.post('/api/admin/providers/:id/rotate', { preHandler: requireAdmin }, async (request) => {
    const current = db.prepare('SELECT id, provider_type FROM providers WHERE id = ?').get(request.params.id);
    if (!current) throw badRequest('供应商不存在');
    if (current.provider_type !== 'tunnel') throw badRequest('云端供应商请直接更新 API Key');
    const credentials = createAgentToken();
    db.prepare('UPDATE providers SET token_hash = ?, token_prefix = ? WHERE id = ?').run(credentials.hash, credentials.prefix, current.id);
    tunnel.providers.get(current.id)?.socket.close(1008, 'Credentials rotated');
    return { token: credentials.token };
  });

  app.post('/api/admin/providers/:id/models', { preHandler: requireAdmin }, async (request) => {
    const { name, upstream_name, input_price = 0, output_price = 0 } = request.body || {};
    if (!name?.trim()) throw badRequest('请填写模型名称');
    try {
      const result = db.prepare('INSERT INTO models(provider_id, name, upstream_name, input_price, output_price) VALUES (?, ?, ?, ?, ?)')
        .run(request.params.id, name.trim(), upstream_name?.trim() || name.trim(), Math.max(0, number(input_price)), Math.max(0, number(output_price)));
      return { id: Number(result.lastInsertRowid) };
    } catch { throw badRequest('该供应商下已存在同名模型'); }
  });

  app.patch('/api/admin/models/:id', { preHandler: requireAdmin }, async (request) => {
    const current = db.prepare('SELECT * FROM models WHERE id = ?').get(request.params.id);
    if (!current) throw badRequest('模型不存在');
    const { name, upstream_name, input_price, output_price, enabled } = request.body || {};
    db.prepare('UPDATE models SET name = ?, upstream_name = ?, input_price = ?, output_price = ?, enabled = ? WHERE id = ?').run(
      name?.trim() || current.name, upstream_name === undefined ? current.upstream_name : upstream_name.trim() || current.name,
      Math.max(0, number(input_price, current.input_price)),
      Math.max(0, number(output_price, current.output_price)), enabled === undefined ? current.enabled : bool(enabled), current.id,
    );
    return { ok: true };
  });

  app.delete('/api/admin/models/:id', { preHandler: requireAdmin }, async (request) => {
    db.prepare('DELETE FROM models WHERE id = ?').run(request.params.id);
    return { ok: true };
  });

  app.get('/api/admin/keys', { preHandler: requireAdmin }, async () => ({
    keys: db.prepare('SELECT * FROM api_keys ORDER BY id DESC').all().map((row) => keyView(row, gateway)),
  }));

  app.post('/api/admin/keys', { preHandler: requireAdmin }, async (request) => {
    const body = request.body || {};
    if (!body.name?.trim()) throw badRequest('请填写 Key 名称');
    const credentials = createApiKey();
    const result = db.prepare(`INSERT INTO api_keys
      (name, key_hash, key_prefix, token_quota, budget_quota_micros, quota_5h, quota_week,
       allow_user_apply, rpm_limit, concurrency_limit, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(body.name.trim(), credentials.hash, credentials.prefix, Math.max(0, number(body.token_quota)),
        Math.round(Math.max(0, number(body.budget_quota)) * 1e6),
        Math.max(0, Math.floor(number(body.quota_5h))), Math.max(0, Math.floor(number(body.quota_week))),
        bool(body.allow_user_apply), Math.max(0, number(body.rpm_limit, 60)),
        Math.max(0, number(body.concurrency_limit, 2)), body.expires_at || null);
    return { id: Number(result.lastInsertRowid), key: credentials.token };
  });

  app.patch('/api/admin/keys/:id', { preHandler: requireAdmin }, async (request) => {
    const current = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(request.params.id);
    if (!current) throw badRequest('Key 不存在');
    const body = request.body || {};
    if (body.reset_usage) {
      db.prepare("UPDATE api_keys SET used_tokens = 0, used_cost_micros = 0, quota_reset_5h_at = datetime('now'), quota_reset_week_at = datetime('now') WHERE id = ?").run(current.id);
    }
    db.prepare(`UPDATE api_keys SET name = ?, token_quota = ?, budget_quota_micros = ?, quota_5h = ?, quota_week = ?,
      allow_user_apply = ?, rpm_limit = ?, concurrency_limit = ?, enabled = ?, expires_at = ? WHERE id = ?`).run(
      body.name?.trim() || current.name, Math.max(0, number(body.token_quota, current.token_quota)),
      Math.round(Math.max(0, number(body.budget_quota, current.budget_quota_micros / 1e6)) * 1e6),
      Math.max(0, Math.floor(number(body.quota_5h, current.quota_5h))), Math.max(0, Math.floor(number(body.quota_week, current.quota_week))),
      body.allow_user_apply === undefined ? current.allow_user_apply : bool(body.allow_user_apply),
      Math.max(0, number(body.rpm_limit, current.rpm_limit)), Math.max(0, number(body.concurrency_limit, current.concurrency_limit)),
      body.enabled === undefined ? current.enabled : bool(body.enabled), body.expires_at === undefined ? current.expires_at : body.expires_at || null, current.id,
    );
    return { ok: true };
  });

  app.get('/api/admin/usage', { preHandler: requireAdmin }, async (request) => {
    const page = Math.max(1, number(request.query.page, 1));
    const limit = 30;
    const conditions = [];
    const params = [];
    if (request.query.key_id) { conditions.push('l.key_id = ?'); params.push(Number(request.query.key_id)); }
    if (request.query.provider_id) { conditions.push('l.provider_id = ?'); params.push(Number(request.query.provider_id)); }
    if (request.query.status === 'success') conditions.push('l.status BETWEEN 200 AND 399');
    if (request.query.status === 'error') conditions.push('l.status NOT BETWEEN 200 AND 399');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) count FROM usage_logs l ${where}`).get(...params).count;
    const logs = db.prepare(`SELECT l.*, k.name key_name, k.key_prefix, p.name provider_name FROM usage_logs l
      LEFT JOIN api_keys k ON k.id = l.key_id LEFT JOIN providers p ON p.id = l.provider_id
      ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
    return { logs, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
  });

  app.get('/api/admin/users', { preHandler: requireAdmin }, async (request) => {
    const search = String(request.query.search || '').trim().toLowerCase().slice(0, 100);
    const params = [];
    let where = '';
    if (/^\d+$/.test(search)) {
      where = 'WHERE id = ?';
      params.push(Number(search));
    } else if (search) {
      where = "WHERE email LIKE ? ESCAPE '\\'";
      params.push(`${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
    }
    const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) key_count
      FROM users u ${where} ORDER BY u.id DESC LIMIT 50`).all(...params).map((user) => ({
      id: user.id,
      email: user.email,
      enabled: Boolean(user.enabled),
      created_at: user.created_at,
      last_login_at: user.last_login_at,
      key_count: user.key_count,
      usage: getUserUsage(user.id),
    }));
    return { users };
  });

  app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async (request) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
    if (!user) throw badRequest('用户不存在');
    const body = request.body || {};
    const quota5h = Math.min(1e12, Math.max(0, Math.floor(number(body.token_quota_5h, user.token_quota_5h))));
    const quotaWeek = Math.min(1e12, Math.max(0, Math.floor(number(body.token_quota_week, user.token_quota_week))));
    db.prepare('UPDATE users SET token_quota_5h = ?, token_quota_week = ?, enabled = ? WHERE id = ?')
      .run(quota5h, quotaWeek, body.enabled === undefined ? user.enabled : bool(body.enabled), user.id);
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset', { preHandler: requireAdmin }, async (request) => {
    const scope = request.body?.scope || 'all';
    if (!['five_hours', 'week', 'all'].includes(scope)) throw badRequest('无效的重置范围');
    const assignments = [];
    if (scope === 'five_hours' || scope === 'all') assignments.push("quota_reset_5h_at = datetime('now')");
    if (scope === 'week' || scope === 'all') assignments.push("quota_reset_week_at = datetime('now')");
    const result = db.prepare(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`).run(request.params.id);
    if (!result.changes) throw badRequest('用户不存在');
    return { ok: true };
  });

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => ({ settings: getSettings() }));
  app.patch('/api/admin/settings', { preHandler: requireAdmin }, async (request) => {
    const { site_name, request_timeout_ms } = request.body || {};
    if (site_name?.trim()) setSetting('site_name', site_name.trim().slice(0, 60));
    if (request_timeout_ms !== undefined) setSetting('request_timeout_ms', Math.min(1800000, Math.max(5000, number(request_timeout_ms, 300000))));
    return { settings: getSettings() };
  });
  app.post('/api/admin/password', { preHandler: requireAdmin }, async (request) => {
    const { current_password, new_password } = request.body || {};
    if (!verifyAdmin(request.admin.username, current_password || '')) return { ok: false, error: '当前密码错误' };
    if (!new_password || new_password.length < 10) throw badRequest('新密码至少需要 10 个字符');
    changePassword(request.admin.id, new_password);
    return { ok: true };
  });
}
