<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, formatDate } from '../api.js';
import { notify, run } from '../store.js';
import UiIcon from '../components/UiIcon.vue';
import UiModal from '../components/UiModal.vue';
import SecretModal from '../components/SecretModal.vue';
import EmptyState from '../components/EmptyState.vue';

const providers = ref([]), loading = ref(true), modal = ref(''), busy = ref(false), selected = ref(null), secret = ref(null), modelModal = ref(false);
const blank = () => ({
  name: '', description: '', provider_type: 'tunnel', base_url: '', api_key: '', max_concurrency: 4, enabled: true,
  client_mode: 'regex', client_pattern: '', client_error_field: 'message', client_error_message: '', client_error_code: '',
  models: [{ name: '', upstream_name: '', input_price: 0, output_price: 0 }],
});
const form = reactive(blank());
const modelForm = reactive({ name: '', upstream_name: '', input_price: 0, output_price: 0 });
async function load() { const data = await api('GET', '/api/admin/providers'); providers.value = data.providers; loading.value = false; }
onMounted(() => { load(); window.addEventListener('relay-refresh', load); });
onBeforeUnmount(() => window.removeEventListener('relay-refresh', load));
function openCreate() { Object.assign(form, blank()); selected.value = null; modal.value = 'edit'; }
function openEdit(provider) {
  selected.value = provider;
  Object.assign(form, {
    name: provider.name, description: provider.description, provider_type: provider.provider_type,
    base_url: provider.base_url, api_key: '', max_concurrency: provider.max_concurrency, enabled: provider.enabled,
    client_mode: provider.client_mode, client_pattern: provider.client_pattern,
    client_error_field: provider.client_error_field, client_error_message: provider.client_error_message,
    client_error_code: provider.client_error_code, models: [],
  });
  modal.value = 'edit';
}
async function save() {
  busy.value = true;
  const result = await run(() => selected.value ? api('PATCH', `/api/admin/providers/${selected.value.id}`, form) : api('POST', '/api/admin/providers', form));
  busy.value = false;
  if (!result) return;
  modal.value = '';
  if (result.token) showSecret(result, form.name);
  notify(selected.value ? '供应商设置已保存' : '供应商已创建');
  await load();
}
function showSecret(result, name) {
  const origin = `${window.location.origin}${(import.meta.env.VITE_API_BASE || import.meta.env.BASE_URL).replace(/\/$/, '')}`;
  secret.value = { title: `连接 ${name}`, token: result.token, command: `utoken up --cloud-url ${origin} --provider-id ${result.id || selected.value.id} --provider-token ${result.token} --local-base-url http://127.0.0.1:8080` };
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
function openModel(provider) { selected.value = provider; Object.assign(modelForm, { name: '', upstream_name: '', input_price: 0, output_price: 0 }); modelModal.value = true; }
async function addModel() {
  const result = await run(() => api('POST', `/api/admin/providers/${selected.value.id}/models`, modelForm));
  if (result) { modelModal.value = false; notify('模型已添加'); load(); }
}
async function updateModel(model) {
  const result = await run(() => api('PATCH', `/api/admin/models/${model.id}`, { upstream_name: model.upstream_name, input_price: model.input_price, output_price: model.output_price, enabled: model.enabled }));
  if (result) notify('模型别名、价格与状态已保存');
}
async function removeModel(model) {
  if (!window.confirm(`确定删除模型 ${model.name} 吗？`)) return;
  const result = await run(() => api('DELETE', `/api/admin/models/${model.id}`));
  if (result) { notify('模型已删除'); load(); }
}
</script>
<template>
  <section class="panel">
    <header class="panel-header"><div><h2>供应商与模型 <span class="count">{{ providers.length }}</span></h2><p>支持本地反向隧道、OpenAI 和 Anthropic 云端直连，一个供应商可配置多个模型别名</p></div><button class="primary" @click="openCreate"><UiIcon name="plus" :size="17" />添加供应商</button></header>
    <div v-if="loading" class="table-loading">正在加载供应商…</div>
    <EmptyState v-else-if="!providers.length" icon="server" title="添加第一个供应商" text="接入家中台式机，或添加 OpenAI / Anthropic 兼容云端供应商。"><button class="primary" @click="openCreate"><UiIcon name="plus" :size="16" />添加供应商</button></EmptyState>
    <div v-else class="provider-list">
      <article v-for="provider in providers" :key="provider.id" class="provider-card">
        <div class="provider-main">
          <div class="provider-avatar"><UiIcon :name="provider.provider_type === 'tunnel' ? 'server' : 'cloud'" :size="22" /></div>
          <div class="provider-info"><div class="provider-title"><h3>{{ provider.name }}</h3><span class="badge neutral">{{ { tunnel: '本地隧道', openai: 'OpenAI', anthropic: 'Anthropic' }[provider.provider_type] }}</span><span class="badge" :class="!provider.enabled ? 'neutral' : provider.healthy ? 'success' : provider.online ? 'warning' : 'neutral'"><i></i>{{ !provider.enabled ? '已停用' : provider.healthy ? (provider.provider_type === 'tunnel' ? '在线' : '已配置') : provider.online ? '推理异常' : '离线' }}</span></div><p>{{ provider.description || (provider.provider_type === 'tunnel' ? '自托管 OpenAI 兼容模型节点' : provider.base_url) }}</p><div class="provider-meta"><span>ID {{ provider.id }}</span><span v-if="provider.provider_type === 'tunnel'">凭据 {{ provider.token_prefix }}</span><span v-else>密钥 {{ provider.api_key_prefix }}</span><span v-if="provider.client_pattern">客户端 {{ provider.client_pattern }}</span><span v-if="provider.provider_type === 'tunnel'">最后心跳 {{ formatDate(provider.last_seen_at) }}</span><span v-if="provider.last_latency_ms !== null && provider.provider_type === 'tunnel'">延迟 {{ provider.last_latency_ms }} ms</span></div><p v-if="provider.online && !provider.healthy" class="inline-error">{{ provider.health_message }}</p></div>
          <div class="provider-capacity"><span>实时并发</span><strong>{{ provider.active }}<small> / {{ provider.max_concurrency || '∞' }}</small></strong></div>
          <div class="row-actions"><button class="button small" @click="openEdit(provider)"><UiIcon name="edit" :size="15" />设置</button><button class="button small" @click="toggle(provider)">{{ provider.enabled ? '停用' : '启用' }}</button><button v-if="provider.provider_type === 'tunnel'" class="button small" title="重置连接凭据" @click="rotate(provider)"><UiIcon name="refresh" :size="15" /></button></div>
        </div>
        <div class="model-table"><div class="model-table-head"><span>对外别名 → 上游模型与计费</span><button class="text-button" @click="openModel(provider)"><UiIcon name="plus" :size="14" />添加模型</button></div><div class="model-row model-labels"><span>对外别名</span><span>上游模型名称</span><span>输入价格 ($)</span><span>输出价格 ($)</span><span>状态</span><span></span></div><div v-for="model in provider.models" :key="model.id" class="model-row"><code class="model-name">{{ model.name }}</code><input v-model="model.upstream_name" aria-label="上游模型名称" @change="updateModel(model)" /><input v-model.number="model.input_price" type="number" min="0" step="0.01" aria-label="输入价格" @change="updateModel(model)" /><input v-model.number="model.output_price" type="number" min="0" step="0.01" aria-label="输出价格" @change="updateModel(model)" /><button class="switch" :class="{ on: model.enabled }" role="switch" :aria-checked="model.enabled" @click="model.enabled = !model.enabled; updateModel(model)"><i></i></button><button class="icon-button subtle" title="删除模型" @click="removeModel(model)"><UiIcon name="trash" :size="15" /></button></div></div>
      </article>
    </div>
  </section>
  <UiModal v-if="modal === 'edit'" :title="selected ? '供应商设置' : '添加供应商'" :subtitle="selected ? '修改连接、模型并发和客户端访问规则。' : '选择本地反向隧道或云端 OpenAI / Anthropic 供应商。'" wide @close="modal = ''">
    <form id="provider-form" class="stack" @submit.prevent="save">
      <div class="form-grid two"><div class="field"><label>供应商名称</label><input v-model="form.name" placeholder="例如：家中 4090 / OpenAI 主账号" required /></div><div class="field"><label>供应商类型</label><select v-model="form.provider_type" :disabled="!!selected"><option value="tunnel">本地反向隧道</option><option value="openai">OpenAI 兼容云端</option><option value="anthropic">Anthropic Messages</option></select></div></div>
      <div class="field"><label>描述</label><input v-model="form.description" placeholder="硬件、账号或用途（可选）" /></div>
      <template v-if="form.provider_type !== 'tunnel'"><div class="form-grid two"><div class="field"><label>上游 Base URL</label><input v-model="form.base_url" :placeholder="form.provider_type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'" required /></div><div class="field"><label>上游 API Key</label><input v-model="form.api_key" type="password" :placeholder="selected ? '留空则保留现有密钥' : 'sk-...'" :required="!selected" /><span class="help-text">使用 AES-256-GCM 加密存储，不会通过管理接口返回。</span></div></div></template>
      <div class="field"><label>最大并发请求</label><input v-model.number="form.max_concurrency" type="number" min="0" required /><span class="help-text">0 表示不限制，云端直连供应商同样生效。</span></div>
      <div class="form-section-title">客户端校验<span>可选，按 User-Agent 放行</span></div>
      <div class="form-grid two"><div class="field"><label>匹配方式</label><select v-model="form.client_mode"><option value="regex">正则表达式</option><option value="template">模板（* 通配）</option></select></div><div class="field"><label>User-Agent 规则</label><input v-model="form.client_pattern" :placeholder="form.client_mode === 'regex' ? '^Umeko/0\\.7\\.2$' : 'Umeko/*'" /><span class="help-text">留空表示不校验。示例只接受 Umeko/0.7.2。</span></div></div>
      <div class="form-grid three"><div class="field"><label>错误字段（error 内）</label><input v-model="form.client_error_field" placeholder="message" /></div><div class="field"><label>错误代码</label><input v-model="form.client_error_code" placeholder="client_mismatch" /></div><div class="field"><label>自定义错误提示</label><input v-model="form.client_error_message" placeholder="{{provider}} 不支持的客户端：{{userAgent}}" /></div></div>
      <template v-if="!selected"><div class="form-section-title">模型别名与单价<span>每百万 Token，美元</span></div><div v-for="(model, index) in form.models" :key="index" class="model-form-row extended"><input v-model="model.name" placeholder="对外别名，如 fast" required /><input v-model="model.upstream_name" placeholder="上游模型，如 gpt-4.1-mini" /><input v-model.number="model.input_price" type="number" min="0" step="0.01" aria-label="输入价格" /><input v-model.number="model.output_price" type="number" min="0" step="0.01" aria-label="输出价格" /><button v-if="form.models.length > 1" type="button" class="icon-button" @click="form.models.splice(index, 1)"><UiIcon name="close" :size="16" /></button></div><button type="button" class="text-button self-start" @click="form.models.push({ name: '', upstream_name: '', input_price: 0, output_price: 0 })"><UiIcon name="plus" :size="14" />再添加一个模型</button></template>
    </form>
    <template #footer><button @click="modal = ''">取消</button><button class="primary" form="provider-form" :disabled="busy">{{ busy ? '保存中…' : '保存设置' }}</button></template>
  </UiModal>
  <UiModal v-if="modelModal" title="添加模型别名" subtitle="客户端请求别名，转发时替换为上游真实模型名。" @close="modelModal = false"><form id="model-form" class="stack" @submit.prevent="addModel"><div class="form-grid two"><div class="field"><label>对外模型别名</label><input v-model="modelForm.name" placeholder="例如 fast" required /></div><div class="field"><label>上游模型名称</label><input v-model="modelForm.upstream_name" placeholder="留空则与别名相同" /></div></div><div class="form-grid two"><div class="field"><label>输入价格 ($ / 1M)</label><input v-model.number="modelForm.input_price" type="number" min="0" step="0.01" /></div><div class="field"><label>输出价格 ($ / 1M)</label><input v-model.number="modelForm.output_price" type="number" min="0" step="0.01" /></div></div></form><template #footer><button @click="modelModal = false">取消</button><button class="primary" form="model-form">添加模型</button></template></UiModal>
  <SecretModal v-if="secret" :title="secret.title" :secret="secret.token" :command="secret.command" description="这是供应商连接凭据，不是客户端 API Key。请勿对外公开。" @close="secret = null" />
</template>
