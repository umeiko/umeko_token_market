<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, formatCost, formatDate, formatNumber, percent } from '../api.js';
import { notify, run } from '../store.js';
import UiIcon from '../components/UiIcon.vue';
import UiModal from '../components/UiModal.vue';
import AccessModal from '../components/AccessModal.vue';
import EmptyState from '../components/EmptyState.vue';
const keys = ref([]), loading = ref(true), modal = ref(false), busy = ref(false), selected = ref(null), access = ref(null), rotating = ref(false), models = ref([]);
const apiBase = `${location.origin}${(import.meta.env.VITE_API_BASE || import.meta.env.BASE_URL).replace(/\/$/, '')}/v1`;
const blank = () => ({ name: '', allowed_models: [], token_quota: 1000000, budget_quota: 10, quota_5h: 2000000, quota_week: 20000000, allow_user_apply: false, rpm_limit: 60, concurrency_limit: 2, expires_at: '', enabled: true, reset_usage: false });
const form = reactive(blank());
async function load() {
  const [keyData, providerData] = await Promise.all([api('GET', '/api/admin/keys'), api('GET', '/api/admin/providers')]);
  keys.value = keyData.keys;
  models.value = providerData.providers.flatMap((provider) => provider.models.filter((model) => model.enabled).map((model) => ({ ...model, provider_name: provider.name })));
  loading.value = false;
}
onMounted(() => { load(); window.addEventListener('relay-refresh', load); });
onBeforeUnmount(() => window.removeEventListener('relay-refresh', load));
function openCreate() { selected.value = null; Object.assign(form, blank()); modal.value = true; }
function modelsFor(allowed) { return allowed?.length ? models.value.filter((model) => allowed.includes(model.name)) : models.value; }
function openEdit(key) { selected.value = key; Object.assign(form, { name: key.name, allowed_models: [...(key.allowed_models || [])], token_quota: key.token_quota, budget_quota: key.budget_quota, quota_5h: key.quota_5h, quota_week: key.quota_week, allow_user_apply: key.allow_user_apply, rpm_limit: key.rpm_limit, concurrency_limit: key.concurrency_limit, expires_at: key.expires_at || '', enabled: key.enabled, reset_usage: false }); modal.value = true; }
function openAccess(key) { access.value = { name: key.name, apiKey: '', keyPrefix: key.key_prefix, models: modelsFor(key.allowed_models) }; }
async function rotateAccess() {
  const key = keys.value.find((item) => item.name === access.value.name);
  if (!key) return;
  rotating.value = true;
  const result = await run(() => api('POST', `/api/admin/keys/${key.id}/rotate`));
  rotating.value = false;
  if (result) { access.value.apiKey = result.key; access.value.keyPrefix = result.prefix; notify('替代 Key 已生成，请立即更新调用方配置'); load(); }
}
async function save() {
  busy.value = true;
  const result = await run(() => selected.value ? api('PATCH', `/api/admin/keys/${selected.value.id}`, form) : api('POST', '/api/admin/keys', form));
  busy.value = false;
  if (!result) return;
  modal.value = false;
  if (result.key) access.value = { name: result.name || form.name, apiKey: result.key, keyPrefix: result.key, models: modelsFor(form.allowed_models) };
  notify(selected.value ? 'Key 设置已保存' : 'API Key 已生成');
  load();
}
async function toggle(key) { const result = await run(() => api('PATCH', `/api/admin/keys/${key.id}`, { enabled: !key.enabled })); if (result) { notify(key.enabled ? 'Key 已停发' : 'Key 已恢复'); load(); } }
</script>
<template>
  <section class="panel"><header class="panel-header"><div><h2>访问凭据 <span class="count">{{ keys.length }}</span></h2><p>为每个用户或应用独立下发 Key，并设置用量与并发限制</p></div><button class="primary" @click="openCreate"><UiIcon name="plus" :size="17" />生成 API Key</button></header><div v-if="loading" class="table-loading">正在加载 Key…</div><EmptyState v-else-if="!keys.length" icon="key" title="尚未生成 API Key" text="客户端需要使用这里的 Key 调用云端 OpenAI 兼容接口。"><button class="primary" @click="openCreate"><UiIcon name="plus" :size="16" />生成 API Key</button></EmptyState><div v-else class="key-list"><article v-for="key in keys" :key="key.id" class="key-card"><div class="key-card-top"><span class="key-icon"><UiIcon name="key" /></span><div class="grow"><div class="provider-title"><h3>{{ key.name }}</h3><span class="badge" :class="key.enabled ? 'success' : 'neutral'">{{ key.enabled ? '使用中' : '已停发' }}</span></div><code class="key-prefix">{{ key.key_prefix }}</code></div><div class="row-actions"><button class="button small" @click="openAccess(key)"><UiIcon name="copy" :size="15" />接入信息</button><button class="button small" @click="openEdit(key)"><UiIcon name="edit" :size="15" />配置</button><button class="button small" :class="{ 'danger-text': key.enabled }" @click="toggle(key)">{{ key.enabled ? '停发' : '恢复' }}</button></div></div><div class="quota-grid"><div><div class="quota-label"><span>Token 用量</span><strong>{{ formatNumber(key.used_tokens) }} / {{ key.token_quota ? formatNumber(key.token_quota) : '不限' }}</strong></div><div class="progress"><i :style="{ width: `${percent(key.used_tokens, key.token_quota)}%` }"></i></div></div><div><div class="quota-label"><span>费用额度</span><strong>{{ formatCost(key.used_cost) }} / {{ key.budget_quota ? formatCost(key.budget_quota) : '不限' }}</strong></div><div class="progress amber"><i :style="{ width: `${percent(key.used_cost, key.budget_quota)}%` }"></i></div></div></div><div class="key-meta"><span><b>{{ key.active }} / {{ key.concurrency_limit || '∞' }}</b> 当前并发</span><span><b>{{ formatNumber(key.quota_5h) }}</b> 5h 限额</span><span><b>{{ formatNumber(key.quota_week) }}</b> 周限额</span><span v-if="key.allow_user_apply" class="badge success">允许用户申请</span><span>可用模型 <b>{{ key.allowed_models?.length ? key.allowed_models.join('、') : '全部' }}</b></span><span><b>{{ key.rpm_limit || '不限' }}</b> 请求 / 分钟</span><span>到期时间 <b>{{ key.expires_at ? formatDate(key.expires_at) : '永久' }}</b></span><span>最后使用 <b>{{ formatDate(key.last_used_at) }}</b></span></div></article></div></section>
  <UiModal v-if="modal" :title="selected ? 'API Key 配置' : '生成 API Key'" subtitle="将额度设为 0 表示不限制，过期时间为空表示永久有效。" @close="modal = false"><form id="key-form" class="stack" @submit.prevent="save"><div class="field"><label>名称</label><input v-model="form.name" placeholder="例如： Alice 的应用" required /></div><div class="form-grid two"><div class="field"><label>Token 总额度</label><input v-model.number="form.token_quota" type="number" min="0" required /></div><div class="field"><label>费用额度 ($)</label><input v-model.number="form.budget_quota" type="number" min="0" step="0.01" required /></div><div class="field"><label>五小时 Token 限额</label><input v-model.number="form.quota_5h" type="number" min="0" required /></div><div class="field"><label>七天 Token 限额</label><input v-model.number="form.quota_week" type="number" min="0" required /></div><div class="field"><label>每分钟请求上限</label><input v-model.number="form.rpm_limit" type="number" min="0" required /></div><div class="field"><label>最大并发</label><input v-model.number="form.concurrency_limit" type="number" min="0" required /></div></div><fieldset class="model-access-field"><legend>可用模型</legend><p class="help-text">不勾选任何模型表示全部可用；勾选后仅允许使用所选模型。</p><label v-for="model in models" :key="`${model.provider_id}-${model.name}`" class="check-row"><input v-model="form.allowed_models" type="checkbox" :value="model.name" />{{ model.name }}</label></fieldset><label class="check-row"><input v-model="form.allow_user_apply" type="checkbox" />允许注册用户按此额度方案申请自己的新 Key（不共享当前 Key）</label><div class="field"><label>过期时间（可选）</label><input v-model="form.expires_at" type="datetime-local" /></div><label v-if="selected" class="check-row"><input v-model="form.reset_usage" type="checkbox" />保存时重置累计用量和窗口起算点（保留历史日志）</label></form><template #footer><button @click="modal = false">取消</button><button class="primary" form="key-form" :disabled="busy">{{ busy ? '保存中…' : selected ? '保存配置' : '生成 Key' }}</button></template></UiModal>
  <AccessModal v-if="access" :name="access.name" :api-key="access.apiKey" :key-prefix="access.keyPrefix" :base-url="apiBase" :models="access.models || models" :rotating="rotating" @close="access = null" @rotate="rotateAccess" />
</template>
