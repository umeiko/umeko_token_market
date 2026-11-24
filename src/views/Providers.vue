<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, copyText, formatDate } from '../api.js';
import { notify, run } from '../store.js';
import UiIcon from '../components/UiIcon.vue';
import UiModal from '../components/UiModal.vue';
import SecretModal from '../components/SecretModal.vue';
import EmptyState from '../components/EmptyState.vue';

const isVideo = (type) => ['seedance', 'wan', 'video_tunnel'].includes(type);
const isTunnel = (type) => ['tunnel', 'video_tunnel'].includes(type);
const providerNames = { tunnel: '本地 API 隧道', video_tunnel: '本地视频隧道', openai: 'OpenAI', anthropic: 'Anthropic', seedance: '火山方舟 Seedance', wan: '阿里百炼 Wan 3.0' };
const baseExamples = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  seedance: 'https://ark.cn-beijing.volces.com/api/v3',
  wan: 'https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1',
};

const providers = ref([]), loading = ref(true), modal = ref(''), busy = ref(false), selected = ref(null), secret = ref(null), upstreamSecret = ref(null), modelModal = ref(false);
const pairing = ref(null), copiedPairing = ref(false), issuing = ref(false);
const groups = computed(() => providers.value.filter((provider) => provider.parent_provider_id == null).map((root) => {
  const children = providers.value.filter((provider) => provider.parent_provider_id === root.id).sort((a, b) => a.id - b.id);
  const connections = [root, ...children];
  return { root, connections, ready: connections.filter((provider) => provider.enabled && provider.healthy).length };
}));
const parentOptions = computed(() => {
  if (selected.value && groups.value.some(({ root, connections }) => root.id === selected.value.id && connections.length > 1)) return [];
  return groups.value.map(({ root }) => root)
    .filter((root) => root.id !== selected.value?.id && isTunnel(root.provider_type));
});
function connectionStatus(provider) {
  if (!provider.enabled) return ['已停用', 'neutral'];
  if (provider.healthy) return ['就绪', 'success'];
  return provider.online ? ['等待本地服务', 'warning'] : ['未连接', 'neutral'];
}
let watchDiscovery;
const blank = () => ({
  name: '', description: '', provider_type: 'tunnel', parent_provider_id: null, base_url: '', api_key: '', max_concurrency: 4, enabled: true,
  client_mode: 'regex', client_pattern: '', client_error_field: 'message', client_error_message: '', client_error_code: '',
  models: [{ name: '', upstream_name: '', context_length: 0, input_price: 0, output_price: 0 }],
});
const form = reactive(blank());
const modelForm = reactive({ name: '', upstream_name: '', context_length: 0, input_price: 0, output_price: 0 });
async function load() { const data = await api('GET', '/api/admin/providers'); providers.value = data.providers; loading.value = false; }
onMounted(() => {
  load();
  window.addEventListener('relay-refresh', load);
  watchDiscovery = setInterval(() => {
    if (!document.hidden && !modal.value && !modelModal.value && !secret.value
      && !upstreamSecret.value && !document.activeElement?.matches('.model-table input')) load().catch(() => {});
  }, 5000);
});
onBeforeUnmount(() => {
  clearInterval(watchDiscovery);
  window.removeEventListener('relay-refresh', load);
});
function openCreate() { Object.assign(form, blank()); selected.value = null; modal.value = 'edit'; }
function openEdit(provider) {
  selected.value = provider;
  Object.assign(form, {
    name: provider.name, description: provider.description, provider_type: provider.provider_type,
    parent_provider_id: provider.parent_provider_id ?? null,
    base_url: provider.base_url, api_key: '', max_concurrency: provider.max_concurrency, enabled: provider.enabled,
    client_mode: provider.client_mode, client_pattern: provider.client_pattern,
    client_error_field: provider.client_error_field, client_error_message: provider.client_error_message,
    client_error_code: provider.client_error_code, models: [],
  });
  modal.value = 'edit';
}
async function revealUpstream(provider) {
  const result = await run(() => api('GET', `/api/admin/providers/${provider.id}/reveal`));
  if (result?.key) upstreamSecret.value = result.key;
  else if (result?.legacy) notify('该上游密钥是早期未加密记录，无法恢复，请重新输入一次', true);
}
async function save() {
  busy.value = true;
  const payload = { ...form, parent_provider_id: isTunnel(form.provider_type) ? form.parent_provider_id : null };
  if (!selected.value && isTunnel(form.provider_type)) payload.models = [];
  const result = await run(() => selected.value ? api('PATCH', `/api/admin/providers/${selected.value.id}`, payload) : api('POST', '/api/admin/providers', payload));
  busy.value = false;
  if (!result) return;
  modal.value = '';
  if (result.pairing) showPairing(result.pairing, { name: form.name, provider_type: form.provider_type });
  else if (result.token) showSecret(result, form.name);
  notify(selected.value ? '供应商设置已保存' : '供应商已创建');
  await load();
}
function showPairing(result, provider) {
  const base = (import.meta.env.VITE_API_BASE || import.meta.env.BASE_URL).replace(/\/$/, '');
  const link = new URL(base || '/', window.location.origin);
  link.hash = new URLSearchParams({ utoken: '1', id: result.id, code: result.code,
    service: provider.provider_type === 'video_tunnel' ? 'video' : 'api' }).toString();
  pairing.value = { name: provider.name, url: link.href };
  copiedPairing.value = false;
}
async function requestPairing(provider) {
  if (issuing.value) return;
  issuing.value = true;
  try {
    const result = await run(() => api('POST', `/api/admin/providers/${provider.id}/pairing`, {}));
    if (result) showPairing(result, provider);
  } finally { issuing.value = false; }
}
async function copyPairing() {
  try {
    await copyText(pairing.value.url);
    copiedPairing.value = true;
  } catch { notify('请选中配对链接并手动复制', true); }
}
function showSecret(result, name) {
  const type = selected.value?.provider_type || form.provider_type;
  const mode = type === 'video_tunnel' ? ' --service-type video' : ' --service-type api';
  const origin = `${window.location.origin}${(import.meta.env.VITE_API_BASE || import.meta.env.BASE_URL).replace(/\/$/, '')}`;
  secret.value = { title: `连接 ${name}`, token: result.token, command: `utoken up --cloud-url ${origin} --provider-id ${result.id || selected.value.id} --provider-token ${result.token} --local-base-url http://127.0.0.1:8080${mode}` };
}
async function toggle(provider) {
  const result = await run(() => api('PATCH', `/api/admin/providers/${provider.id}`, { enabled: !provider.enabled }));
  if (result) { notify(provider.enabled ? '供应商已停用' : '供应商已启用'); load(); }
}
async function rotate(provider) {
  if (!window.confirm(`确定重置“${provider.name}”的连接凭据吗？旧本地端会立即断开。`)) return;
  const result = await run(() => api('POST', `/api/admin/providers/${provider.id}/rotate`));
  if (result) { selected.value = provider; showSecret(result, provider.name); }
}
function openModel(provider, upstream = '') { selected.value = provider; Object.assign(modelForm, { name: upstream, upstream_name: upstream, context_length: 0, input_price: 0, output_price: 0 }); modelModal.value = true; }
async function addModel() {
  const result = await run(() => api('POST', `/api/admin/providers/${selected.value.id}/models`, modelForm));
  if (result) { modelModal.value = false; notify('模型已添加'); load(); }
}
async function updateModel(model) {
  const result = await run(() => api('PATCH', `/api/admin/models/${model.id}`, { upstream_name: model.upstream_name, context_length: model.context_length, input_price: model.input_price, output_price: model.output_price, enabled: model.enabled }));
  if (result) notify('模型别名、上下文、价格与状态已保存');
}
async function removeModel(model) {
  if (!window.confirm(`确定删除模型 ${model.name} 吗？`)) return;
  const result = await run(() => api('DELETE', `/api/admin/models/${model.id}`));
  if (result) { notify('模型已删除'); load(); }
}
</script>
<template>
  <section class="panel">
    <header class="panel-header"><div><h2>供应商与模型 <span class="count">{{ groups.length }}</span></h2><p>配置本地隧道、云端聊天和视频生成供应商。</p></div><button class="primary" @click="openCreate"><UiIcon name="plus" :size="17" />添加供应商</button></header>
    <div v-if="loading" class="table-loading">正在加载供应商…</div>
    <EmptyState v-else-if="!providers.length" icon="server" title="添加第一个供应商" text="接入家中台式机，或添加 OpenAI / Anthropic 兼容云端供应商。"><button class="primary" @click="openCreate"><UiIcon name="plus" :size="16" />添加供应商</button></EmptyState>
    <div v-else class="provider-list">
      <article v-for="group in groups" :key="group.root.id" class="provider-card">
        <div v-if="group.connections.length > 1" class="provider-main">
          <div class="provider-avatar"><UiIcon name="server" :size="22" /></div>
          <div class="provider-info">
            <div class="provider-title">
              <h3>{{ group.root.name }}</h3>
              <span class="badge neutral">本地供应商</span>
              <span class="badge" :class="group.ready ? 'success' : 'neutral'"><i></i>{{ group.ready }} / {{ group.connections.length }} 个服务就绪</span>
            </div>
            <p v-if="group.root.description">{{ group.root.description }}</p>
          </div>
        </div>
        <component :is="group.connections.length > 1 ? 'details' : 'div'" v-for="provider in group.connections" :key="provider.id"
          :class="{ 'provider-connection': group.connections.length > 1 }">
        <summary v-if="group.connections.length > 1">
          <strong>{{ provider.models.map((model) => model.name).join(' · ') || provider.name }}</strong>
          <span class="badge neutral">{{ isVideo(provider.provider_type) ? '视频' : '聊天' }}</span>
          <span class="badge" :class="connectionStatus(provider)[1]"><i></i>{{ connectionStatus(provider)[0] }}</span>
        </summary>
        <div class="provider-main">
          <div class="provider-avatar"><UiIcon :name="isTunnel(provider.provider_type) ? 'server' : 'cloud'" :size="22" /></div>
          <div class="provider-info"><div class="provider-title"><h3>{{ provider.name }}</h3><span class="badge neutral">{{ providerNames[provider.provider_type] }}</span><span class="badge" :class="!provider.enabled ? 'neutral' : provider.healthy ? 'success' : provider.online ? 'warning' : 'neutral'"><i></i>{{ !provider.enabled ? '已停用' : provider.healthy ? (isTunnel(provider.provider_type) ? '在线' : '已配置') : provider.online ? '推理异常' : '离线' }}</span></div><p>{{ provider.description || (isTunnel(provider.provider_type) ? (isVideo(provider.provider_type) ? '自托管异步视频生成服务' : '自托管 OpenAI 兼容服务') : provider.base_url) }}</p><div class="provider-meta"><span>ID {{ provider.id }}</span><span v-if="isTunnel(provider.provider_type)">凭据 {{ provider.token_prefix }}</span><span v-else>密钥 {{ provider.api_key_prefix }}</span><span v-if="isTunnel(provider.provider_type)">最后心跳 {{ formatDate(provider.last_seen_at) }}</span><span v-if="provider.last_latency_ms !== null && isTunnel(provider.provider_type)">延迟 {{ provider.last_latency_ms }} ms</span></div><p v-if="provider.online && !provider.healthy" class="inline-error">{{ provider.health_message }}</p></div>
          <div class="provider-capacity"><span>{{ isVideo(provider.provider_type) ? '未完成视频任务' : '实时并发' }}</span><strong>{{ provider.active }}<small> / {{ provider.max_concurrency || '∞' }}</small></strong></div>
          <div class="row-actions"><button v-if="isTunnel(provider.provider_type) && provider.enabled" class="button small" @click="requestPairing(provider)">配对链接</button><button class="button small" @click="openEdit(provider)"><UiIcon name="edit" :size="15" />设置</button><button class="button small" @click="toggle(provider)">{{ provider.enabled ? '停用' : '启用' }}</button><button v-if="isTunnel(provider.provider_type)" class="button small" title="重置连接凭据" @click="rotate(provider)"><UiIcon name="refresh" :size="15" /></button></div>
        </div>
        <section v-if="isTunnel(provider.provider_type)" class="discovery">
          <div class="discovery-head"><strong>本机上报</strong>
            <span v-if="provider.discovery">健康检查 {{ provider.discovery.health_path || '—' }} · {{ provider.discovery.local_auth ? '本地服务已配置 Key' : '本地服务未配置 Key' }}</span>
          </div>
          <div v-if="provider.discovery?.models.length" class="discovered-models">
            <div v-for="id in provider.discovery.models" :key="id" class="discovered-model">
              <code>{{ id }}</code>
              <span v-if="provider.models.some(model => model.upstream_name === id || (!model.upstream_name && model.name === id))">已配置映射</span>
              <button v-else class="text-button" @click="openModel(provider, id)">添加为对外模型</button>
            </div>
          </div>
          <p v-else>{{ provider.discovery ? '本地服务尚未返回模型列表。' : '等待 utoken 连接并上报。' }}</p>
        </section>
        <div class="model-table"><div class="model-table-head"><span>对外别名 → 上游模型与计费</span><button class="text-button" @click="openModel(provider)"><UiIcon name="plus" :size="14" />添加模型</button></div><div class="model-row model-labels"><span>对外别名</span><span>上游模型名称</span><span>上下文 (Token)</span><span>{{ isVideo(provider.provider_type) ? '—' : '输入价格 ($/1M)' }}</span><span>{{ isVideo(provider.provider_type) ? '每条视频 ($)' : '输出价格 ($/1M)' }}</span><span>状态</span><span></span></div><div v-for="model in provider.models" :key="model.id" class="model-row"><code class="model-name">{{ model.name }}</code><input v-model="model.upstream_name" aria-label="上游模型名称" @change="updateModel(model)" /><input v-model.number="model.context_length" type="number" min="0" step="1" aria-label="上下文长度 Token" placeholder="如 262144" @change="updateModel(model)" /><span v-if="isVideo(provider.provider_type)">—</span><input v-else v-model.number="model.input_price" type="number" min="0" step="0.01" aria-label="输入价格" @change="updateModel(model)" /><input v-model.number="model.output_price" type="number" min="0" step="0.01" aria-label="输出价格" @change="updateModel(model)" /><button class="switch" :class="{ on: model.enabled }" role="switch" :aria-checked="model.enabled" @click="model.enabled = !model.enabled; updateModel(model)"><i></i></button><button class="icon-button subtle" title="删除模型" @click="removeModel(model)"><UiIcon name="trash" :size="15" /></button></div></div>
        </component>
      </article>
    </div>
  </section>
  <UiModal v-if="modal === 'edit'" :title="selected ? '供应商设置' : '添加供应商'" :subtitle="selected ? '修改连接和模型并发。' : '选择本地隧道、云端聊天或视频生成供应商。'" wide @close="modal = ''">
    <form id="provider-form" class="stack" @submit.prevent="save">
      <div class="form-grid two"><div class="field"><label>供应商名称</label><input v-model="form.name" placeholder="例如：家中 4090 / OpenAI 主账号" required /></div><div class="field"><label>供应商类型</label><select v-model="form.provider_type" :disabled="!!selected"><option value="tunnel">本地 API 隧道</option><option value="video_tunnel">本地视频隧道</option><option value="openai">OpenAI 兼容云端</option><option value="anthropic">Anthropic Messages</option><option value="seedance">火山方舟 Seedance</option><option value="wan">阿里百炼 Wan 3.0</option></select></div></div>
      <div class="field"><label>描述</label><input v-model="form.description" placeholder="硬件、账号或用途（可选）" /></div>
      <div v-if="isTunnel(form.provider_type) && parentOptions.length" class="field">
        <label for="parent-provider">归属供应商</label>
        <select id="parent-provider" v-model="form.parent_provider_id">
          <option :value="null">独立供应商</option>
          <option v-for="root in parentOptions" :key="root.id" :value="root.id">{{ root.name }}</option>
        </select>
      </div>
      <template v-if="!isTunnel(form.provider_type)"><div class="form-grid two"><div class="field"><label>上游 Base URL</label><input v-model="form.base_url" :placeholder="baseExamples[form.provider_type]" required /></div><div class="field"><label>上游 API Key</label><input v-model="form.api_key" type="password" :placeholder="selected ? '留空则保留现有密钥' : 'sk-...'" :required="!selected" /><button v-if="selected" type="button" class="button small" @click="revealUpstream(selected)"><UiIcon name="copy" :size="14" />查看并复制 Key</button><span class="help-text">仅管理员可解密查看，留空则保留现有密钥。</span></div></div></template>
      <div class="field"><label>{{ isVideo(form.provider_type) ? '最大未完成任务数' : '最大并发请求' }}</label><input v-model.number="form.max_concurrency" type="number" min="0" required /><span class="help-text">0 表示不限制，云端直连供应商同样生效。</span></div>
      <p v-if="!selected && isTunnel(form.provider_type)" class="help-text">保存后会生成配对链接。连接后可从本机上报的模型中选择要开放的模型。</p>
      <template v-if="!selected && !isTunnel(form.provider_type)"><div class="form-section-title">模型别名与单价<span>{{ isVideo(form.provider_type) ? '成功生成后按条结算，美元' : '每百万 Token，美元' }}</span></div><div v-for="(model, index) in form.models" :key="index" class="model-form-row extended"><input v-model="model.name" placeholder="对外别名，如 fast" required /><input v-model="model.upstream_name" placeholder="上游模型，如 gpt-4.1-mini" /><input v-model.number="model.context_length" type="number" min="0" step="1" aria-label="上下文长度 Token" placeholder="上下文，如 262144" /><span v-if="isVideo(form.provider_type)">—</span><input v-else v-model.number="model.input_price" type="number" min="0" step="0.01" aria-label="输入价格" /><input v-model.number="model.output_price" type="number" :min="isVideo(form.provider_type) ? 0.01 : 0" step="0.01" :aria-label="isVideo(form.provider_type) ? '每条视频美元价格' : '输出价格'" /><button v-if="form.models.length > 1" type="button" class="icon-button" @click="form.models.splice(index, 1)"><UiIcon name="close" :size="16" /></button></div><button type="button" class="text-button self-start" @click="form.models.push({ name: '', upstream_name: '', context_length: 0, input_price: 0, output_price: 0 })"><UiIcon name="plus" :size="14" />再添加一个模型</button></template>
    </form>
    <template #footer><button @click="modal = ''">取消</button><button class="primary" form="provider-form" :disabled="busy">{{ busy ? '保存中…' : !selected && isTunnel(form.provider_type) ? '创建并生成配对链接' : '保存设置' }}</button></template>
  </UiModal>
  <UiModal v-if="modelModal" title="添加模型别名" subtitle="客户端请求别名，转发时替换为上游真实模型名。" @close="modelModal = false"><form id="model-form" class="stack" @submit.prevent="addModel"><div class="form-grid two"><div class="field"><label>对外模型别名</label><input v-model="modelForm.name" placeholder="例如 fast" required /></div><div class="field"><label>上游模型名称</label><input v-model="modelForm.upstream_name" placeholder="留空则与别名相同" /></div></div><div class="form-grid two"><div v-if="!isVideo(selected.provider_type)" class="field"><label>输入价格 ($ / 1M)</label><input v-model.number="modelForm.input_price" type="number" min="0" step="0.01" /></div><div class="field"><label>{{ isVideo(selected.provider_type) ? '每条视频 ($)' : '输出价格 ($ / 1M)' }}</label><input v-model.number="modelForm.output_price" type="number" :min="isVideo(selected.provider_type) ? 0.01 : 0" step="0.01" /></div></div><div class="field"><label>上下文长度（Token）</label><input v-model.number="modelForm.context_length" type="number" min="0" step="1" placeholder="256K 填 262144" /><span class="help-text">填写模型支持的最大上下文 Token 数，0 表示未声明。</span></div></form><template #footer><button @click="modelModal = false">取消</button><button class="primary" form="model-form">添加模型</button></template></UiModal>
  <UiModal v-if="pairing" :title="`配对 ${pairing.name}`" subtitle="在运行 utoken 的电脑打开本机控制台，粘贴此链接后连接。" @close="pairing = null">
    <div class="stack">
      <div class="field"><label for="pairing-url">配对链接</label><input id="pairing-url" :value="pairing.url" readonly @focus="$event.target.select()" /></div>
      <p class="help-text">链接仅可使用一次，10 分钟有效。新配对成功后会替换此供应商的现有连接。</p>
    </div>
    <template #footer><button @click="pairing = null">关闭</button><button class="primary" @click="copyPairing">{{ copiedPairing ? '已复制' : '复制配对链接' }}</button></template>
  </UiModal>
  <SecretModal v-if="secret" :title="secret.title" :secret="secret.token" :command="secret.command" description="这是供应商连接凭据，不是客户端 API Key。请勿对外公开。" @close="secret = null" />
  <SecretModal v-if="upstreamSecret" title="上游 API Key" :secret="upstreamSecret" description="仅管理员可见。请妥善保管，不要分享给调用方。" @close="upstreamSecret = null" />
</template>

<style scoped>
.discovery { padding: 13px 18px; border-top: 1px solid var(--border, #dbe5df); }
.discovery-head { display: flex; gap: 8px 14px; align-items: baseline; flex-wrap: wrap; }
.discovery-head span, .discovery p, .discovered-model span { font-size: 12px; opacity: .76; margin: 0; }
.discovery p { padding-top: 7px; }
.discovered-models { display: grid; gap: 4px; margin-top: 8px; }
.discovered-model { display: flex; gap: 8px 14px; flex-wrap: wrap; align-items: center; }
.discovered-model code { overflow-wrap: anywhere; }
.provider-connection { border-top: 1px solid var(--line-soft); }
.provider-connection summary {
  padding: 12px 17px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.provider-connection summary strong { margin-inline: 6px 8px; }
.provider-connection summary .badge { margin-inline-end: 6px; }
.provider-connection[open] summary { background: #f3f7f8; }
</style>
