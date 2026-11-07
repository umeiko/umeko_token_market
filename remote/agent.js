import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import net from 'node:net';
import { pipeline } from 'node:stream';
import WebSocket, { createWebSocketStream } from 'ws';
import { loadIdentity, loginWithKey } from './auth.js';

export function validateBase(value, allowLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('连接地址不能包含凭据、参数或片段');
  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('连接器必须使用 HTTPS/WSS');
  return url.href.replace(/\/+$/, '');
}
const probe = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  let done = false;
  const finish = (result) => { if (!done) { done = true; socket.destroy(); resolve(result); } };
  socket.setTimeout(1500, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

export async function startAgent(config, log = (value) => console.log(JSON.stringify(value))) {
  const base = validateBase(config.url, config.allowLocal === true);
  const identity = await loadIdentity(config.identity);
  const wsBase = base.replace(/^http/, 'ws');
  const ports = { ssh: config.sshPort || 22, rdp: config.rdpPort || 3389 };
  for (const port of Object.values(ports)) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效的本机端口');
  let stopped = false, control = null, reconnect = null, statusTimer = null, watchdog = null, attempts = 0;
  const active = new Set();
  const report = (state, message) => log({ state, message, time: new Date().toISOString() });
  const sendStatus = async (socket) => {
    const [ssh, rdp] = await Promise.all([probe(ports.ssh), probe(ports.rdp)]);
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
      type: 'status', hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`,
      uptime: Math.round(os.uptime()), ssh, rdp,
    }));
  };
  function openChannel(message, parent) {
    if (parent !== control || !Object.hasOwn(ports, message.service) || active.size >= 12) return;
    const data = new WebSocket(`${wsBase}/ws/channel`, { maxPayload: 1024 * 1024, handshakeTimeout: 12000, perMessageDeflate: false });
    active.add(data);
    let tcp, stream;
    const timer = setTimeout(() => data.terminate(), 15000);
    const cleanup = () => { clearTimeout(timer); tcp?.destroy(); stream?.destroy(); active.delete(data); };
    data.on('error', () => {});
    data.once('close', cleanup);
    data.once('open', () => data.send(JSON.stringify({ id: message.id, token: message.token })));
    data.once('message', (raw, binary) => {
      try { if (binary || JSON.parse(raw.toString()).type !== 'ready') throw new Error(); }
      catch { return data.terminate(); }
      clearTimeout(timer);
      tcp = net.connect({ host: '127.0.0.1', port: ports[message.service] });
      tcp.setTimeout(15000, () => tcp.destroy());
      tcp.once('connect', () => tcp.setTimeout(0));
      stream = createWebSocketStream(data);
      stream.on('error', () => {});
      pipeline(tcp, stream, () => data.terminate());
      pipeline(stream, tcp, () => tcp.destroy());
    });
  }
  async function connect() {
    if (stopped) return;
    report('connecting', '正在安全连接 umekolab.cn…');
    try {
      const { ticket } = await loginWithKey(base, identity, 'device');
      if (stopped) return;
      const socket = new WebSocket(`${wsBase}/ws/device`, { maxPayload: 16384, handshakeTimeout: 15000, perMessageDeflate: false });
      control = socket;
      let lastPing = Date.now();
      const handshake = setTimeout(() => socket.terminate(), 20000);
      socket.once('open', () => socket.send(JSON.stringify({ ticket })));
      socket.on('error', () => {});
      socket.on('ping', () => { lastPing = Date.now(); });
      socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return socket.terminate(); }
        if (message.type === 'ready') {
          clearTimeout(handshake); attempts = 0;
          report('online', '本机已连接到私人远程工作台');
          sendStatus(socket).catch(() => {});
          statusTimer = setInterval(() => sendStatus(socket).catch(() => {}), 10000);
          watchdog = setInterval(() => { if (Date.now() - lastPing > 45000) socket.terminate(); }, 10000);
        } else if (message.type === 'open') openChannel(message, socket);
      });
      socket.once('close', () => {
        clearTimeout(handshake); clearInterval(statusTimer); clearInterval(watchdog);
        for (const channel of active) channel.terminate();
        control = null;
        if (!stopped) schedule();
      });
    } catch { if (!stopped) schedule(); }
  }
  function schedule() {
    const delay = Math.min(30000, 2000 * 2 ** Math.min(attempts++, 4)) + Math.random() * 1000;
    report('offline', `连接已断开，${Math.ceil(delay / 1000)} 秒后自动重连`);
    reconnect = setTimeout(connect, delay);
  }
  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnect); clearInterval(statusTimer); clearInterval(watchdog);
    control?.terminate();
    for (const channel of active) channel.terminate();
    report('stopped', '远程连接已关闭');
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('用法：node remote/agent.js <连接器配置文件>');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.identity.startsWith('/')) config.identity = resolve(dirname(configPath), config.identity);
  const stop = await startAgent(config);
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { stop(); setTimeout(() => process.exit(0), 100).unref(); });
}
