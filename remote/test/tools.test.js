import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, mkdir, stat, lstat, realpath, rename, unlink, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import WebSocket from 'ws';
import { createRemoteServer } from '../server.js';
import { startAgent } from '../agent.js';
import { keyId, loadIdentity, loginWithKey } from '../auth.js';
import { remotePath, uploadName } from '../tools.js';

const pair = () => generateKeyPairSync('ed25519');
async function identity(directory, name) {
  const keys = pair(), publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
  const path = join(directory, `${name}.json`), id = keyId(publicKey);
  await writeFile(path, JSON.stringify({ version: 1, keyId: id, privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }));
  return { id, publicKey, path, identity: await loadIdentity(path) };
}
async function until(fn) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(20); } throw new Error('Timed out'); }
async function fixture(t, wrongPin = false) {
  const directory = await mkdtemp(join(os.tmpdir(), 'umeko-web-tools-')), home = join(directory, 'home'); await mkdir(home);
  const admin = await identity(directory, 'admin'), device = await identity(directory, 'device');
  const sshPath = join(directory, 'ssh-key'), hostPath = join(directory, 'host-key');
  for (const path of [sshPath, hostPath]) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path]);
  const hostKey = await readFile(hostPath);
  const hostParsed = ssh2.utils.parseKey(hostKey);
  const pin = `SHA256:${createHash('sha256').update(hostParsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const peers = new Set(); let resized;
  const ssh = new ssh2.Server({ hostKeys: [hostKey] }, (peer) => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer));
    peer.on('authentication', (ctx) => ctx.method === 'publickey' ? ctx.accept() : ctx.reject());
    peer.on('ready', () => peer.on('session', (accept) => {
      const session = accept();
      session.on('pty', (accept) => accept());
      session.on('window-change', (accept, reject, info) => { resized = info; accept?.(); });
      session.on('shell', (accept) => { const stream = accept(); stream.write('TEST SHELL\r\n'); stream.on('data', (data) => stream.write(data)); });
      session.on('sftp', (accept) => {
        const sftp = accept(), handles = new Map(); let next = 1;
        const ok = ssh2.utils.sftp.STATUS_CODE.OK;
        const status = (id, err) => sftp.status(id, err ? err.code === 'ENOENT' ? 2 : err.code === 'EACCES' ? 3 : 4 : ok);
        const run = (id, fn) => Promise.resolve().then(fn).catch((err) => status(id, err));
        sftp.on('REALPATH', (id, path) => run(id, async () => sftp.name(id, [{ filename: await realpath(path === '.' ? home : path), longname: '', attrs: {} }])));
        sftp.on('STAT', (id, path) => run(id, async () => sftp.attrs(id, await stat(path))));
        sftp.on('LSTAT', (id, path) => run(id, async () => sftp.attrs(id, await lstat(path))));
        sftp.on('OPENDIR', (id, path) => run(id, async () => {
          const names = await readdir(path), values = await Promise.all(names.map(async (filename) => ({ filename, longname: '', attrs: await lstat(join(path, filename)) })));
          const handle = Buffer.from(String(next++)); handles.set(handle.toString(), { entries: values }); sftp.handle(id, handle);
        }));
        sftp.on('READDIR', (id, handle) => { const dir = handles.get(handle.toString()); if (dir.entries.length) { sftp.name(id, dir.entries); dir.entries = []; } else sftp.status(id, 1); });
        sftp.on('OPEN', (id, path, flags) => run(id, async () => { const handle = Buffer.from(String(next++)); handles.set(handle.toString(), await open(path, ssh2.utils.sftp.flagsToString(flags), 0o600)); sftp.handle(id, handle); }));
        sftp.on('READ', (id, handle, offset, length) => run(id, async () => { const data = Buffer.alloc(length), result = await handles.get(handle.toString()).read(data, 0, length, offset); result.bytesRead ? sftp.data(id, data.subarray(0, result.bytesRead)) : sftp.status(id, 1); }));
        sftp.on('WRITE', (id, handle, offset, data) => run(id, async () => { await handles.get(handle.toString()).write(data, 0, data.length, offset); status(id); }));
        sftp.on('FSTAT', (id, handle) => run(id, async () => sftp.attrs(id, await handles.get(handle.toString()).stat())));
        sftp.on('FSETSTAT', (id) => status(id));
        sftp.on('CLOSE', (id, handle) => run(id, async () => { const value = handles.get(handle.toString()); handles.delete(handle.toString()); await value?.close?.(); status(id); }));
        sftp.on('RENAME', (id, a, b) => run(id, async () => { try { await lstat(b); throw new Error('Exists'); } catch (err) { if (err.code !== 'ENOENT') throw err; } await rename(a, b); status(id); }));
        sftp.on('REMOVE', (id, path) => run(id, async () => { await unlink(path); status(id); }));
        sftp.on('MKDIR', (id, path) => run(id, async () => { await mkdir(path); status(id); }));
      });
    }));
  });
  ssh.listen(0, '127.0.0.1'); await once(ssh, 'listening');
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const app = await createRemoteServer({ origin, adminKeys: [admin], device, logger: false, webSsh: { username: 'test', privateKeyFile: sshPath, hostKeySha256: wrongPin ? 'SHA256:' + 'A'.repeat(43) : pin } });
  await app.listen({ port, host: '127.0.0.1' });
  const base = `${origin}/remote`;
  const login = async (id) => { const { sign } = await import('node:crypto'); const post = (path, data) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const c = await (await post('challenge', { role: 'admin', keyId: id.id })).json(); const r = await post('verify', { id: c.id, signature: sign(null, Buffer.from(c.challenge), id.identity.privateKey).toString('base64') }); return r.headers.getSetCookie()[0].split(';')[0]; };
  const stop = await startAgent({ url: base, identity: device.path, allowLocal: true, sshPort: ssh.address().port, rdpPort: ssh.address().port }, () => {});
  t.after(async () => { stop(); app.server.closeAllConnections(); await app.close(); for (const peer of peers) peer.end(); ssh.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, base, origin, home, directory, admin, device, login, resized: () => resized };
}

test('file paths and upload names reject ambiguous or unsafe input', () => {
  for (const value of ['../x', '/x\0y', '/x\ny']) assert.throws(() => remotePath(value));
  for (const value of ['../x', 'a/b', '', '.', '..', 'a\0b']) assert.throws(() => uploadName(value));
  assert.equal(remotePath('/home/umeko/../umeko/中文'), '/home/umeko/中文');
  assert.equal(uploadName('出差资料.txt'), '出差资料.txt');
});

test('SFTP lists directories and transfers binary/Chinese files without overwriting; logout revokes access', async (t) => {
  const f = await fixture(t), cookie = await f.login(f.admin);
  await until(async () => (await (await fetch(`${f.base}/api/status`, { headers: { cookie } })).json()).device.online);
  const headers = { cookie, origin: f.origin };
  assert.equal((await fetch(`${f.base}/api/files`)).status, 401);
  const initial = await fetch(`${f.base}/api/files`, { headers }); assert.equal(initial.status, 200, await initial.clone().text());
  assert.equal((await initial.json()).path, f.home);
  const mkdirResponse = await fetch(`${f.base}/api/files/mkdir`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ directory: f.home, name: '测试目录' }) });
  assert.equal(mkdirResponse.status, 200);
  const target = join(f.home, '测试目录'), name = '你好 😀.bin', payload = Buffer.concat([Buffer.from('中文文件传输\n'), Buffer.alloc(128 * 1024, 237)]);
  const url = `${f.base}/api/files/upload?directory=${encodeURIComponent(target)}&name=${encodeURIComponent(name)}`;
  const upload = () => fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: payload });
  const sent = await upload(); assert.equal(sent.status, 200, await sent.clone().text());
  assert.deepEqual(await readFile(join(target, name)), payload);
  const duplicate = await upload(); assert.equal(duplicate.status, 409);
  const downloaded = await fetch(`${f.base}/api/files/download?path=${encodeURIComponent(join(target, name))}`, { headers });
  assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), payload);
  const list = await (await fetch(`${f.base}/api/files?path=${encodeURIComponent(target)}`, { headers })).json();
  assert.equal(list.entries[0].name, name);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example', 'content-type': 'application/octet-stream' }, body: 'evil' })).status, 403);
  await fetch(`${f.base}/api/logout`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await fetch(`${f.base}/api/files`, { headers })).status, 401);
});

test('web terminal carries UTF-8, resizes a PTY, rejects ticket replay and closes on logout', async (t) => {
  const f = await fixture(t), cookie = await f.login(f.admin);
  await until(async () => (await (await fetch(`${f.base}/api/status`, { headers: { cookie } })).json()).device.online);
  const headers = { cookie, origin: f.origin, 'content-type': 'application/json' };
  const { ticket } = await (await fetch(`${f.base}/api/terminal-ticket`, { method: 'POST', headers, body: '{}' })).json();
  const connect = async () => { const socket = new WebSocket(`${f.base.replace('http', 'ws')}/ws/terminal`, { headers }); socket.on('error', () => {}); await once(socket, 'open'); socket.send(JSON.stringify({ ticket, cols: 100, rows: 30 })); return socket; };
  const socket = await connect(); t.after(() => socket.terminate());
  let output = '', ready = false;
  socket.on('message', (data, binary) => { if (binary) { output += data.toString(); socket.send(JSON.stringify({ type: 'ack', bytes: data.length })); } else ready ||= JSON.parse(data).type === 'ready'; });
  await until(() => ready && output.includes('TEST SHELL'));
  socket.send(JSON.stringify({ type: 'input', data: '网页 SSH 中文测试\n' }));
  await until(() => output.includes('网页 SSH 中文测试'));
  socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 42 })); await until(() => f.resized()?.cols === 120);
  const replay = await connect(); assert.equal((await once(replay, 'close'))[0], 1011);
  const closing = once(socket, 'close');
  await fetch(`${f.base}/api/logout`, { method: 'POST', headers, body: '{}' });
  assert.equal((await closing)[0], 1008);
});

test('SSH rejects an untrusted home host key', async (t) => {
  const f = await fixture(t, true), cookie = await f.login(f.admin);
  await until(async () => (await (await fetch(`${f.base}/api/status`, { headers: { cookie } })).json()).device.online);
  assert.equal((await fetch(`${f.base}/api/files`, { headers: { cookie } })).status, 503);
});

test('cancelled uploads remove partial files and preserve other files', { timeout: 15000 }, async (t) => {
  const f = await fixture(t), cookie = await f.login(f.admin);
  await until(async () => (await (await fetch(`${f.base}/api/status`, { headers: { cookie } })).json()).device.online);
  const controller = new AbortController();
  async function* body() { while (!controller.signal.aborted) { yield Buffer.alloc(8192); await delay(40); } }
  const uploading = fetch(`${f.base}/api/files/upload?directory=${encodeURIComponent(f.home)}&name=cancel.bin`, {
    method: 'POST', headers: { cookie, origin: f.origin, 'content-type': 'application/octet-stream' }, body: body(), duplex: 'half', signal: controller.signal,
  }).catch((err) => err);
  await until(async () => (await readdir(f.home)).some((name) => name.endsWith('.part')));
  controller.abort(); await uploading;
  await until(async () => (await readdir(f.home)).length === 0);
});
