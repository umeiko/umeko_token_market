import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ssh2 from 'ssh2';
import { randomToken } from './auth.js';

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const MAX_UPLOAD = 2 * 1024 ** 3;
export function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\0\r\n]/.test(value)) throw error('请输入有效的绝对路径');
  return posix.normalize(value);
}
export function uploadName(value) {
  if (typeof value !== 'string' || !value || ['.', '..'].includes(value) || /[\/\0\r\n]/.test(value) || Buffer.byteLength(value) > 240) throw error('文件名不正确');
  return value;
}
function fileError(err) {
  if (err.statusCode) return err;
  if (err.code === 2 || err.code === 'ENOENT') return error('文件或目录不存在', 404);
  if (err.code === 3 || err.code === 'EACCES') return error('当前系统用户没有访问权限', 403);
  return error('文件操作失败，请检查目录权限或连接状态', 409);
}
const call = (object, name, ...args) => new Promise((resolve, reject) => {
  if (object.destroyed || object.writableEnded) return reject(error('SSH 文件连接已断开', 503));
  const timer = setTimeout(() => done(error('文件操作超时', 504)), 20000);
  const closed = () => done(error('SSH 文件连接已断开', 503));
  const done = (err, value) => { clearTimeout(timer); object.off('close', closed); err ? reject(err) : resolve(value); };
  object.once('close', closed);
  try { object[name](...args, done); } catch (err) { done(err); }
});

// SSH is carried by the existing outbound connector; no new listening ports.
// The dedicated credential and pinned home host key stay on the cloud server.
export async function registerRemoteTools(context) {
  const { app, base, config, getSession, checkOrigin, rateLimit, openChannel, issueTicket, takeTicket, track, firstMessage } = context;
  const setting = config.webSsh;
  const enabled = !!setting;
  const privateKey = enabled ? await readFile(setting.privateKeyFile) : null;
  if (enabled && (!setting.username || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(setting.hostKeySha256 || ''))) throw new Error('Web SSH requires a username and pinned SHA256 host key');
  const connections = new Map();
  function endSession(id) {
    const state = connections.get(id);
    if (state) { connections.delete(id); state.client.destroy(); state.channel?.destroy(); }
  }
  async function connection(id) {
    if (!enabled) throw error('此主机尚未配置网页 SSH 和文件管理', 409);
    if (connections.has(id)) return connections.get(id).ready;
    const client = new ssh2.Client();
    const state = { client, channel: null, ready: null };
    connections.set(id, state);
    const closed = () => { if (connections.get(id) === state) connections.delete(id); state.channel?.destroy(); };
    client.on('error', () => {});
    client.once('close', closed);
    state.ready = (async () => {
      try {
        state.channel = await openChannel('ssh');
        if (connections.get(id) !== state) { state.channel.destroy(); throw error('登录已结束', 401); }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(error('SSH 连接超时', 504)), 20000);
          const done = (err) => { clearTimeout(timer); client.off('error', failed); client.off('close', failed); err ? reject(error('SSH 验证失败，请检查本机连接或专用密钥', 503)) : resolve(); };
          const failed = () => done(true);
          client.once('ready', () => done()); client.once('error', failed); client.once('close', failed);
          client.connect({ sock: state.channel, username: setting.username, privateKey,
            algorithms: { serverHostKey: ['ssh-ed25519'] },
            hostVerifier: (key) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === setting.hostKeySha256,
            keepaliveInterval: 15000, keepaliveCountMax: 3, readyTimeout: 15000 });
        });
        const sftp = await call(client, 'sftp');
        return { client, sftp };
      } catch (err) { if (connections.get(id) === state) endSession(id); throw err; }
    })();
    return state.ready;
  }
  async function withFiles(request, fn) {
    const { id } = getSession(request);
    rateLimit(request, 'files', 180);
    try { const { sftp } = await connection(id); return await fn(sftp); }
    catch (err) { throw fileError(err); }
  }
  app.get(`${base}/api/files`, async (request) => withFiles(request, async (sftp) => {
    const path = request.query.path ? remotePath(request.query.path) : await call(sftp, 'realpath', '.');
    const canonical = await call(sftp, 'realpath', path);
    const entries = await call(sftp, 'readdir', canonical);
    return { path: canonical, parent: posix.dirname(canonical), username: setting.username,
      entries: entries.filter((e) => !['.', '..'].includes(e.filename)).slice(0, 10000).map(({ filename, attrs }) => ({
        name: filename, directory: attrs.isDirectory(), symlink: attrs.isSymbolicLink(), size: attrs.size, modified: attrs.mtime * 1000,
      })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN')), truncated: entries.length > 10000 };
  }));
  app.post(`${base}/api/files/mkdir`, async (request) => withFiles(request, async (sftp) => {
    const directory = await call(sftp, 'realpath', remotePath(request.body?.directory));
    await call(sftp, 'mkdir', posix.join(directory, uploadName(request.body?.name)), { mode: 0o755 });
    return { ok: true };
  }));
  app.get(`${base}/api/files/download`, async (request, reply) => withFiles(request, async (sftp) => {
    const path = remotePath(request.query.path);
    const stats = await call(sftp, 'stat', path);
    if (!stats.isFile()) throw error('只能下载普通文件');
    const stream = sftp.createReadStream(path);
    reply.raw.once('close', () => stream.destroy());
    reply.type('application/octet-stream').header('Content-Length', String(stats.size))
      .header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(posix.basename(path)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`);
    return reply.send(stream);
  }));
  app.addContentTypeParser('application/octet-stream', (request, payload, done) => done(null, payload));
  app.post(`${base}/api/files/upload`, { bodyLimit: MAX_UPLOAD }, async (request, reply) => withFiles(request, async (sftp) => {
    const directory = await call(sftp, 'realpath', remotePath(request.query.directory));
    const name = uploadName(request.query.name), target = posix.join(directory, name);
    try { await call(sftp, 'lstat', target); throw error('同名文件已存在，请修改文件名后上传', 409); }
    catch (err) { if (err.code !== 2 && err.code !== 'ENOENT') throw err; }
    const temporary = posix.join(directory, `.umeko-upload-${randomToken()}.part`);
    let bytes = 0, stream;
    try {
      stream = sftp.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      const abort = () => { if (!reply.raw.writableFinished) stream.destroy(new Error('Upload cancelled')); };
      request.raw.once('aborted', abort); reply.raw.once('close', abort);
      const limit = new Transform({ transform(chunk, encoding, done) {
        bytes += chunk.length;
        done(bytes > MAX_UPLOAD ? error('单个文件最大支持 2 GiB', 413) : null, chunk);
      } });
      try { await pipeline(request.body, limit, stream); }
      finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
      // SFTP v3 rename refuses an existing target, including a concurrent upload.
      await call(sftp, 'rename', temporary, target);
      return { ok: true, name, bytes };
    } catch (err) { stream?.destroy(); await call(sftp, 'unlink', temporary).catch(() => {}); throw err; }
  }));
  app.post(`${base}/api/terminal-ticket`, async (request) => {
    const session = getSession(request); rateLimit(request, 'terminal', 20);
    if (!enabled) throw error('尚未配置网页 SSH', 409);
    return { ticket: issueTicket({ role: 'terminal', sessionId: session.id }) };
  });
  app.get(`${base}/ws/terminal`, { websocket: true }, (socket, request) => {
    try { checkOrigin(request); getSession(request); rateLimit(request, 'terminal-ws', 30); } catch { return socket.close(1008); }
    let shell, closed = false, outstanding = 0;
    socket.once('close', () => { closed = true; shell?.destroy(); });
    firstMessage(socket, async ({ ticket, cols, rows }) => {
      try {
        const credentials = takeTicket(ticket, 'terminal');
        if (credentials.sessionId !== getSession(request).id) throw error('Invalid session', 401);
        track(socket, credentials.sessionId);
        const { client } = await connection(credentials.sessionId);
        if (closed) return;
        const dimension = (n, fallback) => Number.isInteger(n) ? Math.min(500, Math.max(2, n)) : fallback;
        shell = await new Promise((resolve, reject) => client.shell({ term: 'xterm-256color', cols: dimension(cols, 100), rows: dimension(rows, 30) }, (err, stream) => err ? reject(err) : resolve(stream)));
        if (closed) return shell.destroy();
        socket.send(JSON.stringify({ type: 'ready', username: setting.username }));
        const send = (data) => {
          if (socket.readyState !== 1) return;
          outstanding += data.length;
          if (outstanding > 65536) shell.pause();
          if (socket.bufferedAmount > 4 * 1024 ** 2) return socket.close(1008, 'Terminal too slow');
          socket.send(data, { binary: true });
        };
        shell.on('data', send); shell.stderr.on('data', send);
        shell.on('error', () => socket.close(1011, 'SSH channel error'));
        shell.once('close', () => socket.close(1000, 'SSH session ended'));
        socket.on('message', (raw, binary) => {
          try {
            if (binary || raw.length > 65536) throw error('Invalid terminal input');
            const message = JSON.parse(raw.toString());
            if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 16384) {
              if (shell.writableLength > 1024 * 1024) throw error('Input too fast');
              shell.write(message.data);
            } else if (message.type === 'resize') shell.setWindow(dimension(message.rows, 30), dimension(message.cols, 100), 0, 0);
            else if (message.type === 'ack' && Number.isInteger(message.bytes) && message.bytes > 0 && message.bytes <= outstanding) {
              outstanding -= message.bytes; if (outstanding < 32768) shell.resume();
            } else throw error('Invalid terminal message');
          } catch { socket.close(1008, 'Invalid terminal input'); }
        });
      } catch { if (socket.readyState === 1) { socket.send(JSON.stringify({ type: 'error', message: 'SSH 连接失败，请检查本机连接器和 SSH 服务' })); socket.close(1011); } }
    });
  });
  return { enabled, endSession, close() { for (const id of connections.keys()) endSession(id); } };
}
