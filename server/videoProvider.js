import { decryptProviderKey } from './providerCrypto.js';
import { H3_FRAME_TYPES, H3_IMAGE_DATA, H3_LIMITS, H3_RATIOS, H3_RESOLUTIONS, isH3 } from './h3.js';

export const isVideoProvider = (type) => ['seedance', 'wan', 'video_tunnel'].includes(type);
export const videoError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const mediaTypes = {
  first_frame: 'image_url',
  last_frame: 'image_url',
  reference_image: 'image_url',
  reference_video: 'video_url',
  reference_audio: 'audio_url',
  file: null,
  link: null,
};
const ratios = ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) return url;
  } catch { /* Invalid URL. */ }
  return null;
}

export function videoBaseUrl(type, value) {
  const url = httpsUrl(value);
  if (!url || url.search) throw videoError('视频供应商需要 HTTPS Base URL');
  const allowed = type === 'seedance'
    ? url.hostname === 'ark.cn-beijing.volces.com' && ['/api/v3', '/api/plan/v3'].includes(url.pathname.replace(/\/$/, ''))
    : /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(url.hostname) && url.pathname.replace(/\/$/, '') === '/api/v1';
  if (!allowed || url.port) throw videoError('请填写该视频供应商的官方 Base URL，包含 API 版本路径');
  return url.href.replace(/\/$/, '');
}

export function videoRequest(input, provider) {
  const type = provider.provider_type;
  const seedance = type === 'seedance';
  const local = type === 'video_tunnel';
  const h3 = isH3(provider);
  const supported = ['model', 'prompt', 'media', 'duration', 'ratio', 'resolution', 'audio', 'watermark',
    ...(seedance ? [] : ['seed', 'prompt_extend'])];
  if (Object.keys(input).some((field) => !supported.includes(field))) throw videoError('请求中包含此视频供应商不支持的字段');
  const { prompt, media = [], duration, ratio, resolution, audio, watermark, seed, prompt_extend } = input;
  const promptLimit = h3 ? H3_LIMITS.prompt : 10000;
  if ((h3 || prompt !== undefined) && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > promptLimit)) {
    throw videoError(`prompt 必须是 1 至 ${promptLimit} 个字符的文本`);
  }
  if (!Array.isArray(media) || media.length > 20 || (!prompt && !media.length)) {
    throw videoError('请填写 prompt 或提供 1 至 20 项 media 素材');
  }
  const entryTypes = media.map((entry) => {
    if (!entry || !Object.hasOwn(mediaTypes, entry.type) || (seedance && !mediaTypes[entry.type])
      || (h3 && !H3_FRAME_TYPES.includes(entry.type))) throw videoError('此视频供应商不支持该素材类型');
    if (!httpsUrl(entry.url) && !(h3 && typeof entry.url === 'string' && H3_IMAGE_DATA.test(entry.url))) {
      throw videoError(h3 ? 'H3 素材须为 HTTPS URL 或 PNG、JPEG、WebP 的 Base64 Data URL' : '素材必须使用可公开访问的 HTTPS URL');
    }
    return entry.type;
  });
  const first = entryTypes.filter((value) => value === 'first_frame').length;
  const last = entryTypes.filter((value) => value === 'last_frame').length;
  if (first > 1 || last > 1 || (last && !first) || ((first || last) && first + last !== media.length)) {
    throw videoError('首尾帧模式须包含一张首帧，可选一张尾帧，不能混用参考素材');
  }
  if (entryTypes.filter((value) => ['file', 'link'].includes(value)).length > 1) {
    throw videoError('文档和网页素材合计最多一项');
  }
  if (duration !== undefined) {
    const [minimum, maximum] = h3 ? H3_LIMITS.duration : [2, 30];
    if (!Number.isInteger(duration) || ((h3 || duration !== -1) && (duration < minimum || duration > maximum))) {
      throw videoError(h3 ? `H3 duration 必须为 ${minimum} 至 ${maximum} 的整数秒`
        : 'duration 必须为 2 至 30 的整数秒或 -1，具体范围由上游模型决定');
    }
  }
  if (ratio !== undefined && !(h3 ? H3_RATIOS : ratios).includes(ratio)) throw videoError('ratio 不合法');
  const res = typeof resolution === 'string' ? resolution.toLowerCase() : resolution;
  const resolutions = h3 ? H3_RESOLUTIONS : ['480p', '720p', '1080p', ...(seedance || local ? ['4k'] : []),
    ...(local ? ['512p', '768p'] : [])];
  if (res !== undefined && !resolutions.includes(res)) {
    throw videoError('resolution 不受此视频供应商支持');
  }
  for (const option of [audio, watermark, prompt_extend]) {
    if (option !== undefined && typeof option !== 'boolean') throw videoError('audio、watermark 和 prompt_extend 必须为布尔值');
  }
  if (h3 && (watermark || prompt_extend)) throw videoError('H3 不支持 watermark 或 prompt_extend');
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < (h3 ? 0 : -1)
    || seed > (h3 ? H3_LIMITS.seed : 2147483647))) throw videoError('seed 不合法');
  if (prompt_extend === false && entryTypes.some((value) => ['file', 'link'].includes(value))) {
    throw videoError('文档或网页素材需要启用 prompt_extend');
  }
  const model = provider.upstream_name || provider.name;
  if (local) {
    return { model, prompt, media: media.map(({ type, url }) => ({ type, url })),
      duration, ratio, resolution: res, audio, watermark, seed, prompt_extend };
  }
  const parameters = { duration, ratio, watermark };
  if (seedance) {
    const content = media.map(({ type: role, url }) => {
      const kind = mediaTypes[role];
      return { type: kind, [kind]: { url }, role };
    });
    if (prompt) content.unshift({ type: 'text', text: prompt });
    return { model, content, ...parameters, resolution: res, generate_audio: audio };
  }
  return {
    model,
    input: { prompt, media: media.length ? media.map(({ type, url }) => ({ type, url })) : undefined },
    parameters: { ...parameters, resolution: res?.toUpperCase(), audio, seed, prompt_extend },
  };
}

export async function requestVideoProvider(provider, { body, taskId, tunnel, fetcher = fetch }) {
  if (provider.provider_type === 'video_tunnel') {
    const path = taskId ? `/v1/videos/${encodeURIComponent(taskId)}` : '/v1/videos';
    const response = await tunnel.forward({ id: provider.provider_id ?? provider.id }, {
      method: body ? 'POST' : 'GET', path, body: body ? JSON.stringify(body) : '', timeoutMs: 12000,
      headers: { accept: 'application/json' },
    });
    if (response.status < 200 || response.status >= 300) {
      response.stream.destroy();
      const error = videoError(`本地服务返回 HTTP ${response.status}`, 502);
      error.rejected = [400, 401, 403, 404, 413, 422, 429].includes(response.status);
      throw error;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.stream) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) throw videoError('本地视频任务响应过大', 502);
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return normalizeVideo(data, true, !taskId, true);
  }

  const seedance = provider.provider_type === 'seedance';
  const base = videoBaseUrl(provider.provider_type, provider.base_url);
  const path = seedance ? '/contents/generations/tasks' : taskId ? '/tasks' : '/services/aigc/video-generation/video-synthesis';
  const endpoint = taskId ? `${base}${path}/${encodeURIComponent(taskId)}` : base + path;
  let key;
  try { key = decryptProviderKey(provider); } catch { /* Credentials must be configured by the admin. */ }
  if (!key) {
    const error = videoError('视频供应商的 API Key 不可用', 503);
    error.rejected = true;
    throw error;
  }
  const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
  if (body) {
    headers['content-type'] = 'application/json';
    if (!seedance) headers['X-DashScope-Async'] = 'enable';
  }
  const response = await fetcher(endpoint, {
    method: body ? 'POST' : 'GET', headers, redirect: 'error',
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = videoError(`视频供应商返回 HTTP ${response.status}`, response.status === 429 ? 429 : response.status === 400 ? 400 : 502);
    error.rejected = [400, 401, 403, 404, 413, 422, 429].includes(response.status);
    throw error;
  }
  const data = await response.json();
  if (!seedance && data.code && !data.output?.task_id) {
    const error = videoError('百炼拒绝了视频任务，请检查模型、参数和上游账户');
    error.rejected = true;
    throw error;
  }
  return normalizeVideo(data, seedance, !taskId);
}

function normalizeVideo(data, seedance, creating, local = false) {
  const output = seedance ? data : data.output;
  const id = seedance ? output?.id : output?.task_id;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw videoError('上游未返回有效任务 ID', 502);
  const rawStatus = seedance ? output.status : output.task_status;
  const statuses = {
    pending: 'queued', queued: 'queued', running: 'running', succeeded: 'succeeded',
    failed: 'failed', canceled: 'cancelled', cancelled: 'cancelled', expired: 'expired', unknown: 'expired',
  };
  const state = String(rawStatus || '').toLowerCase();
  const status = Object.hasOwn(statuses, state) ? statuses[state] : creating && !rawStatus ? 'queued' : null;
  if (!status) throw videoError('上游返回了未知任务状态', 502);
  const url = local ? undefined : httpsUrl(seedance ? output.content?.video_url : output.video_url)?.href;
  const usage = seedance
    ? { completion_tokens: data.usage?.completion_tokens, total_tokens: data.usage?.total_tokens }
    : { duration: data.usage?.duration, input_video_duration: data.usage?.input_video_duration, output_video_duration: data.usage?.output_video_duration };
  const code = seedance ? output.error?.code : output.code;
  return {
    id, status, video_url: url, ...(local && status === 'succeeded' ? { local_content: true } : {}),
    duration: seedance ? output.duration : data.usage?.output_video_duration,
    resolution: seedance ? output.resolution : (Number.isFinite(data.usage?.SR) ? `${data.usage.SR}p` : undefined),
    ratio: seedance ? output.ratio : data.usage?.ratio,
    error_code: typeof code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : undefined,
    usage: Object.fromEntries(Object.entries(usage).filter(([, value]) => Number.isFinite(value) && value >= 0)),
  };
}
