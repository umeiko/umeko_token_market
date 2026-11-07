import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createRemoteServer } from '../server.js';
import { keyId, loadIdentity, loginWithKey } from '../auth.js';
import { startAgent } from '../agent.js';
import { openSshTunnel } from '../client.js';
import { GuacParser, instruction } from '../guacamole.js';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function until(check) { for (let n = 0; n < 100; n++) { if (await check()) return; await delay(20); } throw new Error('Condition timed out'); }
async function key(directory, role) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const id = keyId(publicKey), path = `${directory}/${role}.umeko-key`;
  await writeFile(path, JSON.stringify({ version: 1, keyId: id, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }), { mode: 0o600 });
  return { id, publicKey, path, identity: await loadIdentity(path) };
}
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(`${os.tmpdir()}/umeko-remote-test-`);
  const admin = await key(directory, 'admin'), device = await key(directory, 'device');
  const reservation = net.createServer(), port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`, base = `${origin}/remote`;
  const app = await createRemoteServer({ origin, adminKeys: [admin], device, logger: false, heartbeatMs: 100, ...extra });
  await app.listen({ port, host: '127.0.0.1' });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const post = (path, data, cookie, customOrigin = origin) => fetch(`${base}/api/${path}`, {
    method: 'POST', headers: { origin: customOrigin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(data),
  });
  const status = (cookie) => fetch(`${base}/api/status`, { headers: cookie ? { cookie } : {} });
  return { directory, app, origin, base, post, status, admin, device };
}

test('key authentication rejects cross-origin access, wrong keys, replay and role confusion', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.status()).status, 401);
  assert.equal((await f.post('challenge', { role: 'admin', keyId: f.admin.id }, null, 'https://evil.example')).status, 403);
  const challenge = await (await f.post('challenge', { role: 'admin', keyId: f.admin.id })).json();
  const signature = sign(null, Buffer.from(challenge.challenge), f.admin.identity.privateKey).toString('base64');
  const accepted = await f.post('verify', { id: challenge.id, signature });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.getSetCookie()[0], /HttpOnly.*SameSite=Strict/i);
  assert.equal((await f.post('verify', { id: challenge.id, signature })).status, 401);
  const invalid = await (await f.post('challenge', { role: 'admin', keyId: f.admin.id })).json();
  const wrong = sign(null, Buffer.from(invalid.challenge), f.device.identity.privateKey).toString('base64');
  assert.equal((await f.post('verify', { id: invalid.id, signature: wrong })).status, 401);
  const confused = await (await f.post('challenge', { role: 'admin', keyId: f.device.id })).json();
  assert.equal((await f.post('verify', { id: confused.id, signature: sign(null, Buffer.from(confused.challenge), f.device.identity.privateKey).toString('base64') })).status, 401);
  const { cookie } = await loginWithKey(f.base, f.admin.identity);
  assert.equal((await f.status(cookie)).status, 200);
  await f.post('logout', {}, cookie);
  assert.equal((await f.status(cookie)).status, 401);
});

test('connector status, native SSH traffic and disconnect cleanup work through outbound WSS channels', async (t) => {
  const f = await fixture(t);
  const echo = net.createServer((socket) => { socket.on('error', () => {}); socket.write('SSH-2.0-test\r\n'); socket.pipe(socket); });
  const sshPort = await listen(echo);
  t.after(() => new Promise((resolve) => echo.close(resolve)));
  const stopAgent = await startAgent({ url: f.base, identity: f.device.path, allowLocal: true, sshPort, rdpPort: sshPort }, () => {});
  t.after(stopAgent);
  const { cookie } = await loginWithKey(f.base, f.admin.identity);
  await until(async () => (await (await f.status(cookie)).json()).device.status?.ssh);
  const tunnel = await openSshTunnel({ url: f.base, identity: f.admin.path, allowLocal: true, port: 0, log: () => {} });
  t.after(() => tunnel.stop());
  const client = net.connect({ port: tunnel.server.address().port, host: '127.0.0.1' });
  let received = '';
  client.on('data', (chunk) => { received += chunk.toString(); });
  client.on('error', () => {});
  t.after(() => client.destroy());
  await until(() => received.includes('SSH-2.0-test'));
  client.write('remote-echo-test\n');
  await until(() => received.includes('remote-echo-test'));
  const closed = once(client, 'close');
  stopAgent();
  await closed;
  await until(async () => !(await (await f.status(cookie)).json()).device.online);
  assert.equal((await f.post('ssh-ticket', {}, cookie)).status, 409);
});

test('one-time SSH tickets cannot be replayed and logout closes active tunnels', async (t) => {
  const f = await fixture(t);
  const echo = net.createServer((socket) => socket.pipe(socket));
  const port = await listen(echo);
  t.after(() => new Promise((resolve) => echo.close(resolve)));
  const stop = await startAgent({ url: f.base, identity: f.device.path, allowLocal: true, sshPort: port, rdpPort: port }, () => {});
  t.after(stop);
  const { cookie } = await loginWithKey(f.base, f.admin.identity);
  await until(async () => (await (await f.status(cookie)).json()).device.online);
  const { ticket } = await (await f.post('ssh-ticket', {}, cookie)).json();
  const connect = async () => { const ws = new WebSocket(`${f.base.replace('http', 'ws')}/ws/ssh`); await once(ws, 'open'); ws.send(JSON.stringify({ ticket })); return ws; };
  const first = await connect();
  t.after(() => first.terminate());
  const [message] = await once(first, 'message');
  assert.equal(JSON.parse(message).type, 'ready');
  const replay = await connect();
  const [code] = await once(replay, 'close');
  assert.equal(code, 1008);
  const closed = once(first, 'close');
  await f.post('logout', {}, cookie);
  assert.equal((await closed)[0], 1008);
});

test('desktop performs guacd handshake, relays the RDP port and handles internal pings locally', async (t) => {
  const peers = new Set();
  let rdpData = '', keyData = '', portFromHandshake;
  const rdp = net.createServer((peer) => { peers.add(peer); peer.on('close', () => peers.delete(peer)); peer.on('data', (data) => { rdpData += data; }); });
  const rdpPort = await listen(rdp);
  const guacd = net.createServer((socket) => {
    peers.add(socket); socket.on('close', () => peers.delete(socket));
    const parser = new GuacParser(([opcode, ...args]) => {
      if (opcode === 'select') socket.write(instruction('args', 'VERSION_1_5_0', 'hostname', 'port', 'username', 'password'));
      if (opcode === 'connect') {
        assert.equal(args[0], 'VERSION_1_5_0'); assert.equal(args[1], '127.0.0.1');
        portFromHandshake = Number(args[2]);
        const peer = net.connect({ host: '127.0.0.1', port: portFromHandshake });
        peers.add(peer); peer.on('close', () => peers.delete(peer));
        peer.once('connect', () => { peer.write('RDP-TEST'); socket.write(instruction('ready', 'test-uuid') + instruction('size', 0, 1024, 768)); });
      }
      if (opcode === 'key') keyData = args.join(',');
      assert.notEqual(opcode, '', 'internal pings must never reach guacd');
    });
    socket.on('data', (data) => parser.receive(data.toString()));
  });
  const guacdPort = await listen(guacd);
  const f = await fixture(t, { guacdPort });
  t.after(() => { for (const peer of peers) peer.destroy(); rdp.close(); guacd.close(); });
  const stop = await startAgent({ url: f.base, identity: f.device.path, allowLocal: true, sshPort: rdpPort, rdpPort }, () => {});
  t.after(stop);
  const { cookie } = await loginWithKey(f.base, f.admin.identity);
  await until(async () => (await (await f.status(cookie)).json()).device.online);
  const { ticket } = await (await f.post('desktop-ticket', { username: 'umeko', password: '', width: 1024, height: 768 }, cookie)).json();
  const socket = new WebSocket(`${f.base.replace('http', 'ws')}/ws/desktop`, { headers: { cookie, origin: f.origin } });
  t.after(() => socket.terminate());
  let output = '';
  socket.on('message', (data) => { output += data; });
  await once(socket, 'open'); socket.send(JSON.stringify({ ticket }));
  await until(() => output.includes('test-uuid') && rdpData === 'RDP-TEST');
  assert.ok(portFromHandshake > 0);
  socket.send(instruction('', 'ping', '12345'));
  await until(() => output.includes(instruction('', 'ping', '12345')));
  socket.send(instruction('key', 97, 1));
  await until(() => keyData === '97,1');
});

test('expired sessions lose HTTP access and close their active sockets', async (t) => {
  const f = await fixture(t, { sessionMs: 400 });
  const echo = net.createServer((socket) => socket.pipe(socket));
  const port = await listen(echo);
  t.after(() => new Promise((resolve) => echo.close(resolve)));
  const stop = await startAgent({ url: f.base, identity: f.device.path, allowLocal: true, sshPort: port, rdpPort: port }, () => {});
  t.after(stop);
  const { cookie } = await loginWithKey(f.base, f.admin.identity);
  assert.equal((await f.status(cookie)).status, 200);
  await until(async () => (await (await f.status(cookie)).json()).device.online);
  const { ticket } = await (await f.post('ssh-ticket', {}, cookie)).json();
  const socket = new WebSocket(`${f.base.replace('http', 'ws')}/ws/ssh`);
  t.after(() => socket.terminate());
  await once(socket, 'open'); socket.send(JSON.stringify({ ticket }));
  await once(socket, 'message');
  const [code] = await once(socket, 'close');
  assert.equal(code, 1008);
  assert.equal((await f.status(cookie)).status, 401);
});

test('Guacamole parser handles UTF-8 code points and fragmented instructions', () => {
  const actual = [];
  const parser = new GuacParser((value) => actual.push(value));
  const input = instruction('name', '电脑😀') + instruction('key', 97, 1);
  for (const character of input) parser.receive(character);
  assert.deepEqual(actual, [['name', '电脑😀'], ['key', '97', '1']]);
});
