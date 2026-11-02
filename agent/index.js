import WebSocket from 'ws';

const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
const cloud = argument('cloud') || process.env.CLOUD_URL;
const providerId = Number(argument('provider') || process.env.PROVIDER_ID);
const token = argument('token') || process.env.PROVIDER_TOKEN;
const localBase = (argument('local') || process.env.LOCAL_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const localKey = process.env.LOCAL_API_KEY || '';

if (!cloud || !providerId || !token) {
  console.error('Required: CLOUD_URL, PROVIDER_ID and PROVIDER_TOKEN (or --cloud, --provider, --token)');
  process.exit(1);
}
const endpoint = `${cloud.replace(/^http/, 'ws').replace(/\/$/, '')}/agent/connect`;
const active = new Map();
let socket;
let reconnectDelay = 1000;
let healthTimer;
let stopped = false;

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

async function localHealth() {
  const started = Date.now();
  try {
    const response = await fetch(`${localBase}/v1/models`, {
      headers: localKey ? { authorization: `Bearer ${localKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    send({ type: 'health', online: response.ok, latency: Date.now() - started, message: response.ok ? '' : `推理服务返回 HTTP ${response.status}` });
  } catch (error) {
    send({ type: 'health', online: false, latency: Date.now() - started, message: `无法连接本地推理服务：${error.message}` });
  }
}

async function forward(message) {
  const controller = new AbortController();
  active.set(message.id, controller);
  try {
    const headers = {
      'content-type': message.headers?.['content-type'] || 'application/json',
      accept: message.headers?.accept || '*/*',
    };
    if (localKey) headers.authorization = `Bearer ${localKey}`;
    const response = await fetch(`${localBase}${message.path}`, {
      method: message.method,
      headers,
      body: message.body ? Buffer.from(message.body, 'base64') : undefined,
      signal: controller.signal,
    });
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)) responseHeaders[key] = value;
    });
    if (!send({ type: 'response', id: message.id, status: response.status, headers: responseHeaders })) {
      controller.abort();
      return;
    }
    if (!response.body) {
      send({ type: 'end', id: message.id });
      return;
    }
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      while (socket?.bufferedAmount > 4 * 1024 * 1024) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!send({ type: 'chunk', id: message.id, data: Buffer.from(value).toString('base64') })) {
        controller.abort();
        return;
      }
    }
    send({ type: 'end', id: message.id });
  } catch (error) {
    if (error.name !== 'AbortError') send({ type: 'error', id: message.id, message: `本地转发失败：${error.message}` });
  } finally {
    active.delete(message.id);
  }
}

function connect() {
  if (stopped) return;
  socket = new WebSocket(endpoint, { maxPayload: 24 * 1024 * 1024 });
  socket.on('open', () => {
    reconnectDelay = 1000;
    console.log(`Connected to ${cloud}; authenticating provider ${providerId}…`);
    send({ type: 'auth', providerId, token });
  });
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'auth_ok') {
      console.log(`Provider "${message.provider}" is online. Forwarding to ${localBase}`);
      localHealth();
      clearInterval(healthTimer);
      healthTimer = setInterval(localHealth, 15000);
    } else if (message.type === 'request') {
      forward(message);
    } else if (message.type === 'cancel') {
      active.get(message.id)?.abort();
      active.delete(message.id);
    }
  });
  socket.on('close', (code, reason) => {
    clearInterval(healthTimer);
    for (const controller of active.values()) controller.abort();
    active.clear();
    if (stopped) return;
    console.log(`Cloud connection closed (${code}${reason.length ? `: ${reason}` : ''}). Reconnecting in ${reconnectDelay / 1000}s…`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(30000, reconnectDelay * 2);
  });
  socket.on('error', (error) => console.error(`Cloud connection error: ${error.message}`));
}

function shutdown() {
  stopped = true;
  clearInterval(healthTimer);
  for (const controller of active.values()) controller.abort();
  socket?.close(1000, 'Agent shutdown');
  setTimeout(() => process.exit(0), 250).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
connect();
