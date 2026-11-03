<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api, formatDate, formatNumber, percent } from '../api.js';
import { notify, run } from '../store.js';
import UiIcon from '../components/UiIcon.vue';
import UiModal from '../components/UiModal.vue';
import EmptyState from '../components/EmptyState.vue';

const users = ref([]), search = ref(''), loading = ref(true), searching = ref(false), modal = ref(false), selected = ref(null);
const form = reactive({ token_quota_5h: 2000000, token_quota_week: 20000000, enabled: true });
let timer;
async function load() {
  searching.value = true;
  try { users.value = (await api('GET', `/api/admin/users?search=${encodeURIComponent(search.value.trim())}`)).users; }
  finally { loading.value = false; searching.value = false; }
}
function debounceSearch() { clearTimeout(timer); timer = setTimeout(load, 180); }
function openEdit(user) {
  selected.value = user;
  Object.assign(form, { token_quota_5h: user.usage.five_hours.quota, token_quota_week: user.usage.week.quota, enabled: user.enabled });
  modal.value = true;
}
async function save() {
  const result = await run(() => api('PATCH', `/api/admin/users/${selected.value.id}`, form));
  if (result) { modal.value = false; notify('用户额度已更新'); load(); }
}
async function toggle(user) {
  const result = await run(() => api('PATCH', `/api/admin/users/${user.id}`, { enabled: !user.enabled }));
  if (result) { notify(user.enabled ? '用户已停用，其所有 Key 将无法调用' : '用户已恢复'); load(); }
}
async function reset(user, scope) {
  const label = scope === 'all' ? '五小时和周额度' : scope === 'week' ? '周额度' : '五小时额度';
  if (!window.confirm(`确定重置 ${user.email} 的${label}吗？历史日志会保留。`)) return;
  const result = await run(() => api('POST', `/api/admin/users/${user.id}/reset`, { scope }));
  if (result) { notify('额度用量已重置'); load(); }
}
onMounted(() => { load(); window.addEventListener('relay-refresh', load); });
onBeforeUnmount(() => { clearTimeout(timer); window.removeEventListener('relay-refresh', load); });
</script>
<template>
  <section class="panel">
    <header class="panel-header user-header"><div><h2>注册用户</h2><p>邮箱前缀或用户 ID 搜索，结果由 SQLite 索引查询并限制为 50 条</p></div><label class="user-search"><UiIcon name="users" :size="17" /><input v-model="search" placeholder="搜索邮箱或用户 ID…" autocomplete="off" @input="debounceSearch" /><span v-if="searching">查询中</span></label></header>
    <div v-if="loading" class="table-loading">正在加载用户…</div>
    <EmptyState v-else-if="!users.length" icon="users" title="没有匹配的用户" text="用户通过邮箱验证码注册后，会出现在这里。" />
    <div v-else class="table-wrap"><table class="users-table"><thead><tr><th>用户</th><th>五小时额度</th><th>周额度</th><th>Key</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="user in users" :key="user.id"><td><div class="user-email"><span>{{ user.email.slice(0, 1).toUpperCase() }}</span><div><strong>{{ user.email }}</strong><small>ID {{ user.id }} · 注册于 {{ formatDate(user.created_at) }}</small></div></div></td><td><div class="quota-cell"><div><b>{{ formatNumber(user.usage.five_hours.used) }}</b> / {{ formatNumber(user.usage.five_hours.quota) }}</div><div class="progress"><i :style="{ width: `${percent(user.usage.five_hours.used, user.usage.five_hours.quota)}%` }"></i></div></div></td><td><div class="quota-cell"><div><b>{{ formatNumber(user.usage.week.used) }}</b> / {{ formatNumber(user.usage.week.quota) }}</div><div class="progress amber"><i :style="{ width: `${percent(user.usage.week.used, user.usage.week.quota)}%` }"></i></div></div></td><td>{{ user.key_count }}</td><td><span class="badge" :class="user.enabled ? 'success' : 'neutral'">{{ user.enabled ? '正常' : '停用' }}</span></td><td><div class="row-actions"><button class="button small" @click="openEdit(user)">额度</button><button class="button small" title="重置五小时额度" @click="reset(user, 'five_hours')">重置 5h</button><button class="button small" title="重置五小时和周额度" @click="reset(user, 'all')">全部重置</button><button class="button small" :class="{ 'danger-text': user.enabled }" @click="toggle(user)">{{ user.enabled ? '停用' : '恢复' }}</button></div></td></tr></tbody></table></div>
  </section>
  <UiModal v-if="modal" title="调整用户额度" :subtitle="selected?.email" @close="modal = false"><form id="user-quota-form" class="stack" @submit.prevent="save"><div class="field"><label>五小时 Token 限额</label><input v-model.number="form.token_quota_5h" type="number" min="0" step="1000" required /><span class="help-text">默认 2,000,000；0 表示不限制。</span></div><div class="field"><label>七天 Token 限额</label><input v-model.number="form.token_quota_week" type="number" min="0" step="1000" required /><span class="help-text">默认 20,000,000，按滚动七天统计该用户所有 Key。</span></div><label class="check-row"><input v-model="form.enabled" type="checkbox" />允许该用户登录和调用 API</label></form><template #footer><button @click="modal = false">取消</button><button class="primary" form="user-quota-form">保存额度</button></template></UiModal>
</template>
