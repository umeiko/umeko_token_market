import { anthropicResponseStream, anthropicToOpenAI } from './anthropic.js';
import { db, getKeyWindowUsage, getQuotaResetAt, getUserUsage, transaction } from './db.js';
import { forwardDirectProvider } from './directProvider.js';
import { bearerToken, hashToken } from './security.js';
import { upstreamErrorStream, withAdminContact } from './errors.js';
import { IpRegionResolver } from './ipRegion.js';

const estimateTokens = (text) => Math.max(1, Math.ceil(String(text).length / 4));
const asOpenAIError = (message, type = 'api_error') => ({ error: { message, type } });
const formatDuration = (seconds) => {
  const units = [['天', 86400], ['小时', 3600], ['分钟', 60], ['秒', 1]];
  let remaining = seconds;
  return units.map(([label, size]) => {
    const value = Math.floor(remaining / size);
    remaining %= size;
    return value ? `${value}${label}` : '';
  }).filter(Boolean).join('') || '0秒';
};
const quotaError = (message, resetAt, quotaWindow) => {
  const reset = resetAt || new Date(Date.now() + 1000).toISOString();
  const retryAfterSeconds = Math.max(1, Math.ceil((new Date(reset).getTime() - Date.now()) / 1000));
  return Object.assign(new Error(`${message}，预计于 ${reset} 恢复（${formatDuration(retryAfterSeconds)}后）`), {
    statusCode: 429, resetAt: reset, retryAfterSeconds, quotaWindow,
  });
};
const allowedModels = (key) => {
  try {
    const models = JSON.parse(key.allowed_models || '[]');
    return Array.isArray(models) ? models : [];
  } catch { return []; }
};

export class Gateway {
  constructor(tunnel, settings) {
    this.tunnel = tunnel;
    this.settings = settings;
    this.keyActivity = new Map();
    this.providerActivity = new Map();
    this.rateWindows = new Map();
    this.ipRegions = new IpRegionResolver();
    this.cleanupBlockedRequests();
    this.blockedCleanup = setInterval(() => this.cleanupBlockedRequests(), 60 * 60 * 1000);
    this.blockedCleanup.unref();
  }

  authenticate(header) {
    const token = bearerToken(header);
    if (!token) throw Object.assign(new Error('请在 Authorization: Bearer 中提供 API Key'), { statusCode: 401 });
    const key = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashToken(token));
    if (!key || !key.enabled) throw Object.assign(new Error('API Key 无效或已停用'), { statusCode: 401 });
    if (key.expires_at && new Date(`${key.expires_at.replace(' ', 'T')}Z`) <= new Date()) {
      throw Object.assign(new Error('API Key 已过期'), { statusCode: 401 });
    }
    if (key.token_quota > 0 && key.used_tokens >= key.token_quota) {
      throw Object.assign(new Error('API Key 的 Token 额度已用尽'), { statusCode: 429 });
    }
    if (key.budget_quota_micros > 0 && key.used_cost_micros >= key.budget_quota_micros) {
      throw Object.assign(new Error('API Key 的费用额度已用尽'), { statusCode: 429 });
    }
    if (key.quota_5h > 0 && getKeyWindowUsage(key.id, '-5 hours', key.quota_reset_5h_at) >= key.quota_5h) {
      const resetAt = getQuotaResetAt({ keyId: key.id, window: '-5 hours', quota: key.quota_5h, resetAt: key.quota_reset_5h_at });
      throw quotaError('API Key 的五小时 Token 限额已用尽', resetAt, '5h');
    }
    if (key.quota_week > 0 && getKeyWindowUsage(key.id, '-7 days', key.quota_reset_week_at) >= key.quota_week) {
      const resetAt = getQuotaResetAt({ keyId: key.id, window: '-7 days', quota: key.quota_week, resetAt: key.quota_reset_week_at });
      throw quotaError('API Key 的每周 Token 限额已用尽', resetAt, 'week');
    }
    if (key.user_id) {
      const user = db.prepare('SELECT enabled FROM users WHERE id = ?').get(key.user_id);
      if (!user?.enabled) throw Object.assign(new Error('用户账户已被停用'), { statusCode: 401 });
      const usage = getUserUsage(key.user_id);
      if (usage.five_hours.quota > 0 && usage.five_hours.used >= usage.five_hours.quota) {
        const resetAt = getQuotaResetAt({ userId: key.user_id, window: '-5 hours', quota: usage.five_hours.quota, resetAt: user.quota_reset_5h_at });
        throw quotaError('账户五小时 Token 限额已用尽', resetAt, '5h');
      }
      if (usage.week.quota > 0 && usage.week.used >= usage.week.quota) {
        const resetAt = getQuotaResetAt({ userId: key.user_id, window: '-7 days', quota: usage.week.quota, resetAt: user.quota_reset_week_at });
        throw quotaError('账户每周 Token 限额已用尽', resetAt, 'week');
      }
    }
    const now = Date.now();
    const window = (this.rateWindows.get(key.id) || []).filter((time) => now - time < 60000);
    if (key.rpm_limit > 0 && window.length >= key.rpm_limit) {
      throw Object.assign(new Error('已超过每分钟请求限额，请稍后重试'), { statusCode: 429 });
    }
    window.push(now);
    this.rateWindows.set(key.id, window);
    return key;
  }

  providerActive(providerId) {
    return (this.providerActivity.get(Number(providerId)) || 0) + this.tunnel.activeCount(providerId);
  }

  providerOnline(row) {
    return row.provider_type && row.provider_type !== 'tunnel'
      ? Boolean(row.base_url)
      : this.tunnel.isOnline(row.provider_id);
  }

  reserveProvider(providerId) {
    const id = Number(providerId);
    this.providerActivity.set(id, (this.providerActivity.get(id) || 0) + 1);
    return () => {
      const current = (this.providerActivity.get(id) || 1) - 1;
      if (current > 0) this.providerActivity.set(id, current);
      else this.providerActivity.delete(id);
    };
  }

  models(key) {
    const allowed = allowedModels(key);
    return db.prepare(`SELECT m.id, m.name, m.provider_id, p.provider_type, p.base_url FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.enabled = 1 AND p.enabled = 1 ORDER BY m.name`).all()
      .filter((model) => this.providerOnline(model) && (!allowed.length || allowed.includes(model.name)))
      .map((model) => ({ id: model.name, object: 'model', created: 0, owned_by: 'umeko-relay' }));
  }

  selectProvider(modelName, key) {
    const allowed = allowedModels(key);
    if (allowed.length && !allowed.includes(modelName)) {
      throw Object.assign(new Error(`此 API Key 无权使用模型 ${modelName}`), { statusCode: 403 });
    }
    const candidates = db.prepare(`SELECT m.*, p.name AS provider_name, p.max_concurrency,
      p.provider_type, p.base_url, p.api_key_ciphertext, p.api_key_iv, p.api_key_tag,
      p.client_mode, p.client_pattern, p.client_error_field, p.client_error_message, p.client_error_code,
      p.description, p.token_prefix, p.last_seen_at, p.last_latency_ms, p.created_at AS provider_created_at
      FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.name = ? AND m.enabled = 1 AND p.enabled = 1`).all(modelName)
      .filter((row) => this.providerOnline(row))
      .sort((a, b) => this.providerActive(a.provider_id) - this.providerActive(b.provider_id));
    if (!candidates.length) throw Object.assign(new Error(`模型 ${modelName} 不存在或所在供应商离线`), { statusCode: 503 });
    const available = candidates.find((row) => row.max_concurrency === 0 || this.providerActive(row.provider_id) < row.max_concurrency);
    if (!available) throw Object.assign(new Error('供应商并发已满，请稍后重试'), { statusCode: 429 });
    return available;
  }

  reserve(key) {
    const active = this.keyActivity.get(key.id) || 0;
    if (key.concurrency_limit > 0 && active >= key.concurrency_limit) {
      throw Object.assign(new Error('API Key 并发已满，请稍后重试'), { statusCode: 429 });
    }
    this.keyActivity.set(key.id, active + 1);
    return () => {
      const current = (this.keyActivity.get(key.id) || 1) - 1;
      if (current > 0) this.keyActivity.set(key.id, current);
      else this.keyActivity.delete(key.id);
    };
  }

  validateClient(key, userAgent = '') {
    if (!key.client_pattern) return;
    let expression;
    if (key.client_mode === 'template') {
      const escaped = key.client_pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expression = new RegExp(`^${escaped.replaceAll('\\*', '.*')}$`);
    } else {
      expression = new RegExp(key.client_pattern);
    }
    if (expression.test(userAgent)) return;
    const defaultMessage = `API Key ${key.name} 拒绝了客户端 ${userAgent || '未知'}，请使用要求的客户端`;
    const message = (key.client_error_message || defaultMessage)
      .replaceAll('{{userAgent}}', userAgent || '未知')
      .replaceAll('{{provider}}', key.name);
    throw Object.assign(new Error(message), {
      statusCode: 403,
      customResponse: { field: key.client_error_field || 'message', message, code: key.client_error_code || 'client_mismatch' },
    });
  }

  cleanupBlockedRequests() {
    db.prepare("DELETE FROM blocked_requests WHERE created_at < datetime('now', '-5 hours')").run();
    db.prepare("UPDATE usage_logs SET ip = '', ip_region = '', headers_json = '{}' WHERE created_at < datetime('now', '-5 hours') AND (ip <> '' OR ip_region <> '' OR headers_json <> '{}')").run();
  }

  rejectClient(request, reply, key, model, anthropic, text) {
    this.record({ requestId: crypto.randomUUID(), key, model, usage: {}, status: 200, latency: 0, error: '客户端 User-Agent 不匹配，已返回客户端提示流', request, category: 'client_mismatch' });
    const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '')}`;
    const created = Math.floor(Date.now() / 1000);
    let payload;
    if (anthropic) {
      const events = [
        ['message_start', { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: model.name, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      payload = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    } else {
      const chunk = (delta, finishReason) => {
        const data = { id, object: 'chat.completion.chunk', created, model: model.name, choices: [{ index: 0, delta, finish_reason: finishReason }] };
        return `data: ${JSON.stringify(data)}\n\n`;
      };
      payload = chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
    }
    return reply.code(200).type('text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache').header('x-accel-buffering', 'no')
      .send(payload);
  }

  async proxy(request, reply, format = 'openai') {
    const anthropic = format === 'anthropic';
    const authorization = request.headers.authorization || (request.headers['x-api-key'] ? `Bearer ${request.headers['x-api-key']}` : '');
    const path = anthropic ? 'chat/completions' : request.params['*'];
    const source = anthropic
      ? anthropicToOpenAI(request.body)
      : (request.body && typeof request.body === 'object' ? request.body : {});
    const modelName = source.model || '';
    let key;
    try {
      key = this.authenticate(authorization);
    } catch (error) {
      this.record({ requestId: crypto.randomUUID(), key: { id: null }, model: { provider_id: null, name: modelName, input_price: 0, output_price: 0 }, usage: {}, status: error.statusCode || 401, latency: 0, error: error.message, request, category: error.statusCode === 429 ? 'rate_limit' : 'auth_error' });
      throw error;
    }
    if (!modelName) {
      const error = Object.assign(new Error('请求中缺少 model'), { statusCode: 400 });
      this.record({ requestId: crypto.randomUUID(), key, model: { provider_id: null, name: '', input_price: 0, output_price: 0 }, usage: {}, status: 400, latency: 0, error: error.message, request, category: 'request_error' });
      throw error;
    }
    let model;
    try {
      model = this.selectProvider(modelName, key);
    } catch (error) {
      const category = error.statusCode === 429 ? 'rate_limit' : error.statusCode === 403 ? 'auth_error' : 'provider_offline';
      this.record({ requestId: crypto.randomUUID(), key, model: { provider_id: null, name: modelName, input_price: 0, output_price: 0 }, usage: {}, status: error.statusCode || 503, latency: 0, error: error.message, request, category });
      throw error;
    }
    try {
      this.validateClient(key, String(request.headers['user-agent'] || ''));
    } catch (error) {
      if (error.customResponse) return this.rejectClient(request, reply, key, model, anthropic, error.customResponse.message);
      this.record({ requestId: crypto.randomUUID(), key, model, usage: {}, status: error.statusCode || 400, latency: 0, error: error.message, request, category: 'request_error' });
      throw error;
    }
    let release;
    let releaseProvider;
    try {
      release = this.reserve(key);
      releaseProvider = this.reserveProvider(model.provider_id);
    } catch (error) {
      release?.();
      this.record({ requestId: crypto.randomUUID(), key, model, usage: {}, status: error.statusCode || 429, latency: 0, error: error.message, request, category: error.statusCode === 429 ? 'rate_limit' : 'error' });
      throw error;
    }
    const startedAt = Date.now();
    const body = { ...source, model: model.upstream_name || model.name };
    if (path === 'chat/completions' && body.stream && model.provider_type !== 'anthropic') {
      body.stream_options = { ...(body.stream_options || {}), include_usage: true };
    }
    const controller = new AbortController();
    const onDisconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onDisconnect);
    let forwarded;
    try {
      const options = {
        method: request.method,
        path: `/v1/${path}`,
        body: JSON.stringify(body),
        timeoutMs: Number(this.settings().request_timeout_ms || 300000),
        signal: controller.signal,
      };
      forwarded = model.provider_type && model.provider_type !== 'tunnel'
        ? await forwardDirectProvider(model, options)
        : await this.tunnel.forward({ id: model.provider_id }, options);
      if (forwarded.status >= 400) {
        const upstreamIsStream = String(forwarded.headers['content-type'] || '').includes('text/event-stream');
        forwarded.stream = await upstreamErrorStream(forwarded.stream, upstreamIsStream, forwarded.status);
        if (!upstreamIsStream) forwarded.headers['content-type'] = 'application/json; charset=utf-8';
      }
    } catch (error) {
      reply.raw.off('close', onDisconnect);
      releaseProvider();
      release();
      if (forwarded || !error.statusCode || error.statusCode >= 500) error.upstream = true;
      this.record({ requestId: forwarded?.requestId || crypto.randomUUID(), key, model, usage: {}, status: error.statusCode || 502, latency: Date.now() - startedAt, error: error.message, request, category: error.statusCode === 429 ? 'rate_limit' : 'upstream_error' });
      throw error;
    }
    const isStream = String(forwarded.headers['content-type'] || '').includes('text/event-stream');
    const completion = this.observe(forwarded.stream, body, isStream, forwarded.status)
      .then(({ usage, error }) => {
        const category = forwarded.status >= 200 && forwarded.status < 400 ? 'success' : [401, 403].includes(forwarded.status) ? 'upstream_auth' : 'upstream_error';
        const fallback = category === 'upstream_auth' ? '上游拒绝了供应商 API Key，请检查上游凭据' : `上游返回 HTTP ${forwarded.status}`;
        this.record({ requestId: forwarded.requestId, key, model, usage, status: forwarded.status, latency: Date.now() - startedAt, error: category === 'success' ? '' : error || fallback, request, category });
      })
      .catch((error) => this.record({ requestId: forwarded.requestId, key, model, usage: {}, status: 499, latency: Date.now() - startedAt, error: error.message, request, category: 'upstream_error' }))
      .finally(() => { reply.raw.off('close', onDisconnect); releaseProvider(); release(); });
    completion.catch(() => {});
    reply.code(forwarded.status);
    for (const [name, value] of Object.entries(forwarded.headers)) {
      if (value !== undefined && !['content-length', 'content-encoding'].includes(name.toLowerCase())) reply.header(name, value);
    }
    reply.header('x-request-id', forwarded.requestId);
    const output = anthropic
      ? anthropicResponseStream(forwarded.stream, { isStream, status: forwarded.status, model: model.name, requestId: forwarded.requestId })
      : forwarded.stream;
    return reply.send(output);
  }

  observe(stream, body, isStream, status) {
    return new Promise((resolve, reject) => {
      let usage = {};
      let output = '';
      let plain = '';
      let sseBuffer = '';
      let upstreamError = '';
      const consumeEvent = (line) => {
        if (!line.startsWith('data:') || line.trim() === 'data: [DONE]') return;
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (data.usage) usage = data.usage;
          if (data.error) upstreamError = data.error.message || String(data.error);
          for (const choice of data.choices || []) output += choice.delta?.content || choice.text || '';
        } catch { /* Ignore non-JSON SSE event data. */ }
      };
      stream.on('data', (chunk) => {
        const text = chunk.toString();
        if (!isStream) { plain += text; return; }
        const lines = (sseBuffer + text).split(/\r?\n/);
        sseBuffer = lines.pop();
        lines.forEach(consumeEvent);
      });
      stream.on('end', () => {
        if (sseBuffer) consumeEvent(sseBuffer);
        if (!isStream) {
          try {
            const data = JSON.parse(plain);
            usage = data.usage || {};
            upstreamError = data.error?.message || data.message || '';
            output = (data.choices || []).map((choice) => choice.message?.content || choice.text || '').join('');
          } catch { /* Upstream errors without usage are still logged. */ }
        }
        const successful = status >= 200 && status < 400;
        if (successful && !usage.prompt_tokens) usage.prompt_tokens = estimateTokens(JSON.stringify(body));
        if (successful && !usage.completion_tokens && !pathIsEmbedding(body)) usage.completion_tokens = output ? estimateTokens(output) : 0;
        usage.total_tokens = usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
        if (!successful && !upstreamError) upstreamError = plain.slice(0, 2000);
        resolve({ usage, error: upstreamError.slice(0, 2000) });
      });
      stream.on('error', reject);
      stream.on('close', () => {
        if (!stream.readableEnded) reject(new Error('上游响应流在完成前关闭'));
      });
    });
  }

  record({ requestId, key, model, usage, status, latency, error = '', request, category }) {
    const prompt = Math.max(0, Number(usage.prompt_tokens || 0));
    const completion = Math.max(0, Number(usage.completion_tokens || 0));
    const total = Math.max(0, Number(usage.total_tokens || prompt + completion));
    const cost = Math.round(prompt * model.input_price + completion * model.output_price);
    const headers = request ? Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [
      name,
      ['authorization', 'x-api-key', 'cookie'].includes(name.toLowerCase()) ? '[redacted]' : value,
    ])) : {};
    const resultCategory = category || (status >= 200 && status < 400 ? 'success' : 'error');
    const ip = request?.ip || '';
    let logId = null;
    try {
      transaction(() => {
        const result = db.prepare(`INSERT OR IGNORE INTO usage_logs
          (request_id, key_id, provider_id, model, prompt_tokens, completion_tokens, total_tokens, cost_micros, status, latency_ms, category, ip, headers_json, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(requestId, key.id || null, model.provider_id || null, model.name, prompt, completion, total, cost, status, latency, resultCategory, ip, JSON.stringify(headers), error);
        if (result.changes) logId = Number(result.lastInsertRowid);
        if (key.id) {
          db.prepare(`UPDATE api_keys SET used_tokens = used_tokens + ?, used_cost_micros = used_cost_micros + ?,
            last_used_at = datetime('now') WHERE id = ?`).run(total, cost, key.id);
        }
      });
      if (logId) this.fillIpRegion(logId, ip).catch(() => {});
    } catch (databaseError) {
      console.error('Failed to record usage', databaseError);
    }
  }

  async fillIpRegion(logId, ip) {
    if (!ip) return;
    const region = await this.ipRegions.resolve(ip);
    if (region) db.prepare('UPDATE usage_logs SET ip_region = ? WHERE id = ? AND ip = ?').run(region, logId, ip);
  }

  activeForKey(keyId) { return this.keyActivity.get(Number(keyId)) || 0; }
}

function pathIsEmbedding(body) {
  return Object.hasOwn(body, 'input') && !Object.hasOwn(body, 'messages');
}

export function sendGatewayError(reply, error) {
  const status = error.statusCode || 500;
  const message = error.upstream ? withAdminContact(error.message) : status === 500 ? '中转服务内部错误' : error.message;
  const payload = asOpenAIError(message, status === 429 ? 'rate_limit_error' : 'api_error');
  if (error.resetAt) {
    payload.error.reset_at = error.resetAt;
    payload.error.retry_after_seconds = error.retryAfterSeconds;
    payload.error.quota_window = error.quotaWindow;
    reply.header('Retry-After', String(error.retryAfterSeconds));
  }
  if (error.customResponse) {
    const field = /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(error.customResponse.field) ? error.customResponse.field : 'message';
    payload.error[field] = error.customResponse.message;
    payload.error.code = error.customResponse.code;
  }
  return reply.code(status).send(payload);
}
