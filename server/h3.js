import { db } from './db.js';
import { keyModels } from './modelPolicy.js';

export const H3_UPSTREAM_ID = 'minimax-h3-turbo4';
export const H3_RATIOS = ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'];
export const H3_RESOLUTIONS = ['512p', '720p', '768p'];
export const H3_FRAME_TYPES = ['first_frame', 'last_frame'];
export const H3_LIMITS = { duration: [2, 10], prompt: 12000, seed: Number.MAX_SAFE_INTEGER };
export const VIDEO_JSON_BYTES = 128 * 1024;
export const VIDEO_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const H3_IMAGE_DATA = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export const isH3 = (provider) => provider.provider_type === 'video_tunnel'
  && (provider.upstream_name || provider.name) === H3_UPSTREAM_ID;

export function sendH3Help(request, reply, basePath, key) {
  const policy = key && keyModels(key);
  const models = db.prepare(`SELECT m.name, m.output_price, m.upstream_name, p.provider_type FROM models m
    JOIN providers p ON p.id = m.provider_id WHERE m.enabled = 1 AND p.enabled = 1 AND p.provider_type = 'video_tunnel'
    ORDER BY m.name`).all().filter(isH3)
    .filter((model) => !key || (policy.allowed.has(model.name) && key.budget_quota_micros > 0 && model.output_price > 0))
    .map(({ name }) => policy?.publicIds.get(name) || name);
  const ids = [...new Set(models)].filter((id) => request.query.model === undefined || request.query.model === id);
  reply.header('Cache-Control', 'no-store');
  if (!ids.length) return reply.code(404).send({ error: { message: '没有符合条件的 H3 Model ID' } });
  const serverUrl = new URL(basePath || '/', `${request.protocol}://${request.host}`).href;
  return reply.header('Content-Disposition', 'attachment; filename="h3-api-help.json"').send(h3Help(serverUrl, ids));
}

function h3Help(serverUrl, modelIds) {
  const model = modelIds[0];
  const sample = { model, prompt: 'The camera slowly pans past a ceramic cup.', duration: 5, ratio: '16:9', resolution: '768p', audio: true };
  const frame = { type: 'first_frame', url: 'https://assets.example.com/first.jpg' };
  const endFrame = { type: 'last_frame', url: 'https://assets.example.com/last.jpg' };
  const modes = {
    text_to_video: { summary: '文生视频', value: sample },
    image_to_video: { summary: '首帧图生视频', value: { ...sample, media: [frame] } },
    first_last_frame: { summary: '首尾帧控制', value: { ...sample, media: [frame, endFrame] } },
  };
  const [minDuration, maxDuration] = H3_LIMITS.duration;
  const jobId = { name: 'id', in: 'path', required: true, description: '提交时返回的 Relay 任务 ID。', schema: { type: 'string' } };
  const json = (schema) => ({ 'application/json': { schema } });
  const error = (description) => ({ description, content: json({ $ref: '#/components/schemas/Error' }) });
  const job = (description) => ({ description, content: json({ $ref: '#/components/schemas/Video' }) });
  return {
    openapi: '3.1.0',
    info: {
      title: 'Umeko Relay · MiniMax H3 视频 API', version: '1.0.0',
      description: '使用授权了相应 Model ID、并设置费用额度的 Relay Key。提交后保存 id，建议每 10 秒查询一次。成功后使用同一 Key GET content_url 下载 MP4。相对路径以 Relay 站点为准。任务记录保留 7 天，成片可下载时间还取决于本机在线与文件保留状态。',
    },
    servers: [{ url: serverUrl }],
    security: [{ BearerAuth: [] }],
    'x-model-ids': modelIds,
    'x-modes': Object.keys(modes),
    'x-limits': { max_request_bytes: VIDEO_JSON_BYTES, max_download_bytes: VIDEO_DOWNLOAD_BYTES },
    paths: {
      '/v1/models': {
        get: {
          summary: '列出该 Key 当前可调用的 Model ID（视频模型为 modality: video）',
          responses: {
            200: { description: '模型列表', content: json({
              type: 'object', required: ['data'], properties: { data: { type: 'array', items: {
                type: 'object', required: ['id'], properties: { id: { type: 'string' }, modality: { type: 'string' } },
              } } },
            }) },
            401: error('缺少有效 Key'),
          },
        },
      },
      '/v1/videos': {
        post: {
          summary: '提交异步视频任务',
          parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[!-~]+$' },
            description: '可选，但建议每个新任务生成一次。网络异常后以相同键和请求重试。' }],
          requestBody: { required: true, content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateVideo' }, examples: modes },
          } },
          responses: {
            200: job('提交返回终态，或已存在的任务已完成。请读取 status。'),
            202: job('任务已接受或正在确认。保存 id 并继续查询。'),
            400: error('参数不合法'), 401: error('缺少有效 Key'), 403: error('Key 未获授权'),
            409: error('幂等键已用于不同请求'), 413: error('请求过大'), 429: error('额度或并发已满'),
            503: error('推理供应商未就绪'),
          },
        },
      },
      '/v1/videos/{id}': {
        parameters: [jobId],
        get: {
          summary: '查询任务状态和下载地址',
          responses: { 200: job('任务状态'), 401: error('缺少有效 Key'), 404: error('任务不可访问或不存在') },
        },
      },
      '/v1/videos/{id}/content': {
        parameters: [jobId],
        get: {
          summary: '下载已完成的 H3 视频',
          responses: {
            200: { description: 'MP4 文件', content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } } },
            401: error('缺少有效 Key'), 404: error('成片不可访问或不存在'),
            409: error('任务尚未成功完成'), 503: error('本机服务未就绪'),
          },
        },
      },
    },
    components: {
      securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        CreateVideo: {
          type: 'object', required: ['model', 'prompt'], additionalProperties: false,
          properties: {
            model: { type: 'string', enum: modelIds, description: '调用方使用这里列出的对外 Model ID。' },
            prompt: { type: 'string', minLength: 1, maxLength: H3_LIMITS.prompt },
            duration: { type: 'integer', minimum: minDuration, maximum: maxDuration, default: 5,
              description: '请求的整数秒数。成片按 24 fps 和 17k+5 帧对齐，实际时长以任务响应为准。' },
            ratio: { type: 'string', enum: H3_RATIOS, default: 'adaptive' },
            resolution: { type: 'string', enum: H3_RESOLUTIONS, default: '768p',
              description: '画布档位。768p 档 16:9 的输出尺寸为 1024×576。' },
            audio: { type: 'boolean', default: true, description: '保留原生音轨。' },
            seed: { type: 'integer', minimum: 0, maximum: H3_LIMITS.seed, description: '省略时随机选取。' },
            watermark: { const: false, description: '可省略。' },
            prompt_extend: { const: false, description: '可省略。' },
            media: { type: 'array', maxItems: 2, description: '省略或空数组为文生视频。只传首帧为图生视频。尾帧须与首帧一起传，每种角色最多一张。',
              items: { type: 'object', required: ['type', 'url'], additionalProperties: false, properties: {
                type: { type: 'string', enum: H3_FRAME_TYPES },
                url: { type: 'string', description: 'PNG、JPEG 或 WebP。可传 data:image/…;base64,… 或已在本机加入允许列表的 HTTPS 素材地址。使用内联图像时整个 JSON 仍受请求大小限制。' },
              } },
            },
          },
        },
        Video: {
          type: 'object', required: ['id', 'model', 'status', 'price_micros', 'currency'],
          properties: {
            id: { type: 'string' }, object: { const: 'video' }, model: { type: 'string' },
            status: { enum: ['submitting', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired', 'submission_unknown'],
              description: 'submission_unknown 表示上游是否已接收尚未确认。请用原任务 ID 查询。' },
            created_at: { type: 'integer' }, updated_at: { type: 'integer' },
            duration: { type: 'number' },
            content_url: { type: 'string', description: '成功后返回的下载路径。' },
            currency: { const: 'USD' }, price_micros: { type: 'integer' }, cost_micros: { type: 'integer' },
            error: { $ref: '#/components/schemas/Error/properties/error' },
          },
        },
        Error: { type: 'object', properties: { error: { type: 'object', properties: {
          message: { type: 'string' }, code: { type: 'string' }, type: { type: 'string' },
        } } } },
      },
    },
  };
}
