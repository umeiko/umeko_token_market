import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from 'fastify';

const directory = mkdtempSync(join(tmpdir(), 'utoken-video-'));
process.env.DATA_PATH = join(directory, 'test.db');
const { db } = await import('../server/db.js');
const { encryptProviderKey } = await import('../server/providerCrypto.js');
const { hashToken } = await import('../server/security.js');
const { Gateway } = await import('../server/gateway.js');
const { videoRoutes } = await import('../server/video.js');

test('Seedance and Wan jobs use provider credentials, survive restart and settle once', async (t) => {
  const mockRequests = [];
  const upstream = new Map();
  const mockFetch = async (url, options) => {
    const path = new URL(url).pathname;
    const isWan = url.includes('.aliyuncs.com');
    assert.equal(options.headers.authorization, `Bearer test-${isWan ? 'wan' : 'seedance'}`);
    assert.equal(options.redirect, 'error');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      mockRequests.push({ path, headers: options.headers, body });
      if (body.content?.[0]?.text === 'simulate connection lost') throw new Error('test transport failure');
      const id = `provider-${mockRequests.length}`;
      upstream.set(id, false);
      return Response.json(isWan ? { output: { task_id: id, task_status: 'PENDING' } } : { id });
    }
    const id = path.split('/').at(-1);
    const finished = upstream.get(id);
    const urlResult = 'https://media.example/result.mp4?signature=example';
    if (isWan) {
      assert.match(path, /^\/api\/v1\/tasks\//);
      return Response.json({ output: { task_id: id, task_status: finished ? 'SUCCEEDED' : 'RUNNING', video_url: finished ? urlResult : undefined },
        usage: finished ? { input_video_duration: 2, output_video_duration: 5, duration: 7, SR: 720 } : undefined });
    }
    assert.match(path, /^\/api\/v3\/contents\/generations\/tasks\//);
    return Response.json(finished ? { id, status: 'failed', error: { code: 'ContentRejected' } } : { id, status: 'running' });
  };
  const insertKey = db.prepare(`INSERT INTO api_keys(name,key_hash,key_prefix,allowed_models,budget_quota_micros,concurrency_limit)
    VALUES (?, ?, ?, ?, ?, 4)`);
  insertKey.run('video', hashToken('owner-key'), 'owner', '["wan","seedance"]', 2_000_000);
  insertKey.run('other', hashToken('other-key'), 'other', '["wan"]', 2_000_000);
  insertKey.run('unrestricted chat', hashToken('chat-key'), 'chat', '[]', 2_000_000);
  for (const [name, base, upstreamName] of [
    ['wan', 'https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1', 'wan3.0-video'],
    ['seedance', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seedance-2-0-260128'],
  ]) {
    const key = encryptProviderKey(`test-${name}`);
    const { lastInsertRowid } = db.prepare(`INSERT INTO providers(name,token_hash,token_prefix,provider_type,base_url,api_key_ciphertext,api_key_iv,api_key_tag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, name, name, name, base, key.api_key_ciphertext, key.api_key_iv, key.api_key_tag);
    db.prepare('INSERT INTO models(provider_id,name,upstream_name,output_price) VALUES (?, ?, ?, 1)').run(lastInsertRowid, name, upstreamName);
  }
  let app;
  let gateway;
  async function start() {
    app = Fastify();
    gateway = new Gateway({ activeCount: () => 0 }, () => ({}));
    await app.register(videoRoutes, { prefix: '/api', gateway, fetcher: mockFetch, pollIntervalMs: 25 });
  }
  async function stop() {
    clearInterval(gateway.blockedCleanup);
    await app.close();
  }
  await start();
  t.after(async () => { await stop(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (method, path, body, idempotencyKey, token = 'owner-key') => app.inject({
    method, url: `/api/v1/videos${path}`, payload: body,
    headers: { authorization: `Bearer ${token}`, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
  });
  const input = { model: 'wan', prompt: '镜头向前推进', media: [{ type: 'reference_video', url: 'https://media.example/clip.mp4' }],
    duration: 5, resolution: '720p', ratio: '9:16', audio: false };
  assert.equal((await request('POST', '', input, 'no-access', 'chat-key')).statusCode, 403);
  const wan = await request('POST', '', input, 'wan-once');
  assert.equal(wan.statusCode, 202, wan.body);
  assert.equal(wan.json().status, 'queued');
  assert.equal(wan.json().price_micros, 1_000_000);
  assert.equal(wan.headers['cache-control'], 'no-store');
  assert.equal((await request('POST', '', input, 'wan-once')).json().id, wan.json().id);
  assert.equal((await request('POST', '', { ...input, duration: 10 }, 'wan-once')).statusCode, 409);
  assert.equal((await request('GET', `/${wan.json().id}`, undefined, undefined, 'other-key')).statusCode, 404);
  const seed = await request('POST', '', { model: 'seedance', prompt: '海浪涌上沙滩', duration: 5, audio: false,
    media: [{ type: 'first_frame', url: 'https://media.example/first.png' }] }, 'seed-once');
  assert.equal(seed.statusCode, 202, seed.body);
  assert.equal((await request('POST', '', input, 'too-expensive')).statusCode, 429);
  assert.equal(mockRequests.length, 2);
  assert.equal(mockRequests[0].path, '/api/v1/services/aigc/video-generation/video-synthesis');
  assert.equal(mockRequests[0].headers['X-DashScope-Async'], 'enable');
  assert.deepEqual(mockRequests[0].body, { model: 'wan3.0-video', input: { prompt: input.prompt, media: input.media },
    parameters: { duration: 5, ratio: '9:16', resolution: '720P', audio: false } });
  assert.equal(mockRequests[1].path, '/api/v3/contents/generations/tasks');
  assert.equal(mockRequests[1].body.generate_audio, false);
  assert.deepEqual(mockRequests[1].body.content[1], {
    type: 'image_url', image_url: { url: 'https://media.example/first.png' }, role: 'first_frame',
  });

  await stop();
  await start();
  assert.equal((await request('GET', `/${wan.json().id}`)).json().status, 'queued');
  upstream.set('provider-1', true);
  upstream.set('provider-2', true);
  db.prepare('UPDATE video_jobs SET next_poll = 0').run();
  let completed;
  for (let i = 0; i < 40; i++) {
    completed = (await request('GET', `/${wan.json().id}`)).json();
    if (completed.status === 'succeeded') break;
    await delay(20);
  }
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.usage.duration, 7);
  assert.equal(completed.cost_micros, 1_000_000);
  assert.equal(completed.video_url, 'https://media.example/result.mp4?signature=example');
  const failed = (await request('GET', `/${seed.json().id}`)).json();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'ContentRejected');
  assert.equal(failed.cost_micros, 0);
  assert.equal((await request('POST', '', input, 'wan-once')).statusCode, 200);
  assert.deepEqual({ ...db.prepare("SELECT used_cost_micros, used_tokens FROM api_keys WHERE name = 'video'").get() },
    { used_cost_micros: 1_000_000, used_tokens: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage_logs').get().count, 2);
  const uncertain = await request('POST', '', { model: 'seedance', prompt: 'simulate connection lost' }, 'uncertain');
  assert.equal(uncertain.json().status, 'submission_unknown');
  assert.equal((await request('POST', '', { model: 'seedance', prompt: 'simulate connection lost' }, 'uncertain')).json().id, uncertain.json().id);
  assert.equal(mockRequests.length, 3);
  assert.equal((await request('GET', `/${wan.json().id}`)).statusCode, 200);
  assert.equal((await request('POST', '', input, 'still-held')).statusCode, 429);
});
