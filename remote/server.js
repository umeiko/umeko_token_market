import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { createWebSocketStream } from 'ws';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { pipeline } from 'node:stream';
import { digest, randomToken, verifySignature } from './auth.js';
import { GuacParser, instruction, openDesktop } from './guacamole.js';

const root = dirname(fileURLToPath(import.meta.url));
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const bounded = (number, min, max, fallback) => Number.isFinite(Number(number)) ? Math.max(min, Math.min(max, Math.round(Number(number)))) : fallback;

export async function createRemoteServer(config) {
  const base = config.path || '/remote';
  const origin = new URL(config.origin).origin;
  const secure = origin.startsWith('https:');
  if (!secure && !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('远程访问必须使用 HTTPS');
  const cookieName = secure ? '__Secure-umeko_remote' : 'umeko_remote_dev';
  const app = Fastify({ logger: config.logger ?? true, bodyLimit: 16384, trustProxy: '127.0.0.1' });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024, perMessageDeflate: false } });
  const challenges = new Map(), sessions = new Map(), tickets = new Map(), channels = new Map(), limits = new Map();
  let device = null, lastSeen = null, persistPromise = Promise.resolve();
  if (config.stateFile) {
    try { lastSeen = JSON.parse(await readFile(config.stateFile, 'utf8')).lastSeen || null; } catch { /* First start. */ }
  }
  const sessionMs = config.sessionMs || 8 * 3600000;
  const markSeen = () => { lastSeen = new Date().toISOString(); };
  function persist() {
    if (!config.stateFile) return;
    persistPromise = persistPromise.then(async () => {
      await mkdir(dirname(config.stateFile), { recursive: true, mode: 0o700 });
      await writeFile(`${config.stateFile}.tmp`, JSON.stringify({ lastSeen }), { mode: 0o600 });
      await rename(`${config.stateFile}.tmp`, config.stateFile);
    }).catch(() => app.log.warn('Unable to persist last-seen timestamp'));
  }
  const checkOrigin = (request, required = true) => {
    if ((required || request.headers.origin) && request.headers.origin !== origin) throw fail('来源验证失败', 403);
  };
  function rateLimit(request, name, count, windowMs = 60000) {
    const id = `${name}:${request.ip}`;
    let entry = limits.get(id);
    if (!entry || entry.until < Date.now()) { entry = { used: 0, until: Date.now() + windowMs }; limits.set(id, entry); }
    if (++entry.used > count || limits.size > 10000) throw fail('请求过于频繁，请稍后重试', 429);
  }
  function endSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    for (const socket of session.sockets) socket.close(1008, 'Session ended');
    for (const [key, ticket] of tickets) if (ticket.sessionId === id) tickets.delete(key);
  }
  function getSession(request) {
    const raw = request.cookies[cookieName];
    const id = raw ? digest(raw) : '';
    const session = sessions.get(id);
    if (!session || session.expires <= Date.now()) { endSession(id); throw fail('请使用密钥登录', 401); }
    return { ...session, id };
  }
  function issueTicket(value, ttl = 30000) {
    if (tickets.size >= 256) throw fail('连接请求过多', 429);
    const ticket = randomToken();
    tickets.set(digest(ticket), { ...value, expires: Date.now() + ttl });
    return ticket;
  }
  function takeTicket(raw, role) {
    const id = digest(String(raw || ''));
    const ticket = tickets.get(id);
    tickets.delete(id);
    if (!ticket || ticket.role !== role || ticket.expires <= Date.now()) throw fail('连接凭据已过期', 401);
    if (ticket.sessionId && (!sessions.has(ticket.sessionId) || sessions.get(ticket.sessionId).expires <= Date.now())) throw fail('登录已过期', 401);
    return ticket;
  }
  const track = (socket, sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return socket.close(1008, 'Session expired');
    if (session.sockets.size >= 12) return socket.close(1008, 'Too many connections');
    session.sockets.add(socket);
    socket.once('close', () => session.sockets.delete(socket));
  };
  function firstMessage(socket, callback) {
    const timeout = setTimeout(() => socket.close(1008, 'Authentication timeout'), 8000);
    socket.once('message', (raw, binary) => {
      clearTimeout(timeout);
      try {
        if (binary || raw.length > 8192) throw fail('Invalid handshake');
        Promise.resolve(callback(JSON.parse(raw.toString()))).catch(() => socket.close(1008, 'Connection rejected'));
      } catch { socket.close(1008, 'Connection rejected'); }
    });
    socket.once('close', () => clearTimeout(timeout));
    socket.on('error', () => {});
  }
  function disconnectDevice(state) {
    if (device !== state) return;
    device = null;
    for (const [id, channel] of channels) {
      if (channel.device !== state) continue;
      clearTimeout(channel.timeout); channel.reject?.(fail('本机连接已断开', 503)); channel.stream?.destroy(); channel.socket?.terminate(); channels.delete(id);
    }
    persist();
    app.log.info('Remote device disconnected');
  }
  async function openChannel(service) {
    const state = device;
    if (!state || state.socket.readyState !== 1) throw fail('本机连接器离线', 503);
    if (channels.size >= 12) throw fail('并发连接过多', 429);
    const id = randomToken(), token = randomToken();
    return new Promise((accept, reject) => {
      const timeout = setTimeout(() => { channels.delete(id); reject(fail('本机连接超时', 504)); }, 12000);
      channels.set(id, { device: state, tokenHash: digest(token), accept, reject, timeout });
      state.socket.send(JSON.stringify({ type: 'open', id, token, service }));
    });
  }
  function couple(socket, stream) {
    pipeline(socket, stream, () => socket.destroy());
    pipeline(stream, socket, () => stream.destroy());
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (!['GET', 'HEAD'].includes(request.method)) checkOrigin(request);
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode || 500;
    if (status >= 500) app.log.warn({ status }, 'Remote operation failed');
    reply.code(status).send({ error: status >= 500 ? '远程服务暂不可用，请检查连接器和桌面服务' : error.message });
  });
  const assets = {
    [`${base}/`]: ['web/index.html', 'text/html; charset=utf-8'],
    [`${base}/app.js`]: ['web/app.js', 'text/javascript; charset=utf-8'],
    [`${base}/style.css`]: ['web/style.css', 'text/css; charset=utf-8'],
    [`${base}/guacamole.js`]: ['vendor/guacamole-common.js', 'text/javascript; charset=utf-8'],
    [`${base}/umeko-remote.mjs`]: ['client.js', 'text/javascript; charset=utf-8'],
  };
  app.get(base, async (request, reply) => reply.redirect(`${base}/`));
  for (const [url, [path, type]] of Object.entries(assets)) {
    const data = await readFile(resolve(root, path));
    app.get(url, async (request, reply) => reply.type(type).send(data));
  }
  app.post(`${base}/api/challenge`, async (request) => {
    rateLimit(request, 'challenge', 20);
    if (challenges.size >= 2000) throw fail('请稍后再试', 429);
    const { role, keyId } = request.body || {};
    if (!['admin', 'device'].includes(role) || typeof keyId !== 'string' || keyId.length > 100) throw fail('无效的密钥');
    const id = randomToken();
    const challenge = `Umeko Remote v1\n${origin}${base}\n${role}\n${randomToken()}`;
    challenges.set(id, { challenge, role, keyId, ip: request.ip, expires: Date.now() + 60000 });
    return { id, challenge };
  });
  app.post(`${base}/api/verify`, async (request, reply) => {
    rateLimit(request, 'verify', 20);
    const { id, signature } = request.body || {};
    const challenge = challenges.get(id);
    challenges.delete(id);
    if (!challenge || challenge.expires <= Date.now() || challenge.ip !== request.ip) throw fail('验证已过期，请重新选择密钥', 401);
    const key = challenge.role === 'admin' ? config.adminKeys.find((key) => key.id === challenge.keyId) : config.device.id === challenge.keyId ? config.device : null;
    if (!key || typeof signature !== 'string' || !verifySignature(key.publicKey, challenge.challenge, signature)) throw fail('密钥验证失败', 401);
    if (challenge.role === 'device') return { ticket: issueTicket({ role: 'device' }) };
    if (sessions.size >= 64) throw fail('登录会话过多', 429);
    const token = randomToken(), expires = Date.now() + sessionMs;
    sessions.set(digest(token), { keyId: key.id, expires, sockets: new Set() });
    reply.setCookie(cookieName, token, { path: `${base}/`, httpOnly: true, secure, sameSite: 'strict', maxAge: Math.floor(sessionMs / 1000) });
    app.log.info('Remote administrator authenticated');
    return { authenticated: true, expires };
  });
  app.get(`${base}/api/status`, async (request) => {
    const session = getSession(request);
    return {
      authenticated: true, expires: session.expires,
      device: { name: config.device.name || '我的电脑', online: !!device, lastSeen,
        connectedAt: device?.connectedAt || null, status: device?.status || null },
    };
  });
  app.post(`${base}/api/logout`, async (request, reply) => {
    endSession(getSession(request).id);
    reply.clearCookie(cookieName, { path: `${base}/`, secure, sameSite: 'strict', httpOnly: true });
    return { ok: true };
  });
  app.post(`${base}/api/ssh-ticket`, async (request) => {
    rateLimit(request, 'ssh-ticket', 40);
    const session = getSession(request);
    if (!device) throw fail('本机连接器离线', 409);
    return { ticket: issueTicket({ role: 'ssh', sessionId: session.id }) };
  });
  app.post(`${base}/api/desktop-ticket`, async (request) => {
    rateLimit(request, 'desktop', 10);
    const session = getSession(request);
    if (!device) throw fail('本机连接器离线', 409);
    const { username = config.desktopUser || '', password = '', width, height } = request.body || {};
    if (typeof username !== 'string' || username.length > 128 || typeof password !== 'string' || password.length > 512) throw fail('登录信息格式不正确');
    return { ticket: issueTicket({ role: 'desktop', sessionId: session.id, username, password,
      width: bounded(width, 640, 3840, 1440), height: bounded(height, 480, 2160, 900) }) };
  });
  app.get(`${base}/ws/device`, { websocket: true }, (socket, request) => {
    try { checkOrigin(request, false); rateLimit(request, 'device-ws', 20); } catch { return socket.close(1008); }
    firstMessage(socket, ({ ticket }) => {
      takeTicket(ticket, 'device');
      if (socket.readyState !== 1) return;
      const previous = device;
      if (previous) { disconnectDevice(previous); previous.socket.close(1012, 'Replaced'); }
      const state = { socket, alive: true, connectedAt: new Date().toISOString(), status: null };
      device = state; markSeen(); persist();
      socket.on('pong', () => { state.alive = true; markSeen(); });
      socket.on('message', (raw, binary) => {
        if (device !== state || binary || raw.length > 4096) return socket.close(1008, 'Invalid status');
        try {
          const value = JSON.parse(raw.toString());
          if (value.type !== 'status') return;
          state.status = {
            hostname: String(value.hostname || '').slice(0, 128), platform: String(value.platform || '').slice(0, 64),
            uptime: bounded(value.uptime, 0, 315360000, 0),
            ssh: value.ssh === true, rdp: value.rdp === true,
          };
          markSeen();
        } catch { socket.close(1008, 'Invalid status'); }
      });
      socket.once('close', () => disconnectDevice(state));
      socket.send(JSON.stringify({ type: 'ready' }));
      app.log.info('Remote device connected');
    });
  });
  app.get(`${base}/ws/channel`, { websocket: true }, (socket, request) => {
    try { checkOrigin(request, false); rateLimit(request, 'channel-ws', 60); } catch { return socket.close(1008); }
    firstMessage(socket, ({ id, token }) => {
      const channel = channels.get(id);
      if (!channel || channel.stream || channel.device !== device || channel.tokenHash !== digest(String(token || ''))) throw fail('Invalid channel');
      clearTimeout(channel.timeout);
      channel.tokenHash = null;
      channel.socket = socket;
      const stream = createWebSocketStream(socket);
      stream.on('error', () => {});
      channel.stream = stream;
      socket.once('close', () => channels.delete(id));
      socket.send(JSON.stringify({ type: 'ready' }));
      channel.accept(stream);
    });
  });
  app.get(`${base}/ws/ssh`, { websocket: true }, (socket, request) => {
    try { checkOrigin(request, false); rateLimit(request, 'ssh-ws', 60); } catch { return socket.close(1008); }
    firstMessage(socket, async ({ ticket }) => {
      const { sessionId } = takeTicket(ticket, 'ssh');
      track(socket, sessionId);
      if (socket.readyState !== 1) return;
      const channel = await openChannel('ssh');
      if (socket.readyState !== 1) return channel.destroy();
      socket.send(JSON.stringify({ type: 'ready' }));
      const stream = createWebSocketStream(socket);
      stream.on('error', () => {});
      couple(stream, channel);
      app.log.info('Remote SSH tunnel opened');
    });
  });
  app.get(`${base}/ws/desktop`, { websocket: true }, (socket, request) => {
    try { checkOrigin(request); getSession(request); rateLimit(request, 'desktop-ws', 15); } catch { return socket.close(1008); }
    let desktopSocket, localServer, localPeer, channel;
    const cleanup = () => { desktopSocket?.destroy(); localPeer?.destroy(); channel?.destroy(); localServer?.close(); };
    socket.once('close', cleanup);
    firstMessage(socket, async ({ ticket }) => {
      const credentials = takeTicket(ticket, 'desktop');
      // The ticket must belong to the browser's current session.
      if (credentials.sessionId !== getSession(request).id) throw fail('Invalid session');
      track(socket, credentials.sessionId);
      if (socket.readyState !== 1) return;
      try {
        channel = await openChannel('rdp');
        if (socket.readyState !== 1) return cleanup();
        localServer = net.createServer((peer) => {
          if (localPeer) return peer.destroy();
          localPeer = peer;
          localServer.close();
          couple(peer, channel);
        });
        localServer.maxConnections = 1;
        await new Promise((resolve, reject) => { localServer.once('error', reject); localServer.listen(0, '127.0.0.1', resolve); });
        if (socket.readyState !== 1) return cleanup();
        const send = (text) => {
          if (socket.readyState !== 1) return;
          if (socket.bufferedAmount > 8 * 1024 * 1024) return socket.close(1008, 'Client too slow');
          socket.send(text);
        };
        desktopSocket = await openDesktop({ guacdPort: config.guacdPort || 4822, rdpPort: localServer.address().port, ...credentials,
          onData: send, onSocket: (value) => { desktopSocket = value; } });
        credentials.password = '';
        if (socket.readyState !== 1) return cleanup();
        const input = new GuacParser(([opcode, ...args]) => {
          if (opcode === '') send(instruction('', ...args));
          else desktopSocket.write(instruction(opcode, ...args));
        });
        socket.on('message', (raw, binary) => {
          if (binary || raw.length > 65536 || desktopSocket.writableLength > 1024 * 1024) return socket.close(1008, 'Invalid desktop input');
          try { input.receive(raw.toString('utf8')); } catch { socket.close(1008, 'Invalid desktop input'); }
        });
        desktopSocket.once('close', () => socket.close(1000, 'Desktop closed'));
        desktopSocket.on('error', () => socket.close(1011, 'Desktop error'));
        app.log.info('Remote desktop opened');
      } catch {
        credentials.password = '';
        if (socket.readyState === 1) socket.send(instruction('error', '桌面连接失败，请检查本机服务或登录信息', 512));
        socket.close(1011, 'Desktop unavailable'); cleanup();
      }
    });
  });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, value] of challenges) if (value.expires <= now) challenges.delete(id);
    for (const [id, value] of tickets) if (value.expires <= now) tickets.delete(id);
    for (const [id, value] of limits) if (value.until <= now) limits.delete(id);
    for (const [id, value] of sessions) if (value.expires <= now) endSession(id);
    if (device) {
      if (!device.alive) { device.socket.terminate(); disconnectDevice(device); }
      else { device.alive = false; device.socket.ping(); persist(); }
    }
  }, config.heartbeatMs || 15000);
  heartbeat.unref();
  app.addHook('preClose', async () => {
    clearInterval(heartbeat);
    for (const id of sessions.keys()) endSession(id);
    if (device) { const state = device; disconnectDevice(state); state.socket.terminate(); }
    for (const socket of app.websocketServer.clients) socket.terminate();
    await persistPromise;
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.env.UMEKO_REMOTE_CONFIG || '/etc/umeko-remote/server.json';
  const config = JSON.parse(await readFile(path, 'utf8'));
  const app = await createRemoteServer(config);
  await app.listen({ port: config.port || 3101, host: '127.0.0.1' });
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => app.close().then(() => process.exit(0)));
}
