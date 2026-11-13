import { anthropicResponseStream, anthropicToOpenAI } from './anthropic.js';
import { db, getKeyWindowUsage, getUserUsage, transaction } from './db.js';
import { forwardDirectProvider } from './directProvider.js';
import { bearerToken, hashToken } from './security.js';

const estimateTokens = (text) => Math.max(1, Math.ceil(String(text).length / 4));
const asOpenAIError = (message, type = 'api_error') => ({ error: { message, type } });

export class Gateway {
  constructor(tunnel, settings) {
    this.tunnel = tunnel;
    this.settings = settings;
    this.keyActivity = new Map();
    this.providerActivity = new Map();
    this.rateWindows = new Map();
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
      throw Object.assign(new Error('API Key 的五小时 Token 限额已用尽'), { statusCode: 429 });
    }
    if (key.quota_week > 0 && getKeyWindowUsage(key.id, '-7 days', key.quota_reset_week_at) >= key.quota_week) {
      throw Object.assign(new Error('API Key 的每周 Token 限额已用尽'), { statusCode: 429 });
    }
    if (key.user_id) {
      const user = db.prepare('SELECT enabled FROM users WHERE id = ?').get(key.user_id);
      if (!user?.enabled) throw Object.assign(new Error('用户账户已被停用'), { statusCode: 401 });
      const usage = getUserUsage(key.user_id);
      if (usage.five_hours.quota > 0 && usage.five_hours.used >= usage.five_hours.quota) {
        throw Object.assign(new Error('账户五小时 Token 限额已用尽'), { statusCode: 429 });
      }
      if (usage.week.quota > 0 && usage.week.used >= usage.week.quota) {
        throw Object.assign(new Error('账户每周 Token 限额已用尽'), { statusCode: 429 });
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

  models() {
    return db.prepare(`SELECT m.id, m.name, m.provider_id, p.provider_type, p.base_url FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.enabled = 1 AND p.enabled = 1 ORDER BY m.name`).all()
      .filter((model) => this.providerOnline(model))
      .map((model) => ({ id: model.name, object: 'model', created: 0, owned_by: 'umeko-relay' }));
  }

  selectProvider(modelName) {
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

  validateClient(provider, userAgent = '') {
    if (!provider.client_pattern) return;
    let expression;
    if (provider.client_mode === 'template') {
      const escaped = provider.client_pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expression = new RegExp(`^${escaped.replaceAll('\\*', '.*')}$`);
    } else {
      expression = new RegExp(provider.client_pattern);
    }
    if (expression.test(userAgent)) return;
    const defaultMessage = `供应商 ${provider.provider_name} 拒绝了客户端 ${userAgent || '未知'}，请使用要求的客户端`;
    const message = (provider.client_error_message || defaultMessage)
      .replaceAll('{{userAgent}}', userAgent || '未知')
      .replaceAll('{{provider}}', provider.provider_name);
    throw Object.assign(new Error(message), {
      statusCode: 403,
      customResponse: { field: provider.client_error_field || 'message', message, code: provider.client_error_code || 'client_mismatch' },
    });
  }

  async proxy(request, reply, format = 'openai') {
    const anthropic = format === 'anthropic';
    const authorization = request.headers.authorization || (request.headers['x-api-key'] ? `Bearer ${request.headers['x-api-key']}` : '');
    const key = this.authenticate(authorization);
    const path = anthropic ? 'chat/completions' : request.params['*'];
    const source = anthropic
      ? anthropicToOpenAI(request.body)
      : (request.body && typeof request.body === 'object' ? request.body : {});
    const modelName = source.model || '';
    if (!modelName) throw Object.assign(new Error('请求中缺少 model'), { statusCode: 400 });
    const model = this.selectProvider(modelName);
    this.validateClient(model, String(request.headers['user-agent'] || ''));
    const release = this.reserve(key);
    const releaseProvider = this.reserveProvider(model.provider_id);
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
    } catch (error) {
      reply.raw.off('close', onDisconnect);
      releaseProvider();
      release();
      this.record({ requestId: forwarded?.requestId || crypto.randomUUID(), key, model, usage: {}, status: error.statusCode || 502, latency: Date.now() - startedAt, error: error.message });
      throw error;
    }
    const isStream = String(forwarded.headers['content-type'] || '').includes('text/event-stream');
    const completion = this.observe(forwarded.stream, body, isStream, forwarded.status)
      .then((usage) => this.record({ requestId: forwarded.requestId, key, model, usage, status: forwarded.status, latency: Date.now() - startedAt }))
      .catch((error) => this.record({ requestId: forwarded.requestId, key, model, usage: {}, status: 499, latency: Date.now() - startedAt, error: error.message }))
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
      const consumeEvent = (line) => {
        if (!line.startsWith('data:') || line.trim() === 'data: [DONE]') return;
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (data.usage) usage = data.usage;
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
            output = (data.choices || []).map((choice) => choice.message?.content || choice.text || '').join('');
          } catch { /* Upstream errors without usage are still logged. */ }
        }
        const successful = status >= 200 && status < 400;
        if (successful && !usage.prompt_tokens) usage.prompt_tokens = estimateTokens(JSON.stringify(body));
        if (successful && !usage.completion_tokens && !pathIsEmbedding(body)) usage.completion_tokens = output ? estimateTokens(output) : 0;
        usage.total_tokens = usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
        resolve(usage);
      });
      stream.on('error', reject);
    });
  }

  record({ requestId, key, model, usage, status, latency, error = '' }) {
    const prompt = Math.max(0, Number(usage.prompt_tokens || 0));
    const completion = Math.max(0, Number(usage.completion_tokens || 0));
    const total = Math.max(0, Number(usage.total_tokens || prompt + completion));
    const cost = Math.round(prompt * model.input_price + completion * model.output_price);
    try {
      transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO usage_logs
          (request_id, key_id, provider_id, model, prompt_tokens, completion_tokens, total_tokens, cost_micros, status, latency_ms, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(requestId, key.id, model.provider_id, model.name, prompt, completion, total, cost, status, latency, error);
        db.prepare(`UPDATE api_keys SET used_tokens = used_tokens + ?, used_cost_micros = used_cost_micros + ?,
          last_used_at = datetime('now') WHERE id = ?`).run(total, cost, key.id);
      });
    } catch (databaseError) {
      console.error('Failed to record usage', databaseError);
    }
  }

  activeForKey(keyId) { return this.keyActivity.get(Number(keyId)) || 0; }
}

function pathIsEmbedding(body) {
  return Object.hasOwn(body, 'input') && !Object.hasOwn(body, 'messages');
}

export function sendGatewayError(reply, error) {
  const status = error.statusCode || 500;
  const payload = asOpenAIError(status === 500 ? '中转服务内部错误' : error.message, status === 429 ? 'rate_limit_error' : 'api_error');
  if (error.customResponse) {
    const field = /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(error.customResponse.field) ? error.customResponse.field : 'message';
    payload.error[field] = error.customResponse.message;
    payload.error.code = error.customResponse.code;
  }
  return reply.code(status).send(payload);
}
