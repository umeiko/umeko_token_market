<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, formatCost, formatDate, formatNumber, percent } from '../api.js';
import { notify, run } from '../store.js';
import UiIcon from '../components/UiIcon.vue';
import UiModal from '../components/UiModal.vue';
import SecretModal from '../components/SecretModal.vue';
import EmptyState from '../components/EmptyState.vue';
const keys = ref([]), loading = ref(true), modal = ref(false), busy = ref(false), selected = ref(null), newKey = ref('');
const blank = () => ({ name: '', token_quota: 1000000, budget_quota: 10, quota_5h: 2000000, quota_week: 20000000, allow_user_apply: false, rpm_limit: 60, concurrency_limit: 2, expires_at: '', enabled: true, reset_usage: false });
const form = reactive(blank());
async function load() { keys.value = (await api('GET', '/api/admin/keys')).keys; loading.value = false; }
onMounted(() => { load(); window.addEventListener('relay-refresh', load); });
onBeforeUnmount(() => window.removeEventListener('relay-refresh', load));
function openCreate() { selected.value = null; Object.assign(form, blank()); modal.value = true; }
function openEdit(key) { selected.value = key; Object.assign(form, { name: key.name, token_quota: key.token_quota, budget_quota: key.budget_quota, quota_5h: key.quota_5h, quota_week: key.quota_week, allow_user_apply: key.allow_user_apply, rpm_limit: key.rpm_limit, concurrency_limit: key.concurrency_limit, expires_at: key.expires_at || '', enabled: key.enabled, reset_usage: false }); modal.value = true; }
async function save() {
  busy.value = true;
  const result = await run(() => selected.value ? api('PATCH', `/api/admin/keys/${selected.value.id}`, form) : api('POST', '/api/admin/keys', form));
  busy.value = false;
  if (!result) return;
  modal.value = false;
  if (result.key) newKey.value = result.key;
  notify(selected.value ? 'Key 设置已保存' : 'API Key 已生成');
  load();
}
async function toggle(key) { const result = await run(() => api('PATCH', `/api/admin/keys/${key.id}`, { enabled: !key.enabled })); if (result) { notify(key.enabled ? 'Key 已停发' : 'Key 已恢复'); load(); } }
</script>
<template>
  <section class="panel"><header class="panel-header"><div><h2>访问凭据 <span class="count">{{ keys.length }}</span></h2><p>为每个用户或应用独立下发 Key，并设置用量与并发限制</p></div><button class="primary" @click="openCreate"><UiIcon name="plus" :size="17" />生成 API Key</button></header><div v-if="loading" class="table-loading">正在加载 Key…</div><EmptyState v-else-if="!keys.length" icon="key" title="尚未生成 API Key" text="客户端需要使用这里的 Key 调用云端 OpenAI 兼容接口。"><button class="primary" @click="openCreate"><UiIcon name="plus" :size="16" />生成 API Key</button></EmptyState><div v-else class="key-list"><article v-for="key in keys" :key="key.id" class="key-card"><div class="key-card-top"><span class="key-icon"><UiIcon name="key" /></span><div class="grow"><div class="provider-title"><h3>{{ key.name }}</h3><span class="badge" :class="key.enabled ? 'success' : 'neutral'">{{ key.enabled ? '使用中' : '已停发' }}</span></div><code class="key-prefix">{{ key.key_prefix }}</code></div><div class="row-actions"><button class="button small" @click="openEdit(key)"><UiIcon name="edit" :size="15" />配置</button><button class="button small" :class="{ 'danger-text': key.enabled }" @click="toggle(key)">{{ key.enabled ? '停发' : '恢复' }}</button></div></div><div class="quota-grid"><div><div class="quota-label"><span>Token 用量</span><strong>{{ formatNumber(key.used_tokens) }} / {{ key.token_quota ? formatNumber(key.token_quota) : '不限' }}</strong></div><div class="progress"><i :style="{ width: `${percent(key.used_tokens, key.token_quota)}%` }"></i></div></div><div><div class="quota-label"><span>费用额度</span><strong>{{ formatCost(key.used_cost) }} / {{ key.budget_quota ? formatCost(key.budget_quota) : '不限' }}</strong></div><div class="progress amber"><i :style="{ width: `${percent(key.used_cost, key.budget_quota)}%` }"></i></div></div></div><div class="key-meta"><span><b>{{ key.active }} / {{ key.concurrency_limit || '∞' }}</b> 当前并发</span><span><b>{{ formatNumber(key.quota_5h) }}</b> 5h 限额</span><span><b>{{ formatNumber(key.quota_week) }}</b> 周限额</span><span v-if="key.allow_user_apply" class="badge success">允许用户申请</span><span><b>{{ key.rpm_limit || '不限' }}</b> 请求 / 分钟</span><span>到期时间 <b>{{ key.expires_at ? formatDate(key.expires_at) : '永久' }}</b></span><span>最后使用 <b>{{ formatDate(key.last_used_at) }}</b></span></div></article></div></section>
  <UiModal v-if="modal" :title="selected ? 'API Key 配置' : '生成 API Key'" subtitle="将额度设为 0 表示不限制，过期时间为空表示永久有效。" @close="modal = false"><form id="key-form" class="stack" @submit.prevent="save"><div class="field"><label>名称</label><input v-model="form.name" placeholder="例如： Alice 的应用" required /></div><div class="form-grid two"><div class="field"><label>Token 总额度</label><input v-model.number="form.token_quota" type="number" min="0" required /></div><div class="field"><label>费用额度 ($)</label><input v-model.number="form.budget_quota" type="number" min="0" step="0.01" required /></div><div class="field"><label>五小时 Token 限额</label><input v-model.number="form.quota_5h" type="number" min="0" required /></div><div class="field"><label>七天 Token 限额</label><input v-model.number="form.quota_week" type="number" min="0" required /></div><div class="field"><label>每分钟请求上限</label><input v-model.number="form.rpm_limit" type="number" min="0" required /></div><div class="field"><label>最大并发</label><input v-model.number="form.concurrency_limit" type="number" min="0" required /></div></div><label class="check-row"><input v-model="form.allow_user_apply" type="checkbox" />允许注册用户按此额度方案申请自己的新 Key（不共享当前 Key）</label><div class="field"><label>过期时间（可选）</label><input v-model="form.expires_at" type="datetime-local" /></div><label v-if="selected" class="check-row"><input v-model="form.reset_usage" type="checkbox" />保存时重置累计用量和窗口起算点（保留历史日志）</label></form><template #footer><button @click="modal = false">取消</button><button class="primary" form="key-form" :disabled="busy">{{ busy ? '保存中…' : selected ? '保存配置' : '生成 Key' }}</button></template></UiModal>
  <SecretModal v-if="newKey" title="API Key 已生成" :secret="newKey" description="请将此 Key 安全地下发给调用方。关闭后只能重新生成，无法找回。" @close="newKey = ''" />
</template>
