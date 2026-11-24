import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { db } from './db.js';
import { hashToken, isTunnelProvider } from './security.js';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);

export class Tunnel {
  constructor(logger) {
    this.logger = logger;
    this.providers = new Map();
    this.pending = new Map();
    this.heartbeat = setInterval(() => this.checkConnections(), 15000);
    this.heartbeat.unref();
  }

  connect(socket) {
    const timeout = setTimeout(() => socket.close(1008, 'Authentication timeout'), 10000);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type !== 'auth') return socket.close(1008, 'Authentication required');
      clearTimeout(timeout);
      socket.off('message', onMessage);
      const provider = db.prepare('SELECT * FROM providers WHERE id = ? AND token_hash = ? AND enabled = 1').get(message.providerId, hashToken(message.token || ''));
      if (!provider || !isTunnelProvider(provider.provider_type)) return socket.close(1008, 'Invalid provider credentials');
      if (provider.provider_type === 'video_tunnel' && message.videoBridge !== true) {
        return socket.close(1008, 'A video-capable utoken connector is required');
      }
      const previous = this.providers.get(provider.id);
      if (previous) previous.socket.close(1012, 'Replaced by a new connection');
      const state = { socket, provider, alive: true, connectedAt: Date.now() };
      this.providers.set(provider.id, state);
      socket.on('message', (data) => this.onMessage(state, data));
      socket.on('pong', () => {
        state.alive = true;
        const latency = Date.now() - (state.pingedAt || Date.now());
        db.prepare("UPDATE providers SET last_seen_at = datetime('now'), last_latency_ms = ? WHERE id = ?").run(latency, provider.id);
      });
      socket.on('close', () => {
        if (this.providers.get(provider.id)?.socket === socket) this.providers.delete(provider.id);
        for (const [id, pending] of this.pending) {
          if (pending.socket === socket) this.failPending(id, new Error('供应商连接已断开'));
        }
      });
      socket.on('error', (error) => this.logger.warn({ err: error }, 'Agent socket error'));
      db.prepare("UPDATE providers SET last_seen_at = datetime('now') WHERE id = ?").run(provider.id);
      db.prepare('UPDATE providers SET healthy = 0, health_message = ? WHERE id = ?').run('等待本地服务健康检查', provider.id);
      socket.send(JSON.stringify({ type: 'auth_ok', provider: provider.name, providerType: provider.provider_type, models: this.providerModels(provider.id) }));
      this.logger.info({ provider: provider.name }, 'Local agent connected');
    };
    socket.on('message', onMessage);
  }

  providerModels(providerId) {
    return db.prepare(`SELECT name, upstream_name, enabled FROM models WHERE provider_id = ? ORDER BY id LIMIT 200`).all(providerId);
  }

  discovery(providerId) {
    return this.providers.get(Number(providerId))?.discovery || null;
  }

  onMessage(state, raw) {
    const providerId = state.provider.id;
    if (this.providers.get(providerId) !== state) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'pong') return;
    if (message.type === 'health') {
      if (message.discovery && typeof message.discovery === 'object') {
        const { models, healthPath, localAuth } = message.discovery;
        const modelIds = Array.isArray(models) ? models.slice(0, 200).filter((id) =>
          typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id)) : [];
        state.discovery = {
          models: message.online === true ? [...new Set(modelIds)] : [],
          health_path: typeof healthPath === 'string' && /^\/[a-zA-Z0-9_./-]{0,200}$/.test(healthPath) ? healthPath : '',
          local_auth: localAuth === true,
        };
      }
      db.prepare("UPDATE providers SET healthy = ?, health_message = ?, last_latency_ms = ?, last_seen_at = datetime('now') WHERE id = ?")
        .run(message.online ? 1 : 0, String(message.message || '').slice(0, 500), message.latency || 0, providerId);
      state.socket.send(JSON.stringify({ type: 'provider_info', models: this.providerModels(providerId) }));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || pending.socket !== state.socket) return;
    if (message.type === 'response') {
      pending.status = message.status;
      pending.headers = Object.fromEntries(Object.entries(message.headers || {}).filter(([key]) => !HOP_BY_HOP.has(key.toLowerCase())));
      pending.resolveHeaders(pending);
    } else if (message.type === 'chunk') {
      const chunk = Buffer.from(message.data || '', 'base64');
      if (pending.flowControl) {
        pending.bytes += chunk.length;
        if (pending.waitingForDrain || chunk.length > 256 * 1024 || pending.bytes > pending.byteLimit) {
          pending.cancel();
          this.failPending(message.id, new Error('视频传输超过流量限制'));
          return;
        }
        const acknowledge = () => {
          pending.waitingForDrain = false;
          if (this.pending.has(message.id) && state.socket.readyState === 1) {
            state.socket.send(JSON.stringify({ type: 'credit', id: message.id }));
          }
        };
        if (pending.stream.write(chunk)) acknowledge();
        else {
          pending.waitingForDrain = true;
          pending.stream.once('drain', acknowledge);
        }
      } else pending.stream.write(chunk);
    } else if (message.type === 'end') {
      pending.stream.end();
      this.finishPending(message.id);
    } else if (message.type === 'error') {
      this.failPending(message.id, new Error(message.message || '本地代理请求失败'));
    }
  }

  checkConnections() {
    for (const state of this.providers.values()) {
      if (!state.alive) {
        state.socket.terminate();
        continue;
      }
      state.alive = false;
      state.pingedAt = Date.now();
      state.socket.ping();
    }
  }

  connected(providerId) {
    return this.providers.get(Number(providerId))?.socket.readyState === 1;
  }

  isOnline(providerId) {
    const id = Number(providerId);
    const state = this.providers.get(id);
    const healthy = db.prepare('SELECT healthy FROM providers WHERE id = ? AND enabled = 1').get(id)?.healthy;
    return Boolean(state && state.socket.readyState === 1 && healthy === 1);
  }

  activeCount(providerId) {
    let count = 0;
    for (const pending of this.pending.values()) if (pending.providerId === Number(providerId)) count++;
    return count;
  }

  async forward(provider, { method, path, body, timeoutMs, signal, headers: requestHeaders = {}, byteLimit }) {
    if (signal?.aborted) throw new Error('客户端已断开');
    const state = this.providers.get(provider.id);
    if (!state || state.socket.readyState !== 1) throw Object.assign(new Error('供应商当前离线'), { statusCode: 503 });
    const id = randomUUID();
    const stream = new PassThrough({ highWaterMark: byteLimit ? 256 * 1024 : undefined });
    stream.on('error', () => {});
    let headersSettled = false;
    let resolveHeaders;
    let rejectHeaders;
    const headers = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    const pending = {
      id, providerId: provider.id, socket: state.socket, stream, flowControl: Boolean(byteLimit), byteLimit, bytes: 0,
      resolveHeaders: (value) => { headersSettled = true; resolveHeaders(value); },
      rejectHeaders, status: 500, headers: {}, startedAt: Date.now(),
    };
    this.pending.set(id, pending);
    pending.cancel = () => {
      if (state.socket.readyState === 1) state.socket.send(JSON.stringify({ type: 'cancel', id }));
    };
    pending.timer = setTimeout(() => {
      pending.cancel();
      this.failPending(id, Object.assign(new Error('本地推理服务响应超时'), { statusCode: 504 }));
    }, timeoutMs);
    const onAbort = () => {
      pending.cancel();
      this.failPending(id, new Error('客户端已断开'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.onAbort = onAbort;
    pending.signal = signal;
    stream.once('close', () => {
      if (this.pending.get(id) !== pending) return;
      pending.cancel();
      this.failPending(id, new Error('本地响应传输已终止'));
    });
    state.socket.send(JSON.stringify({
      type: 'request', id, method, path,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...requestHeaders },
      ...(byteLimit ? { flowControl: true } : {}),
      body: Buffer.from(body).toString('base64'),
    }));
    try {
      await headers;
      return { ...pending, requestId: id };
    } catch (error) {
      if (!headersSettled) stream.destroy();
      throw error;
    }
  }

  finishPending(id) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    this.pending.delete(id);
  }

  failPending(id, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.rejectHeaders(error);
    pending.stream.destroy(error);
    this.finishPending(id);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const state of this.providers.values()) state.socket.close(1001, 'Server shutdown');
    for (const id of this.pending.keys()) this.failPending(id, new Error('服务正在关闭'));
  }
}
