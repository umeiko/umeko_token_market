<script setup>
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, formatCost, formatDate, formatNumber, percent } from '../api.js';
import { keyLogFilter, notify, run } from '../store.js';
import UiIcon from '../components/UiIcon.vue';
import UiModal from '../components/UiModal.vue';
import AccessModal from '../components/AccessModal.vue';
import EmptyState from '../components/EmptyState.vue';
const keys = ref([]), loading = ref(true), modal = ref(false), busy = ref(false), selected = ref(null), access = ref(null), accessModal = ref(null), rotating = ref(false), rotationTarget = ref(null), cloning = ref(null), resetting = ref(''), resetTarget = ref(null), deleting = ref(false), deleteTarget = ref(null), models = ref([]);
const apiBase = `${location.origin}${(import.meta.env.VITE_API_BASE || import.meta.env.BASE_URL).replace(/\/$/, '')}/v1`;
const blank = () => ({ name: '', allowed_models: [], client_mode: 'regex', client_pattern: '', client_error_message: '请使用umeko-desktop来提问吧', token_quota: 1000000, budget_quota: 10, quota_5h: 2000000, quota_week: 20000000, allow_user_apply: false, rpm_limit: 60, concurrency_limit: 2, expires_at: '', enabled: true, reset_usage: false });
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
function openEdit(key) { selected.value = key; Object.assign(form, { name: key.name, allowed_models: [...(key.allowed_models || [])], client_mode: key.client_mode || 'regex', client_pattern: key.client_pattern || '', client_error_message: key.client_error_message || '请使用umeko-desktop来提问吧', token_quota: key.token_quota, budget_quota: key.budget_quota, quota_5h: key.quota_5h, quota_week: key.quota_week, allow_user_apply: key.allow_user_apply, rpm_limit: key.rpm_limit, concurrency_limit: key.concurrency_limit, expires_at: key.expires_at || '', enabled: key.enabled, reset_usage: false }); modal.value = true; }
async function openAccess(key) {
  access.value = { name: key.name, apiKey: '', keyPrefix: key.key_prefix, models: modelsFor(key.allowed_models), legacy: false };
  const result = await run(() => api('GET', `/api/admin/keys/${key.id}/reveal`));
  if (result?.key) access.value.apiKey = result.key;
  else if (result?.legacy) access.value.legacy = true;
}
function requestRotate(key) {
  access.value = null;
  rotationTarget.value = key;
}
function rotateAccess() {
  rotationTarget.value = keys.value.find((item) => item.name === access.value.name) || null;
}
async function confirmRotate() {
  const key = rotationTarget.value;
  if (!key) return;
  rotating.value = true;
  const result = await run(() => api('POST', `/api/admin/keys/${key.id}/rotate`));
  rotating.value = false;
  if (result) {
    if (access.value) {
      access.value.apiKey = result.key;
      access.value.keyPrefix = result.prefix;
    } else {
      access.value = { name: key.name, apiKey: result.key, keyPrefix: result.prefix, models: modelsFor(key.allowed_models), legacy: false };
    }
    rotationTarget.value = null;
    modal.value = false;
    await nextTick();
    accessModal.value?.copy(accessModal.value.envText, 'env');
    notify('新 Key 已生成，旧 Key 已失效，环境变量已复制');
    load();
  }
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
async function cloneKey(key) {
  cloning.value = key.id;
  const name = `${key.name} 副本`;
  const result = await run(() => api('POST', '/api/admin/keys', {
    name, allowed_models: [...(key.allowed_models || [])], client_mode: key.client_mode,
    client_pattern: key.client_pattern, client_error_message: key.client_error_message,
    token_quota: key.token_quota, budget_quota: key.budget_quota, quota_5h: key.quota_5h,
    quota_week: key.quota_week, allow_user_apply: key.allow_user_apply, rpm_limit: key.rpm_limit,
    concurrency_limit: key.concurrency_limit, expires_at: key.expires_at || null,
  }));
  cloning.value = null;
  if (result) {
    access.value = { name, apiKey: result.key, keyPrefix: result.key, models: modelsFor(key.allowed_models), legacy: false };
    await nextTick();
    accessModal.value?.copy(accessModal.value.envText, 'env');
    notify('克隆成功，新 Key 用量独立计算，环境变量已复制');
    load();
  }
}
function viewKeyLogs(key) {
  keyLogFilter.value = String(key.id);
  location.hash = 'logs';
}
function requestReset(scope) {
  resetTarget.value = { key: selected.value, scope };
}
async function confirmReset() {
  const { key, scope } = resetTarget.value;
  resetting.value = scope;
  const result = await run(() => api('PATCH', `/api/admin/keys/${key.id}`, scope === 'all' ? { reset_usage: true } : { reset_window: scope }));
  resetting.value = '';
  if (result) {
    resetTarget.value = null;
    notify(scope === 'all' ? '全部限额用量已重置' : scope === '5h' ? '5h 限额用量已重置' : '周限额用量已重置');
    load();
  }
}
async function toggle(key) { const result = await run(() => api('PATCH', `/api/admin/keys/${key.id}`, { enabled: !key.enabled })); if (result) { notify(key.enabled ? 'Key 已停发' : 'Key 已恢复'); modal.value = false; load(); } }
async function confirmDelete() {
  const key = deleteTarget.value;
  deleting.value = true;
  const result = await run(() => api('DELETE', `/api/admin/keys/${key.id}`));
  deleting.value = false;
  if (result) {
    deleteTarget.value = null;
    modal.value = false;
    if (access.value?.name === key.name) access.value = null;
    notify(`Key“${key.name}”已删除，历史日志仍保留`);
    load();
  }
}
</script>
<template>
  <section class="panel"><header class="panel-header"><div><h2>访问凭据 <span class="count">{{ keys.length }}</span></h2><p>为每个用户或应用独立下发 Key，并设置用量与并发限制</p></div><button class="primary" @click="openCreate"><UiIcon name="plus" :size="17" />生成 API Key</button></header><div v-if="loading" class="table-loading">正在加载 Key…</div><EmptyState v-else-if="!keys.length" icon="key" title="尚未生成 API Key" text="客户端需要使用这里的 Key 调用云端 OpenAI 兼容接口。"><button class="primary" @click="openCreate"><UiIcon name="plus" :size="16" />生成 API Key</button></EmptyState><div v-else class="key-list"><article v-for="key in keys" :key="key.id" class="key-card"><div class="key-card-top"><span class="key-icon"><UiIcon name="key" /></span><div class="grow"><div class="provider-title"><h3>{{ key.name }}</h3><span class="badge" :class="key.enabled ? 'success' : 'neutral'">{{ key.enabled ? '使用中' : '已停发' }}</span></div><code class="key-prefix">{{ key.key_prefix }}</code></div><div class="row-actions"><button class="button small" @click="openAccess(key)"><UiIcon name="copy" :size="15" />接入信息</button><button class="button small" @click="openEdit(key)"><UiIcon name="edit" :size="15" />配置</button><button class="button small" :disabled="cloning === key.id" @click="cloneKey(key)"><UiIcon name="copy" :size="15" />{{ cloning === key.id ? '克隆中…' : '克隆' }}</button><button class="button small" @click="viewKeyLogs(key)"><UiIcon name="logs" :size="15" />日志</button></div></div><div class="quota-grid"><div><div class="quota-label"><span>当前 5h 用量</span><strong>{{ formatNumber(key.usage_5h) }} / {{ key.quota_5h ? formatNumber(key.quota_5h) : '不限' }}</strong></div><div class="progress"><i :style="{ width: `${percent(key.usage_5h, key.quota_5h)}%` }"></i></div></div><div><div class="quota-label"><span>当前 1 周用量</span><strong>{{ formatNumber(key.usage_week) }} / {{ key.quota_week ? formatNumber(key.quota_week) : '不限' }}</strong></div><div class="progress"><i :style="{ width: `${percent(key.usage_week, key.quota_week)}%` }"></i></div></div><div><div class="quota-label"><span>累计 Token 用量</span><strong>{{ formatNumber(key.used_tokens) }} / {{ key.token_quota ? formatNumber(key.token_quota) : '不限' }}</strong></div><div class="progress"><i :style="{ width: `${percent(key.used_tokens, key.token_quota)}%` }"></i></div></div><div><div class="quota-label"><span>费用额度</span><strong>{{ formatCost(key.used_cost) }} / {{ key.budget_quota ? formatCost(key.budget_quota) : '不限' }}</strong></div><div class="progress amber"><i :style="{ width: `${percent(key.used_cost, key.budget_quota)}%` }"></i></div></div></div><div class="key-meta"><span><b>{{ key.active }} / {{ key.concurrency_limit || '∞' }}</b> 当前并发</span><span v-if="key.allow_user_apply" class="badge success">允许用户申请</span><span v-if="key.client_pattern">User-Agent <b>{{ key.client_pattern }}</b></span><span>可用模型 <b>{{ key.allowed_models?.length ? key.allowed_models.join('、') : '全部' }}</b></span><span><b>{{ key.rpm_limit || '不限' }}</b> 请求 / 分钟</span><span>到期时间 <b>{{ key.expires_at ? formatDate(key.expires_at) : '永久' }}</b></span><span>最后使用 <b>{{ formatDate(key.last_used_at) }}</b></span></div></article></div></section>
  <UiModal v-if="modal" :title="selected ? 'API Key 配置' : '生成 API Key'" subtitle="将额度设为 0 表示不限制，过期时间为空表示永久有效。" @close="modal = false"><form id="key-form" class="stack" @submit.prevent="save"><div class="field"><label>名称</label><input v-model="form.name" placeholder="例如： Alice 的应用" required /></div><div class="form-grid two"><div class="field"><label>Token 总额度</label><input v-model.number="form.token_quota" type="number" min="0" required /></div><div class="field"><label>费用额度 ($)</label><input v-model.number="form.budget_quota" type="number" min="0" step="0.01" required /></div><div class="field"><label>五小时 Token 限额</label><input v-model.number="form.quota_5h" type="number" min="0" required /></div><div class="field"><label>七天 Token 限额</label><input v-model.number="form.quota_week" type="number" min="0" required /></div><div class="field"><label>每分钟请求上限</label><input v-model.number="form.rpm_limit" type="number" min="0" required /></div><div class="field"><label>最大并发</label><input v-model.number="form.concurrency_limit" type="number" min="0" required /></div></div><div class="form-grid two"><div class="field"><label>客户端匹配模式</label><select v-model="form.client_mode"><option value="regex">正则表达式</option><option value="template">通配符模板（*）</option></select></div><div class="field"><label>User-Agent 限制（可选）</label><input v-model="form.client_pattern" placeholder="例如 umeko，留空不限制" /><span class="help-text">留空不限制客户端；不匹配时会流式返回下方提示，并记录到请求日志。</span></div></div><div class="field"><label>客户端不匹配时的流式提示</label><textarea v-model="form.client_error_message" rows="3" maxlength="2000" required placeholder="例如：请使用 Umeko Desktop 提问"></textarea><span class="help-text">同时用于 OpenAI 和 Anthropic 流式响应。支持 <code v-pre>{{userAgent}}</code> 占位符，最多 2000 字。</span></div><fieldset class="model-access-field"><legend>可用模型</legend><p class="help-text">不勾选任何模型表示全部可用；勾选后仅允许使用所选模型。</p><label v-for="model in models" :key="`${model.provider_id}-${model.name}`" class="check-row"><input v-model="form.allowed_models" type="checkbox" :value="model.name" />{{ model.name }}</label></fieldset><label class="check-row"><input v-model="form.allow_user_apply" type="checkbox" />允许注册用户按此额度方案申请自己的新 Key（不共享当前 Key）</label><div class="field"><label>过期时间（可选）</label><input v-model="form.expires_at" type="datetime-local" /></div><div v-if="selected" class="quota-reset-field"><span class="field-label">用量重置</span><div class="quota-reset-actions"><button type="button" class="button small" @click="requestReset('5h')">重置 5h 限额</button><button type="button" class="button small" @click="requestReset('week')">重置周限额</button><button type="button" class="button small danger-text" @click="requestReset('all')">重置全部限额</button></div><p class="help-text">单独重置只影响对应窗口；全部重置会清零累计 Token、费用、5h 和周用量。历史日志保留。</p></div><div v-if="selected" class="quota-reset-field"><span class="field-label">凭据与状态操作</span><div class="quota-reset-actions"><button type="button" class="button small" :disabled="!selected.enabled || rotating" @click="requestRotate(selected)"><UiIcon name="refresh" :size="15" />生成新 Key</button><button type="button" class="button small" @click="toggle(selected)">{{ selected.enabled ? '停发' : '恢复' }}</button><button type="button" class="button small danger-text" @click="deleteTarget = selected"><UiIcon name="trash" :size="15" />删除</button></div><p class="help-text">生成新 Key 会使旧凭据失效；停发可随时恢复；永久删除不可恢复。</p></div></form><template #footer><button @click="modal = false">取消</button><button class="primary" form="key-form" :disabled="busy">{{ busy ? '保存中…' : selected ? '保存配置' : '生成 Key' }}</button></template></UiModal>
  <UiModal v-if="resetTarget" title="确认重置用量" subtitle="此操作立即生效，历史日志仍然保留。" @close="resetTarget = null"><div class="secret-notice"><UiIcon name="shield" /><span>{{ resetTarget.scope === 'all' ? '将清零累计 Token、费用、5h 和周用量。' : resetTarget.scope === '5h' ? '只清零当前 5h 窗口用量，周用量和累计用量不变。' : '只清零当前一周窗口用量，5h 用量和累计用量不变。' }}Key 凭据、配置和启停状态不会改变。</span></div><template #footer><button :disabled="Boolean(resetting)" @click="resetTarget = null">取消</button><button class="primary" :disabled="Boolean(resetting)" @click="confirmReset"><UiIcon name="refresh" :size="15" />{{ resetting ? '正在重置…' : '确认重置' }}</button></template></UiModal>
  <UiModal v-if="rotationTarget" title="生成替代 Key" subtitle="保留现有配置并立即更换凭据。" @close="rotationTarget = null"><div class="secret-notice"><UiIcon name="shield" /><span>将为“{{ rotationTarget.name }}”生成新 Key。原 Key 会立即失效，使用它的应用必须更新凭据。额度、用量、模型权限和客户端规则保持不变。</span></div><template #footer><button :disabled="rotating" @click="rotationTarget = null">取消</button><button class="primary" :disabled="rotating" @click="confirmRotate"><UiIcon name="refresh" :size="15" />{{ rotating ? '正在生成…' : '确认生成新 Key' }}</button></template></UiModal>
  <UiModal v-if="deleteTarget" title="删除 API Key" subtitle="此操作不可恢复，请确认不再需要此凭据。" @close="deleteTarget = null"><div class="secret-notice"><UiIcon name="shield" /><span>将永久删除“{{ deleteTarget.name }}”，该 Key 会立即失效，使用它的应用必须更换凭据。历史日志和统计数据会保留，并显示为“已删除 Key”。</span></div><template #footer><button :disabled="deleting" @click="deleteTarget = null">取消</button><button class="primary" :disabled="deleting" @click="confirmDelete"><UiIcon name="trash" :size="15" />{{ deleting ? '正在删除…' : '确认永久删除' }}</button></template></UiModal>
  <AccessModal v-if="access" ref="accessModal" :name="access.name" :api-key="access.apiKey" :key-prefix="access.keyPrefix" :base-url="apiBase" :models="access.models || models" :rotating="rotating" @close="access = null" @rotate="rotateAccess" />
</template>
