import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { test } from 'node:test';

test('utoken bridges separate local API and video services through the Relay', { skip: !process.env.UTOKEN_BINARY, timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'utoken-bridge-'));
  process.env.DATA_PATH = join(dir, 'db.sqlite');
  process.env.ADMIN_PASSWORD = 'test-only-password';
  const { db, ensureAdmin } = await import('../server/db.js');
  const { adminRoutes } = await import('../server/admin.js');
  const { pairingRoutes } = await import('../server/pairing.js');
  ensureAdmin();
  const { Gateway } = await import('../server/gateway.js');
  const { hashToken } = await import('../server/security.js');
  const { Tunnel } = await import('../server/tunnel.js');
  const { videoRoutes } = await import('../server/video.js');
  const local = Fastify();
  const relay = Fastify();
  const processes = [];
  const tunnel = new Tunnel(relay.log);
  const gateway = new Gateway(tunnel, () => ({}));
  t.after(async () => {
    await Promise.all(processes.map(async (proc) => {
      if (proc.exitCode !== null) return;
      const exited = once(proc, 'exit');
      proc.kill();
      await exited;
    }));
    clearInterval(gateway.blockedCleanup);
    tunnel.close();
    await Promise.all([local.close(), relay.close()]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const videoBytes = Buffer.alloc(768 * 1024, 91);
  local.get('/video/health', async (request) => {
    assert.equal(request.headers.authorization, 'Bearer private-local-key');
    return { ok: true };
  });
  local.get('/video/v1/models', async (request) => {
    assert.equal(request.headers.authorization, 'Bearer private-local-key');
    return { data: [{ id: 'minimax-h3-turbo4' }] };
  });
  local.get('/chat/v1/models', async () => ({ data: [{ id: 'local-chat' }] }));
  local.post('/chat/v1/chat/completions', async (request, reply) => {
    assert.equal(request.body.model, 'local-chat');
    if (request.body.stream) return reply.type('text/event-stream').send('data: {"model":"local-chat","choices":[]}\n\ndata: [DONE]\n\n');
    return { model: 'local-chat', choices: [{ message: { content: 'bridge works' } }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } };
  });
  local.post('/video/v1/videos', async (request, reply) => {
    assert.equal(request.headers.authorization, 'Bearer private-local-key');
    assert.equal(request.body.model, 'minimax-h3-turbo4');
    assert.equal(request.body.prompt, 'A lake');
    assert.equal(request.body.resolution, '768p');
    assert.equal(request.body.media[0].url, 'data:image/png;base64,YQ==');
    return reply.code(202).send({ id: 'local-task-1', status: 'queued' });
  });
  local.get('/video/v1/videos/local-task-1', async () => ({ id: 'local-task-1', status: 'succeeded', duration: 5 }));
  local.get('/video/v1/videos/local-task-1/content', async (request, reply) => {
    assert.equal(request.headers.authorization, 'Bearer private-local-key');
    return reply.type('video/mp4').send(videoBytes);
  });
  const localBase = await local.listen({ host: '127.0.0.1', port: 0 });

  await relay.register(cookie);
  await relay.register(websocket);
  await relay.register(async (app) => {
    app.get('/agent/connect', { websocket: true }, (socket) => tunnel.connect(socket));
    app.post('/v1/*', (request, reply) => gateway.proxy(request, reply));
    await app.register(videoRoutes, { gateway, pollIntervalMs: 20 });
    await app.register(pairingRoutes, { tunnel });
    await app.register(adminRoutes, { gateway, tunnel });
  }, { prefix: '/api' });
  const cloud = await relay.listen({ host: '127.0.0.1', port: 0 }) + '/api';
  const provider = db.prepare('INSERT INTO providers(name,token_hash,token_prefix,provider_type) VALUES (?, ?, ?, ?)');
  const model = db.prepare('INSERT INTO models(provider_id,name,upstream_name,output_price) VALUES (?, ?, ?, ?)');
  const apiProvider = Number(provider.run('test chat', hashToken('chat-connector'), 'chat', 'tunnel').lastInsertRowid);
  const auth = await fetch(cloud + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-only-password' }),
  });
  assert.equal(auth.status, 200);
  const admin = { cookie: auth.headers.get('set-cookie').split(';')[0] };
  assert.equal((await fetch(cloud + '/api/admin/tools-session', { headers: admin })).status, 401);
  const created = await fetch(cloud + '/api/admin/providers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...admin },
    body: JSON.stringify({ name: 'test video', provider_type: 'video_tunnel', parent_provider_id: apiProvider, models: [] }),
  });
  assert.equal(created.status, 200);
  const { id: videoProvider, pairing } = await created.json();
  assert.equal(pairing.id, videoProvider);
  const invalid = await fetch(cloud + `/api/admin/providers/${apiProvider}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...admin },
    body: JSON.stringify({ parent_provider_id: videoProvider }),
  });
  assert.equal(invalid.status, 400);
  model.run(apiProvider, 'chat-alias', 'local-chat', 0);
  model.run(videoProvider, 'video-alias', 'minimax-h3-turbo4', 1);
  const addKey = db.prepare('INSERT INTO api_keys(name,key_hash,key_prefix,allowed_models,budget_quota_micros) VALUES (?, ?, ?, ?, ?)');
  addKey.run('other', hashToken('client-other'), 'other', '["video-alias"]', 2_000_000);
  const createdKey = await fetch(cloud + '/api/admin/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...admin },
    body: JSON.stringify({ name: 'owner', allowed_models: ['chat-alias', 'video-alias'], budget_quota: 2,
      model_aliases: { 'video-alias': 'my-h3', 'chat-alias': 'my-chat' } }),
  });
  assert.equal(createdKey.status, 200);
  const owner = await createdKey.json();
  const conflict = await fetch(cloud + `/api/admin/keys/${owner.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...admin },
    body: JSON.stringify({ model_aliases: { 'video-alias': 'my-chat', 'chat-alias': 'my-chat' } }),
  });
  assert.equal(conflict.status, 400);

  async function startConnector(profile) {
    const proc = spawn(process.env.UTOKEN_BINARY, ['serve', '--profile', profile, '--web-port', '0'], {
      env: { ...process.env, XDG_CONFIG_HOME: dir }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    processes.push(proc);
    let log = '';
    return new Promise((resolve, reject) => {
      proc.once('error', reject);
      proc.once('exit', () => reject(new Error('utoken exited before listening')));
      proc.stderr.on('data', (chunk) => {
        log += chunk.toString();
        const match = log.match(/Umeko Web console: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
    });
  }
  const [chatUI, videoUI] = await Promise.all([startConnector('chat'), startConnector('video')]);
  function post(base, resource, body, options = {}) {
    return fetch(base + resource, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...options }, body: JSON.stringify(body),
    });
  }
  const chatConfig = { cloudUrl: cloud, localBaseUrl: localBase + '/chat', providerId: apiProvider, providerToken: 'chat-connector' };
  const videoConfig = { cloudUrl: cloud, localBaseUrl: localBase + '/video', providerId: videoProvider, providerToken: 'video-connector',
    localApiKey: 'private-local-key', serviceType: 'video', healthPath: '/health' };

  assert.equal((await post(videoUI, '/api/start', videoConfig, { origin: 'https://external.example' })).status, 403);
  const probe = await post(videoUI, '/api/probe', videoConfig);
  assert.equal((await probe.json()).online, true);
  assert.equal((await post(chatUI, '/api/start', chatConfig)).status, 200);
  const pairLink = `${cloud}#utoken=1&id=${videoProvider}&code=${pairing.code}&service=video`;
  const localPair = { link: pairLink, localBaseUrl: videoConfig.localBaseUrl, localApiKey: videoConfig.localApiKey };
  assert.equal((await post(videoUI, '/api/pair', localPair, { origin: 'https://external.example' })).status, 403);
  assert.equal((await post(videoUI, '/api/pair', localPair, { origin: videoUI })).status, 200);
  assert.equal((await post(videoUI, '/api/pair', localPair, { origin: videoUI })).status, 400);
  for (let i = 0; i < 80 && !(tunnel.isOnline(apiProvider) && tunnel.isOnline(videoProvider)); i++) await delay(25);
  assert.ok(tunnel.isOnline(apiProvider) && tunnel.isOnline(videoProvider));
  const state = await (await fetch(videoUI + '/api/status')).json();
  assert.equal(state.connectionState, 'online');
  assert.deepEqual(state.localModels, ['minimax-h3-turbo4']);
  const cloudProviders = await (await fetch(cloud + '/api/admin/providers', { headers: admin })).json();
  const view = cloudProviders.providers.find(({ id }) => id === videoProvider);
  assert.equal(view.parent_provider_id, apiProvider);
  assert.deepEqual(view.discovery, { models: ['minimax-h3-turbo4'], health_path: '/health', local_auth: true });
  assert.deepEqual(state.cloudModels, [{ name: 'video-alias', upstream_name: 'minimax-h3-turbo4', enabled: 1 }]);
  const config = await (await fetch(videoUI + '/api/config')).json();
  assert.ok(config.hasProviderToken && config.hasLocalApiKey);
  assert.equal(config.providerToken ?? config.localApiKey, undefined);
  assert.equal((await fetch(videoUI + '/')).status, 200);

  const headers = { authorization: 'Bearer ' + owner.key };
  const catalog = gateway.models(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(owner.id));
  assert.deepEqual(catalog.map(({ id }) => id), ['my-chat', 'my-h3']);
  const publicHelp = await fetch(cloud + '/v1/videos/help.json');
  assert.deepEqual((await publicHelp.json())['x-model-ids'], ['video-alias']);
  const helpResponse = await fetch(cloud + '/v1/videos/help.json?model=my-h3', { headers });
  assert.match(helpResponse.headers.get('content-disposition'), /h3-api-help.json/);
  const help = await helpResponse.json();
  assert.deepEqual(help['x-model-ids'], ['my-h3']);
  assert.equal(help.paths['/v1/videos'].post.requestBody.content['application/json'].examples.first_last_frame.value.model, 'my-h3');
  assert.equal((await fetch(cloud + '/v1/videos/help.json?model=my-h3', { headers: { authorization: 'Bearer client-other' } })).status, 404);
  const chat = await post(cloud, '/v1/chat/completions', { model: 'my-chat', messages: [] }, headers);
  const chatBody = await chat.json();
  assert.equal(chatBody.choices[0].message.content, 'bridge works');
  assert.equal(chatBody.model, 'my-chat');
  const chatStream = await post(cloud, '/v1/chat/completions', { model: 'my-chat', messages: [], stream: true }, headers);
  assert.match(await chatStream.text(), /"model":"my-chat"/);
  assert.equal((await post(cloud, '/v1/videos', { model: 'video-alias', prompt: 'A lake' }, headers)).status, 403);
  const submitted = await post(cloud, '/v1/videos', { model: 'my-h3', prompt: 'A lake', resolution: '768p',
    media: [{ type: 'first_frame', url: 'data:image/png;base64,YQ==' }] }, headers);
  assert.equal(submitted.status, 202);
  const task = await submitted.json();
  assert.equal(task.status, 'queued', JSON.stringify(task));
  assert.equal(task.model, 'my-h3');
  db.prepare('UPDATE video_jobs SET next_poll = 0 WHERE id = ?').run(task.id);
  let result;
  for (let i = 0; i < 50; i++) {
    result = await (await fetch(cloud + '/v1/videos/' + task.id, { headers })).json();
    if (result.status === 'succeeded') break;
    await delay(25);
  }
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.content_url, '/api/v1/videos/' + task.id + '/content');
  const url = new URL(result.content_url, cloud).href;
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer client-other' } })).status, 404);
  const download = await fetch(url, { headers });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), videoBytes);
  const usage = await (await fetch(cloud + `/api/admin/usage?provider_id=${apiProvider}`, { headers: admin })).json();
  assert.ok(usage.logs.some(({ provider_id, provider_name }) => provider_id === videoProvider && provider_name === 'test chat'));
});
