import { createHash, randomUUID } from 'node:crypto';
import { ACTIVE_VIDEO_STATES, db, transaction } from './db.js';
import { sendGatewayError } from './gateway.js';
import { requestVideoProvider, videoBaseUrl, videoError, videoRequest } from './videoProvider.js';
import { sendH3Help, VIDEO_JSON_BYTES, VIDEO_DOWNLOAD_BYTES } from './h3.js';

const SECOND = 1000;
const DAY = 86400 * SECOND;
const POLL_INTERVAL = 10 * SECOND;
const UNCERTAIN_AFTER = 30 * SECOND;
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

const getJob = (id) => db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id);

function publicJob(job, request) {
  const { local_content, ...result } = JSON.parse(job.result_json);
  if (local_content) {
    const prefix = request.routeOptions.url.split('/v1/videos')[0];
    result.content_url = `${prefix}/v1/videos/${job.id}/content`;
  }
  return {
    id: job.id, object: 'video', model: job.model, status: job.status,
    created_at: Math.floor(job.created_at / SECOND), updated_at: Math.floor(job.updated_at / SECOND),
    price_micros: job.price_micros, currency: 'USD',
    ...(terminal.has(job.status) ? { cost_micros: job.status === 'succeeded' ? job.price_micros : 0 } : {}),
    ...(job.status === 'submission_unknown' ? { error: { message: '上游是否接受任务尚未确认，请勿更换 Idempotency-Key 重试提交' } } : {}),
    ...result,
  };
}

function finish(job, status, result = {}, upstreamId = null) {
  transaction(() => {
    const { changes } = db.prepare(`UPDATE video_jobs SET status = ?, result_json = ?, updated_at = ?, upstream_id = COALESCE(?, upstream_id)
      WHERE id = ? AND status IN ${ACTIVE_VIDEO_STATES}`).run(status, JSON.stringify(result), Date.now(), upstreamId, job.id);
    if (!changes) return;
    const cost = status === 'succeeded' ? job.price_micros : 0;
    db.prepare(`INSERT INTO usage_logs (request_id, key_id, provider_id, model, cost_micros, status, latency_ms, category, error)
      SELECT id, key_id, provider_id, model, ?, ?, ?, ?, ? FROM video_jobs WHERE id = ?`)
      .run(cost, status === 'succeeded' ? 200 : 502, Date.now() - job.created_at,
        status === 'succeeded' ? 'success' : 'upstream_error', result.error?.message || '', job.id);
    db.prepare(`UPDATE api_keys SET used_cost_micros = used_cost_micros + ?, last_used_at = datetime('now')
      WHERE id = (SELECT key_id FROM video_jobs WHERE id = ?)`).run(cost, job.id);
  });
}

function update(job, result) {
  if (terminal.has(result.status)) {
    const { id, status, ...details } = result;
    if (status !== 'succeeded') {
      const reason = { failed: '生成失败', cancelled: '已取消', expired: '已过期' }[status];
      details.error = { code: details.error_code, message: `视频任务${reason}` };
    }
    delete details.error_code;
    if (status !== 'succeeded' || details.video_url || details.local_content) {
      finish(job, status, details, id);
      return;
    }
    // Keep polling a known task if the provider reports success before publishing its URL.
  }
  const now = Date.now();
  db.prepare(`UPDATE video_jobs SET upstream_id = ?, status = ?, updated_at = ?, next_poll = ?
    WHERE id = ? AND status IN ${ACTIVE_VIDEO_STATES}`).run(result.id, result.status === 'succeeded' ? 'running' : result.status, now, now + POLL_INTERVAL, job.id);
}

export async function videoRoutes(app, { gateway, tunnel = gateway.tunnel, fetcher = fetch, pollIntervalMs = POLL_INTERVAL }) {
  let polling;
  function poll() {
    if (polling) return polling;
    const now = Date.now();
    db.prepare(`UPDATE video_jobs SET status = 'submission_unknown', updated_at = ?
      WHERE status = 'submitting' AND created_at < ?`).run(now, now - UNCERTAIN_AFTER);
    const expired = db.prepare(`SELECT * FROM video_jobs WHERE status IN ${ACTIVE_VIDEO_STATES} AND created_at < ? LIMIT 100`).all(now - DAY);
    for (const job of expired) finish(job, 'expired', { error: { message: '视频任务超过 24 小时未能确认结果' } });
    db.prepare(`DELETE FROM video_jobs WHERE updated_at < ? AND status NOT IN ${ACTIVE_VIDEO_STATES}`).run(now - 7 * DAY);
    const pending = db.prepare(`SELECT * FROM video_jobs WHERE status IN ('queued','running')
      AND next_poll <= ? ORDER BY next_poll LIMIT 10`).all(now);
    polling = Promise.allSettled(pending.map(async (job) => {
      const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(job.provider_id);
      try {
        if (!provider || !job.upstream_id) throw videoError('原视频供应商不可用', 503);
        const result = await requestVideoProvider({ ...provider, base_url: job.base_url, provider_type: job.provider_type }, { taskId: job.upstream_id, tunnel, fetcher });
        if (result.id !== job.upstream_id) throw videoError('上游返回了不匹配的任务 ID', 502);
        update(job, result);
      } catch {
        db.prepare('UPDATE video_jobs SET next_poll = ? WHERE id = ?').run(Date.now() + 60 * SECOND, job.id);
      }
    })).finally(() => { polling = null; });
    return polling;
  }
  const timer = setInterval(() => {
    try { poll().catch(() => app.log.warn('Video status synchronization failed')); }
    catch { app.log.warn('Video status synchronization failed'); }
  }, pollIntervalMs);
  timer.unref();
  app.addHook('preClose', async () => { clearInterval(timer); await polling; });

  const authenticate = (request) => {
    const key = gateway.authenticate(request.headers.authorization, { checkQuotas: false });
    gateway.validateClient(key, String(request.headers['user-agent'] || ''));
    return key;
  };

  app.get('/v1/videos/help.json', async (request, reply) => {
    try {
      const key = request.headers.authorization === undefined ? null : authenticate(request);
      const basePath = request.routeOptions.url.split('/v1/videos/help.json')[0];
      return sendH3Help(request, reply, basePath, key);
    } catch (error) {
      return sendGatewayError(reply, error);
    }
  });

  app.post('/v1/videos', { bodyLimit: VIDEO_JSON_BYTES }, async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store');
      const key = authenticate(request);
      const input = request.body;
      if (!input || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200) throw videoError('请提供有效的 model');
      const idempotencyKey = request.headers['idempotency-key'] ?? null;
      if (idempotencyKey !== null && !/^[!-~]{1,128}$/.test(idempotencyKey)) throw videoError('Idempotency-Key 必须为 1 至 128 个可见 ASCII 字符');
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      if (idempotencyKey) {
        const previous = db.prepare('SELECT * FROM video_jobs WHERE key_id = ? AND idempotency_key = ?').get(key.id, idempotencyKey);
        if (previous) {
          if (previous.request_hash !== hash) throw videoError('Idempotency-Key 已用于不同请求', 409);
          return reply.code(terminal.has(previous.status) ? 200 : 202).send(publicJob(previous, request));
        }
      }
      const model = gateway.selectProvider(input.model, key, { video: true });
      const body = videoRequest(input, model);
      const base = model.provider_type === 'video_tunnel' ? '' : videoBaseUrl(model.provider_type, model.base_url);
      const price = Math.round(model.output_price * 1e6);
      if (!Number.isSafeInteger(price) || price <= 0) throw videoError('此模型尚未配置每条视频价格', 503);
      const id = `vid_${randomUUID().replaceAll('-', '')}`;
      const now = Date.now();
      transaction(() => {
        const usage = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(price_micros), 0) held FROM video_jobs
          WHERE key_id = ? AND status IN ${ACTIVE_VIDEO_STATES}`).get(key.id);
        if (key.budget_quota_micros <= 0 || key.used_cost_micros + usage.held + price > key.budget_quota_micros) {
          throw videoError('视频任务需要明确设置 API Key 费用额度，并预留本次生成费用', 429);
        }
        if (key.concurrency_limit > 0 && usage.count >= key.concurrency_limit) throw videoError('API Key 视频任务并发已满', 429);
        if (model.max_concurrency > 0 && gateway.videoProviderActive(model.provider_id) >= model.max_concurrency) throw videoError('供应商视频任务并发已满', 429);
        db.prepare(`INSERT INTO video_jobs (id, key_id, provider_id, model, provider_type, base_url,
          idempotency_key, request_hash, status, price_micros, created_at, updated_at, next_poll)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?, ?, ?, ?)`)
          .run(id, key.id, model.provider_id, input.model, model.provider_type, base, idempotencyKey, hash, price, now, now, now);
      });
      const reserved = getJob(id);
      try {
        update(reserved, await requestVideoProvider(model, { body, tunnel, fetcher }));
      } catch (error) {
        if (error.rejected) {
          finish(reserved, 'failed', { error: { message: error.message } });
        } else {
          db.prepare("UPDATE video_jobs SET status = 'submission_unknown', updated_at = ? WHERE id = ? AND status = 'submitting'")
            .run(Date.now(), id);
        }
      }
      const job = getJob(id);
      return reply.code(terminal.has(job.status) ? 200 : 202).send(publicJob(job, request));
    } catch (error) {
      return sendGatewayError(reply, error);
    }
  });

  app.get('/v1/videos/:id', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store');
      const key = authenticate(request);
      const job = getJob(request.params.id);
      if (!job || job.key_id !== key.id) throw videoError('视频任务不存在', 404);
      return publicJob(job, request);
    } catch (error) {
      return sendGatewayError(reply, error);
    }
  });
  app.get('/v1/videos/:id/content', async (request, reply) => {
    const controller = new AbortController();
    try {
      reply.header('Cache-Control', 'no-store');
      const key = authenticate(request);
      const job = getJob(request.params.id);
      if (!job || job.key_id !== key.id || job.provider_type !== 'video_tunnel') throw videoError('视频成品不存在', 404);
      if (job.status !== 'succeeded') throw videoError('视频任务尚未成功完成', 409);
      if (!tunnel.isOnline(job.provider_id)) throw videoError('原本地视频供应商未就绪', 503);
      const release = gateway.reserve(key);
      reply.raw.once('close', () => { controller.abort(); release(); });
      const response = await tunnel.forward({ id: job.provider_id }, {
        method: 'GET', path: `/v1/videos/${encodeURIComponent(job.upstream_id)}/content`, body: '',
        timeoutMs: 300000, signal: controller.signal, byteLimit: VIDEO_DOWNLOAD_BYTES,
        headers: { accept: 'video/mp4, video/webm' },
      });
      if (response.status === 404 || response.status === 410) throw videoError('本地成品已清理或不存在', 404);
      if (response.status !== 200) throw videoError('本地成品下载失败', 502);
      const type = (response.headers['content-type'] || '').split(';')[0].toLowerCase().trim();
      if (!['video/mp4', 'video/webm'].includes(type)) throw videoError('本地成品必须是 MP4 或 WebM 视频', 502);
      const extension = type === 'video/webm' ? 'webm' : 'mp4';
      return reply.type(type).header('X-Accel-Buffering', 'no').header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${job.id}.${extension}"`).send(response.stream);
    } catch (error) {
      controller.abort();
      return sendGatewayError(reply, error);
    }
  });

}
