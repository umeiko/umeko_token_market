<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, formatDate } from '../api.js';
import { notify, run } from '../store.js';
import UiIcon from '../components/UiIcon.vue';
import UiModal from '../components/UiModal.vue';
import SecretModal from '../components/SecretModal.vue';
import EmptyState from '../components/EmptyState.vue';
const providers = ref([]), loading = ref(true), modal = ref(''), busy = ref(false), selected = ref(null), secret = ref(null), modelModal = ref(false);
const blank = () => ({ name: '', description: '', max_concurrency: 4, enabled: true, models: [{ name: '', input_price: 0, output_price: 0 }] });
const form = reactive(blank());
const modelForm = reactive({ name: '', input_price: 0, output_price: 0 });
async function load() { const data = await api('GET', '/api/admin/providers'); providers.value = data.providers; loading.value = false; }
onMounted(() => { load(); window.addEventListener('relay-refresh', load); });
onBeforeUnmount(() => window.removeEventListener('relay-refresh', load));
function openCreate() { Object.assign(form, blank()); selected.value = null; modal.value = 'edit'; }
function openEdit(provider) { selected.value = provider; Object.assign(form, { name: provider.name, description: provider.description, max_concurrency: provider.max_concurrency, enabled: provider.enabled, models: [] }); modal.value = 'edit'; }
async function save() {
  busy.value = true;
  const result = await run(() => selected.value
    ? api('PATCH', `/api/admin/providers/${selected.value.id}`, form)
    : api('POST', '/api/admin/providers', form));
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
function openModel(provider) { selected.value = provider; Object.assign(modelForm, { name: '', input_price: 0, output_price: 0 }); modelModal.value = true; }
async function addModel() {
  const result = await run(() => api('POST', `/api/admin/providers/${selected.value.id}/models`, modelForm));
  if (result) { modelModal.value = false; notify('模型已添加'); load(); }
}
async function updateModel(model) {
  const result = await run(() => api('PATCH', `/api/admin/models/${model.id}`, { input_price: model.input_price, output_price: model.output_price, enabled: model.enabled }));
  if (result) notify('模型价格与状态已保存');
}
async function removeModel(model) {
  if (!window.confirm(`确定删除模型 ${model.name} 吗？`)) return;
  const result = await run(() => api('DELETE', `/api/admin/models/${model.id}`));
  if (result) { notify('模型已删除'); load(); }
}
</script>
<template>
  <section class="panel">
    <header class="panel-header"><div><h2>供应商节点 <span class="count">{{ providers.length }}</span></h2><p>本地端主动连接云端，无需公网 IP 或端口映射</p></div><button class="primary" @click="openCreate"><UiIcon name="plus" :size="17" />添加供应商</button></header>
    <div v-if="loading" class="table-loading">正在加载供应商…</div>
    <EmptyState v-else-if="!providers.length" icon="server" title="添加第一个供应商" text="将家中台式机的模型服务接入云端，并设置对外模型名称与价格。"><button class="primary" @click="openCreate"><UiIcon name="plus" :size="16" />添加供应商</button></EmptyState>
    <div v-else class="provider-list">
      <article v-for="provider in providers" :key="provider.id" class="provider-card">
        <div class="provider-main">
          <div class="provider-avatar"><UiIcon name="server" :size="22" /></div>
          <div class="provider-info"><div class="provider-title"><h3>{{ provider.name }}</h3><span class="badge" :class="!provider.enabled ? 'neutral' : provider.healthy ? 'success' : provider.online ? 'warning' : 'neutral'"><i></i>{{ !provider.enabled ? '已停用' : provider.healthy ? '在线' : provider.online ? '推理异常' : '离线' }}</span></div><p>{{ provider.description || '自托管 OpenAI 兼容模型节点' }}</p><div class="provider-meta"><span>ID {{ provider.id }}</span><span>凭据 {{ provider.token_prefix }}</span><span>最后心跳 {{ formatDate(provider.last_seen_at) }}</span><span v-if="provider.last_latency_ms !== null">延迟 {{ provider.last_latency_ms }} ms</span></div><p v-if="provider.online && !provider.healthy" class="inline-error">{{ provider.health_message }}</p></div>
          <div class="provider-capacity"><span>实时并发</span><strong>{{ provider.active }}<small> / {{ provider.max_concurrency || '∞' }}</small></strong></div>
          <div class="row-actions"><button class="button small" @click="openEdit(provider)"><UiIcon name="edit" :size="15" />设置</button><button class="button small" @click="toggle(provider)">{{ provider.enabled ? '停用' : '启用' }}</button><button class="button small" title="重置连接凭据" @click="rotate(provider)"><UiIcon name="refresh" :size="15" /></button></div>
        </div>
        <div class="model-table"><div class="model-table-head"><span>对外模型与计费</span><button class="text-button" @click="openModel(provider)"><UiIcon name="plus" :size="14" />添加模型</button></div><div class="model-row model-labels"><span>模型名称</span><span>输入价格 / 百万 Token ($)</span><span>输出价格 / 百万 Token ($)</span><span>状态</span><span></span></div><div v-for="model in provider.models" :key="model.id" class="model-row"><code class="model-name">{{ model.name }}</code><input v-model.number="model.input_price" type="number" min="0" step="0.01" aria-label="输入价格" @change="updateModel(model)" /><input v-model.number="model.output_price" type="number" min="0" step="0.01" aria-label="输出价格" @change="updateModel(model)" /><button class="switch" :class="{ on: model.enabled }" role="switch" :aria-checked="model.enabled" @click="model.enabled = !model.enabled; updateModel(model)"><i></i></button><button class="icon-button subtle" title="删除模型" @click="removeModel(model)"><UiIcon name="trash" :size="15" /></button></div></div>
      </article>
    </div>
  </section>
  <UiModal v-if="modal === 'edit'" :title="selected ? '供应商设置' : '添加供应商'" :subtitle="selected ? '修改节点信息和允许的最大并发数。' : '创建后，将一次性连接凭据配置到家中台式机。'" @close="modal = ''">
    <form id="provider-form" class="stack" @submit.prevent="save"><div class="field"><label>供应商名称</label><input v-model="form.name" placeholder="例如：家中 4090 工作站" required /></div><div class="field"><label>描述</label><input v-model="form.description" placeholder="硬件、位置或用途（可选）" /></div><div class="field"><label>最大并发请求</label><input v-model.number="form.max_concurrency" type="number" min="0" required /><span class="help-text">0 表示不限制，建议按显卡能力设置。</span></div><template v-if="!selected"><div class="form-section-title">对外模型与单价<span>每百万 Token，美元</span></div><div v-for="(model, index) in form.models" :key="index" class="model-form-row"><input v-model="model.name" placeholder="例如 qwen3-32b" required /><input v-model.number="model.input_price" type="number" min="0" step="0.01" aria-label="输入价格" /><input v-model.number="model.output_price" type="number" min="0" step="0.01" aria-label="输出价格" /><button v-if="form.models.length > 1" type="button" class="icon-button" @click="form.models.splice(index, 1)"><UiIcon name="close" :size="16" /></button></div><button type="button" class="text-button self-start" @click="form.models.push({ name: '', input_price: 0, output_price: 0 })"><UiIcon name="plus" :size="14" />再添加一个模型</button></template></form>
    <template #footer><button @click="modal = ''">取消</button><button class="primary" form="provider-form" :disabled="busy">{{ busy ? '保存中…' : '保存设置' }}</button></template>
  </UiModal>
  <UiModal v-if="modelModal" title="添加对外模型" subtitle="名称需与客户端请求中的 model 字段一致。" @close="modelModal = false"><form id="model-form" class="stack" @submit.prevent="addModel"><div class="field"><label>模型名称</label><input v-model="modelForm.name" placeholder="例如 qwen3-32b" required /></div><div class="form-grid two"><div class="field"><label>输入价格 ($ / 1M)</label><input v-model.number="modelForm.input_price" type="number" min="0" step="0.01" /></div><div class="field"><label>输出价格 ($ / 1M)</label><input v-model.number="modelForm.output_price" type="number" min="0" step="0.01" /></div></div></form><template #footer><button @click="modelModal = false">取消</button><button class="primary" form="model-form">添加模型</button></template></UiModal>
  <SecretModal v-if="secret" :title="secret.title" :secret="secret.token" :command="secret.command" description="这是供应商连接凭据，不是客户端 API Key。请勿对外公开。" @close="secret = null" />
</template>
