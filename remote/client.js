#!/usr/bin/env node
// Standalone travel-side SSH bridge. Node.js >=22; no npm dependencies.
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { once } from 'node:events';

export async function openSshTunnel({ url, identity: identityPath, port = 2222, allowLocal = false, log = console.log }) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('无效的站点地址');
  if (parsed.protocol !== 'https:' && !(allowLocal && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) throw new Error('请使用 HTTPS 地址');
  const base = parsed.href.replace(/\/+$/, '');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  if (identity.version !== 1) throw new Error('无效的 Umeko 密钥文件');
  const privateKey = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), type: 'pkcs8', format: 'der' });
  const api = async (path, body, cookie) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: parsed.origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`远程验证失败 (${response.status})`);
    return response;
  };
  const { id, challenge } = await (await api('/api/challenge', { role: 'admin', keyId: identity.keyId })).json();
  const response = await api('/api/verify', { id, signature: sign(null, Buffer.from(challenge), privateKey).toString('base64') });
  const { expires } = await response.json();
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  if (!cookie) throw new Error('没有收到安全会话');
  const connections = new Set();
  const server = net.createServer({ pauseOnConnect: true }, (tcp) => {
    tcp.setKeepAlive(true, 15000);
    let ws;
    const cleanup = () => { tcp.destroy(); ws?.close(); connections.delete(tcp); };
    tcp.on('error', cleanup);
    tcp.once('close', () => { ws?.close(); connections.delete(tcp); });
    connections.add(tcp);
    (async () => {
      const { ticket } = await (await api('/api/ssh-ticket', {}, cookie)).json();
      if (tcp.destroyed) return;
      ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/ssh`);
      ws.binaryType = 'arraybuffer';
      const timeout = setTimeout(() => { cleanup(); }, 15000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ ticket })), { once: true });
      let ready = false;
      let queuedBytes = 0;
      let incoming = Promise.resolve();
      ws.addEventListener('message', (event) => {
        queuedBytes += typeof event.data === 'string' ? event.data.length : event.data.byteLength;
        if (queuedBytes > 8 * 1024 * 1024) return cleanup();
        incoming = incoming.then(async () => {
          queuedBytes -= typeof event.data === 'string' ? event.data.length : event.data.byteLength;
          if (!ready) {
            if (typeof event.data !== 'string' || JSON.parse(event.data).type !== 'ready') throw new Error('隧道握手失败');
            ready = true; clearTimeout(timeout);
            tcp.on('data', (data) => {
              if (ws.readyState !== WebSocket.OPEN) return cleanup();
              ws.send(data);
              if (ws.bufferedAmount > 1024 * 1024) {
                tcp.pause();
                const drain = setInterval(() => {
                  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < 65536) { clearInterval(drain); if (!tcp.destroyed) tcp.resume(); }
                }, 20);
                drain.unref();
              }
            });
            tcp.resume();
            return;
          }
          if (typeof event.data === 'string') throw new Error('无效的隧道数据');
          if (!tcp.write(Buffer.from(event.data))) await once(tcp, 'drain');
        }).catch(cleanup);
      });
      ws.addEventListener('error', () => { clearTimeout(timeout); cleanup(); });
      ws.addEventListener('close', () => { clearTimeout(timeout); cleanup(); });
    })().catch((error) => { log(error.message); cleanup(); });
  });
  const listening = new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), '127.0.0.1', resolve); });
  await listening;
  log(`SSH 隧道已就绪：ssh -p ${server.address().port} -o HostKeyAlias=umeko-home umeko@127.0.0.1`);
  log('保留此窗口；关闭窗口即关闭隧道。仍需使用家中电脑的 SSH 密钥或密码。');
  const stop = async () => {
    clearTimeout(expiry);
    for (const tcp of connections) tcp.destroy();
    await new Promise((resolve) => server.close(resolve));
    await api('/api/logout', {}, cookie).catch(() => {});
  };
  const expiry = setTimeout(() => { log('密钥会话已到期，请重新启动隧道'); stop(); }, Math.max(0, expires - Date.now()));
  expiry.unref();
  return { server, stop };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
  if (!option('--identity')) {
    console.log('用法：node umeko-remote.mjs --identity /path/admin.umeko-key [--url https://umekolab.cn/remote] [--port 2222]');
    process.exit(1);
  }
  try {
    const { stop } = await openSshTunnel({ url: option('--url', 'https://umekolab.cn/remote'), identity: option('--identity'), port: option('--port', 2222) });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop().then(() => process.exit(0)));
  } catch (error) { console.error(error.message); process.exit(1); }
}
