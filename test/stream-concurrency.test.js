import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

mkdirSync('data', { recursive: true });
const directory = mkdtempSync('data/stream-concurrency-');
process.env.DATA_PATH = `${directory}/market.db`;
process.env.ADMIN_PASSWORD = 'verification-password';
const { db } = await import('../server/db.js');
const { Gateway } = await import('../server/gateway.js');

test('observe rejects a stream closed without an end event', async () => {
  const gateway = new Gateway({}, () => ({}));
  const stream = new PassThrough();
  const observed = gateway.observe(stream, { messages: [] }, true, 200);
  stream.destroy();
  await assert.rejects(observed, /上游响应流在完成前关闭/);
  db.close();
});

test('client cancellation, upstream disconnect and body timeout release concurrency', async () => {
  const closedModels = new Set();
  const upstream = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const { model } = JSON.parse(body);
      response.on('close', () => closedModels.add(model));
      if (model === 'success-model') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
      if (model === 'broken-model') setTimeout(() => response.socket.destroy(), 50);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const relayPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${relayPort}`;
  const service = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(relayPort), HOST: '127.0.0.1', BASE_PATH: '', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serviceOutput = '';
  service.stdout.on('data', (chunk) => { serviceOutput += chunk; });
  service.stderr.on('data', (chunk) => { serviceOutput += chunk; });
  const request = async (path, options = {}) => {
    const response = await fetch(origin + path, options);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, data, text };
  };
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await request('/health')).response.ok) { healthy = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(healthy, serviceOutput);
    const login = await request('/api/admin/login', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'verification-password' }),
    });
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    const admin = (path, method = 'GET', body) => request(path, {
      method, headers: { origin, cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const provider = await admin('/api/admin/providers', 'POST', {
      name: 'stream-fixture', provider_type: 'openai', base_url: `http://127.0.0.1:${upstreamPort}`, api_key: 'fixture',
      models: [{ name: 'disconnect-model' }, { name: 'broken-model' }, { name: 'timeout-model' }, { name: 'success-model' }],
    });
    assert.equal(provider.response.status, 200, provider.text);
    const key = await admin('/api/admin/keys', 'POST', { name: 'single-slot', concurrency_limit: 1, rpm_limit: 0 });
    assert.equal(key.response.status, 200, key.text);
    const timeout = await admin('/api/admin/settings', 'PATCH', { request_timeout_ms: 5000 });
    assert.equal(timeout.response.status, 200, timeout.text);
    const active = async () => (await admin('/api/admin/keys')).data.keys[0].active;
    const waitForRelease = async () => {
      for (let i = 0; i < 100; i++) {
        if (await active() === 0) return;
        await delay(100);
      }
      throw new Error(`Concurrency was not released: ${serviceOutput}`);
    };
    const call = (model, signal) => fetch(`${origin}/v1/chat/completions`, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${key.data.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'test' }], stream: true }),
    });
    const assertSuccessReleases = async () => {
      const response = await call('success-model');
      assert.equal(response.status, 200);
      await response.text();
      await waitForRelease();
    };

    const controller = new AbortController();
    const disconnected = await call('disconnect-model', controller.signal);
    assert.equal(disconnected.status, 200);
    await disconnected.body.getReader().read();
    controller.abort();
    await waitForRelease();
    assert.ok(closedModels.has('disconnect-model'));
    await assertSuccessReleases();

    const broken = await call('broken-model');
    assert.equal(broken.status, 200);
    await broken.text().catch(() => {});
    await waitForRelease();
    await assertSuccessReleases();

    const timedOut = await call('timeout-model');
    assert.equal(timedOut.status, 200);
    await timedOut.text().catch(() => {});
    await waitForRelease();
    assert.ok(closedModels.has('timeout-model'));
    await assertSuccessReleases();
  } finally {
    if (service.exitCode === null) {
      const exited = new Promise((resolve) => service.once('exit', resolve));
      service.kill('SIGTERM');
      await exited;
    }
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
