import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, getUserUsage } from './db.js';
import { consumeRateLimit, createApiKey, sessionExpired, touchSession, verifySameOrigin } from './security.js';
import { isDevelopmentEmail, sendVerificationEmail } from './mailer.js';

const sessions = new Map();
const loginAttempts = new Map();
const SESSION_AGE = 7 * 86400000;
setInterval(() => {
  for (const [token, session] of sessions) if (sessionExpired(session)) sessions.delete(token);
  for (const [ip, attempts] of loginAttempts) {
    const recent = attempts.filter((time) => Date.now() - time < 600000);
    if (recent.length) loginAttempts.set(ip, recent);
    else loginAttempts.delete(ip);
  }
}, 60000).unref();
const DISPOSABLE_DOMAINS = new Set(['10minutemail.com', 'guerrillamail.com', 'mailinator.com', 'temp-mail.org', 'tempmail.com', 'throwawaymail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'trashmail.com']);
const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const validEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const publicUser = (user) => ({ id: user.id, email: user.email, enabled: Boolean(user.enabled), created_at: user.created_at });

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return;
  if (!token) throw error(400, '请完成人机验证');
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(8000),
  });
  const result = await response.json();
  if (!result.success) throw error(400, '人机验证失败，请重试');
}

export async function userRoutes(app, { tunnel }) {
  app.setErrorHandler((cause, request, reply) => {
    request.log.error({ err: cause }, 'User API request failed');
    if (reply.sent) return;
    const status = cause.statusCode || 500;
    reply.code(status).send({ error: status === 500 ? '用户服务内部错误' : cause.message });
  });
  app.addHook('onRequest', async (request) => {
    if (['POST', 'PATCH', 'DELETE'].includes(request.method)) verifySameOrigin(request);
  });

  async function requireUser(request, reply) {
    const token = request.cookies.utoken_user_session;
    const session = token && sessions.get(token);
    const user = session && db.prepare('SELECT * FROM users WHERE id = ? AND enabled = 1').get(session.userId);
    if (!user || sessionExpired(session)) {
      if (token) sessions.delete(token);
      return reply.code(401).send({ error: '登录已失效，请重新验证邮箱' });
    }
    touchSession(session);
    request.user = user;
  }

  app.get('/api/user/config', async () => ({
    turnstile_site_key: process.env.TURNSTILE_SITE_KEY || '',
    development_email: isDevelopmentEmail(),
    default_quotas: { five_hours: 2000000, week: 20000000 },
  }));

  app.post('/api/user/code', async (request) => {
    const body = request.body || {};
    if (body.website) return { ok: true };
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) throw error(400, '请输入有效的邮箱地址');
    const ip = request.ip;
    const hourly = db.prepare("SELECT COUNT(*) count FROM email_challenges WHERE ip = ? AND created_at >= datetime('now', '-1 hour')").get(ip).count;
    const daily = db.prepare("SELECT COUNT(*) count FROM email_challenges WHERE ip = ? AND created_at >= datetime('now', '-1 day')").get(ip).count;
    if (hourly >= 10 || daily >= 30) throw error(429, '当前网络请求过于频繁，请稍后再试');
    const emailDaily = db.prepare("SELECT COUNT(*) count FROM email_challenges WHERE email = ? AND created_at >= datetime('now', '-1 day')").get(email).count;
    const latest = db.prepare('SELECT created_at FROM email_challenges WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
    if (emailDaily >= 5 || (latest && Date.now() - new Date(`${latest.created_at.replace(' ', 'T')}Z`).getTime() < 60000)) {
      throw error(429, '验证码发送过于频繁，请一分钟后再试');
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!existing) {
      const registrations = db.prepare("SELECT COUNT(*) count FROM users WHERE created_ip = ? AND created_at >= datetime('now', '-1 day')").get(ip).count;
      if (registrations >= 5) throw error(429, '当前网络注册次数过多，请明天再试');
      const domain = email.split('@')[1];
      if (process.env.BLOCK_DISPOSABLE_EMAIL !== 'false' && DISPOSABLE_DOMAINS.has(domain)) throw error(403, '请使用常用邮箱完成注册');
    }
    await verifyTurnstile(body.turnstile_token, ip);
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(code, salt, 64).toString('hex');
    db.prepare("UPDATE email_challenges SET consumed = 1 WHERE email = ? AND consumed = 0").run(email);
    const result = db.prepare("INSERT INTO email_challenges(email, code_hash, salt, ip, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+10 minutes'))")
      .run(email, hash, salt, ip);
    try {
      await sendVerificationEmail(email, code);
    } catch (cause) {
      db.prepare('DELETE FROM email_challenges WHERE id = ?').run(result.lastInsertRowid);
      throw cause;
    }
    return { ok: true, message: '如果邮箱可用，验证码已发送' };
  });

  app.post('/api/user/login', async (request, reply) => {
    if (!consumeRateLimit(loginAttempts, request.ip, 20, 600000)) throw error(429, '登录尝试过于频繁，请十分钟后再试');
    const body = request.body || {};
    const email = normalizeEmail(body.email);
    const code = String(body.code || '').trim();
    if (!validEmail(email) || !/^\d{6}$/.test(code)) throw error(400, '邮箱或验证码格式不正确');
    const challenge = db.prepare('SELECT * FROM email_challenges WHERE email = ? AND consumed = 0 ORDER BY id DESC LIMIT 1').get(email);
    const invalid = () => error(401, '验证码错误、已过期或尝试次数过多');
    if (!challenge || challenge.attempts >= 5 || new Date(`${challenge.expires_at.replace(' ', 'T')}Z`) <= new Date()) throw invalid();
    const candidate = scryptSync(code, challenge.salt, 64);
    if (!timingSafeEqual(candidate, Buffer.from(challenge.code_hash, 'hex'))) {
      db.prepare('UPDATE email_challenges SET attempts = attempts + 1, consumed = CASE WHEN attempts >= 4 THEN 1 ELSE consumed END WHERE id = ?').run(challenge.id);
      throw invalid();
    }
    db.prepare('UPDATE email_challenges SET consumed = 1 WHERE id = ?').run(challenge.id);
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      const registrations = db.prepare("SELECT COUNT(*) count FROM users WHERE created_ip = ? AND created_at >= datetime('now', '-1 day')").get(request.ip).count;
      if (registrations >= 5) throw error(429, '当前网络注册次数过多，请明天再试');
      const result = db.prepare('INSERT INTO users(email, created_ip, last_login_at) VALUES (?, ?, datetime(\'now\'))').run(email, request.ip);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }
    if (!user.enabled) throw error(403, '该账户已被停用，请联系管理员');
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { userId: user.id, expires: Date.now() + SESSION_AGE, lastSeen: Date.now() });
    reply.setCookie('utoken_user_session', token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: SESSION_AGE / 1000,
    });
    return { user: publicUser(user), usage: getUserUsage(user.id) };
  });

  app.post('/api/user/logout', async (request, reply) => {
    const token = request.cookies.utoken_user_session;
    if (token) sessions.delete(token);
    reply.clearCookie('utoken_user_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/user/me', { preHandler: requireUser }, async (request) => ({ user: publicUser(request.user), usage: getUserUsage(request.user.id) }));

  app.get('/api/user/overview', { preHandler: requireUser }, async (request) => {
    const userId = request.user.id;
    const stats = db.prepare(`SELECT COUNT(*) requests, COALESCE(SUM(l.total_tokens), 0) tokens,
      COALESCE(SUM(l.cost_micros), 0) cost_micros,
      COALESCE(SUM(CASE WHEN l.status BETWEEN 200 AND 399 THEN 1 ELSE 0 END), 0) successful
      FROM usage_logs l JOIN api_keys k ON k.id = l.key_id
      WHERE k.user_id = ? AND l.created_at >= datetime('now', '-1 hour')`).get(userId);
    const logs = db.prepare(`SELECT l.id, l.request_id, l.model, l.prompt_tokens, l.completion_tokens,
      l.total_tokens, l.cost_micros, l.status, l.latency_ms, l.created_at, k.key_prefix
      FROM usage_logs l JOIN api_keys k ON k.id = l.key_id
      WHERE k.user_id = ? AND l.created_at >= datetime('now', '-1 hour')
      ORDER BY l.id DESC LIMIT 100`).all(userId);
    const models = db.prepare(`SELECT m.name, m.input_price, m.output_price, p.name provider_name, p.id provider_id,
      p.provider_type, p.base_url FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.enabled = 1 AND p.enabled = 1 ORDER BY m.name`).all()
      .filter((model) => model.provider_type !== 'tunnel' ? Boolean(model.base_url) : tunnel.isOnline(model.provider_id))
      .map(({ provider_id, provider_type, base_url, ...model }) => model);
    const plans = db.prepare('SELECT id, name, quota_5h, quota_week FROM api_keys WHERE user_id IS NULL AND enabled = 1 AND allow_user_apply = 1 ORDER BY id DESC').all();
    return { user: publicUser(request.user), usage: getUserUsage(userId), stats: { ...stats, cost: stats.cost_micros / 1e6 }, models, logs, plans };
  });

  app.get('/api/user/keys', { preHandler: requireUser }, async (request) => ({
    keys: db.prepare('SELECT id, name, key_prefix, enabled, used_tokens, used_cost_micros, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY id DESC').all(request.user.id)
      .map((key) => ({ ...key, enabled: Boolean(key.enabled), used_cost: key.used_cost_micros / 1e6 })),
  }));

  app.post('/api/user/keys', { preHandler: requireUser }, async (request) => {
    const count = db.prepare('SELECT COUNT(*) count FROM api_keys WHERE user_id = ? AND enabled = 1').get(request.user.id).count;
    if (count >= 3) throw error(429, '每个用户最多保留 3 个启用的 API Key');
    const name = String(request.body?.name || '我的 API Key').trim().slice(0, 60) || '我的 API Key';
    let plan = null;
    if (request.body?.plan_id) {
      plan = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id IS NULL AND enabled = 1 AND allow_user_apply = 1').get(request.body.plan_id);
      if (!plan) throw error(404, '该申请方案不存在或已关闭');
    }
    const credentials = createApiKey();
    const result = db.prepare(`INSERT INTO api_keys
      (user_id, name, key_hash, key_prefix, token_quota, budget_quota_micros, quota_5h, quota_week, rpm_limit, concurrency_limit)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`)
      .run(request.user.id, name, credentials.hash, credentials.prefix,
        plan?.quota_5h || 0, plan?.quota_week || 0, plan?.rpm_limit ?? 60, plan?.concurrency_limit ?? 2);
    return { id: Number(result.lastInsertRowid), key: credentials.token };
  });

  app.patch('/api/user/keys/:id', { preHandler: requireUser }, async (request) => {
    const key = db.prepare('SELECT id FROM api_keys WHERE id = ? AND user_id = ?').get(request.params.id, request.user.id);
    if (!key) throw error(404, 'Key 不存在');
    db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(request.body?.enabled === false ? 0 : 1, key.id);
    return { ok: true };
  });
}
