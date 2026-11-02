import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { db } from './db.js';
import { hashToken } from './security.js';

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
      if (!provider) return socket.close(1008, 'Invalid provider credentials');
      const previous = this.providers.get(provider.id);
      if (previous) previous.socket.close(1012, 'Replaced by a new connection');
      const state = { socket, provider, alive: true, connectedAt: Date.now() };
      this.providers.set(provider.id, state);
      socket.on('message', (data) => this.onMessage(provider.id, data));
      socket.on('pong', () => {
        state.alive = true;
        const latency = Date.now() - (state.pingedAt || Date.now());
        db.prepare("UPDATE providers SET last_seen_at = datetime('now'), last_latency_ms = ? WHERE id = ?").run(latency, provider.id);
      });
      socket.on('close', () => {
        if (this.providers.get(provider.id)?.socket === socket) this.providers.delete(provider.id);
        for (const [id, pending] of this.pending) {
          if (pending.providerId === provider.id) this.failPending(id, new Error('供应商连接已断开'));
        }
      });
      socket.on('error', (error) => this.logger.warn({ err: error }, 'Agent socket error'));
      db.prepare("UPDATE providers SET last_seen_at = datetime('now') WHERE id = ?").run(provider.id);
      socket.send(JSON.stringify({ type: 'auth_ok', provider: provider.name }));
      this.logger.info({ provider: provider.name }, 'Local agent connected');
    };
    socket.on('message', onMessage);
  }

  onMessage(providerId, raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'pong') return;
    if (message.type === 'health') {
      db.prepare("UPDATE providers SET healthy = ?, health_message = ?, last_latency_ms = ?, last_seen_at = datetime('now') WHERE id = ?")
        .run(message.online ? 1 : 0, String(message.message || '').slice(0, 500), message.latency || 0, providerId);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === 'response') {
      pending.status = message.status;
      pending.headers = Object.fromEntries(Object.entries(message.headers || {}).filter(([key]) => !HOP_BY_HOP.has(key.toLowerCase())));
      pending.resolveHeaders(pending);
    } else if (message.type === 'chunk') {
      pending.stream.write(Buffer.from(message.data, 'base64'));
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

  async forward(provider, { method, path, body, timeoutMs, signal }) {
    const state = this.providers.get(provider.id);
    if (!state || state.socket.readyState !== 1) throw Object.assign(new Error('供应商当前离线'), { statusCode: 503 });
    const id = randomUUID();
    const stream = new PassThrough();
    stream.on('error', () => {});
    let headersSettled = false;
    let resolveHeaders;
    let rejectHeaders;
    const headers = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    const pending = {
      id, providerId: provider.id, stream, resolveHeaders: (value) => { headersSettled = true; resolveHeaders(value); },
      rejectHeaders, status: 500, headers: {}, startedAt: Date.now(),
    };
    this.pending.set(id, pending);
    const timer = setTimeout(() => this.failPending(id, Object.assign(new Error('本地推理服务响应超时'), { statusCode: 504 })), timeoutMs);
    pending.timer = timer;
    const onAbort = () => {
      if (state.socket.readyState === 1) state.socket.send(JSON.stringify({ type: 'cancel', id }));
      this.failPending(id, new Error('客户端已断开'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.onAbort = onAbort;
    pending.signal = signal;
    state.socket.send(JSON.stringify({
      type: 'request', id, method, path,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
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
