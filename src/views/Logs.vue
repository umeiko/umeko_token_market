<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, formatDate, formatNumber } from '../api.js';
import EmptyState from '../components/EmptyState.vue';
import UiIcon from '../components/UiIcon.vue';

const logs = ref([]), keys = ref([]), providers = ref([]), loading = ref(true), page = ref(1), pages = ref(1), total = ref(0), expanded = ref(null);
const filters = ref({ key_id: '', provider_id: '', category: '', status: '' });
const labels = {
  success: '正常', client_mismatch: '客户端拦截', rate_limit: '限流', auth_error: 'Key 错误',
  request_error: '请求格式错误', upstream_auth: '上游鉴权错误', upstream_error: '上游错误',
  provider_offline: '供应商离线', error: '错误',
};
const badgeType = (category) => category === 'success' ? 'success' : ['client_mismatch', 'rate_limit'].includes(category) ? 'warning' : 'danger';
const formatHeaders = (log) => JSON.stringify(log.headers || {}, null, 2);

async function load() {
  loading.value = true;
  const query = new URLSearchParams({ page: page.value, ...Object.fromEntries(Object.entries(filters.value).filter(([, value]) => value)) });
  const data = await api('GET', `/api/admin/usage?${query}`);
  logs.value = data.logs;
  pages.value = data.pages;
  total.value = data.total;
  loading.value = false;
}
function apply() { page.value = 1; expanded.value = null; load(); }
function move(delta) { page.value += delta; expanded.value = null; load(); }
onMounted(async () => {
  await load();
  const [k, p] = await Promise.all([api('GET', '/api/admin/keys'), api('GET', '/api/admin/providers')]);
  keys.value = k.keys;
  providers.value = p.providers;
  window.addEventListener('relay-refresh', load);
});
onBeforeUnmount(() => window.removeEventListener('relay-refresh', load));
</script>

<template>
  <section class="panel">
    <header class="panel-header log-header">
      <div><h2>请求审计 <span class="count">{{ total }}</span></h2><p>每条请求都可展开查看分类、报错原因和脱敏请求头；请求详情保留 5 小时</p></div>
      <div class="log-filters">
        <select v-model="filters.key_id" aria-label="筛选 Key" @change="apply"><option value="">全部 Key</option><option v-for="key in keys" :key="key.id" :value="key.id">{{ key.name }}</option></select>
        <select v-model="filters.provider_id" aria-label="筛选供应商" @change="apply"><option value="">全部供应商</option><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select>
        <select v-model="filters.category" aria-label="筛选分类" @change="apply"><option value="">全部分类</option><option v-for="(label, category) in labels" :key="category" :value="category">{{ label }}</option></select>
        <select v-model="filters.status" aria-label="筛选 HTTP 状态" @change="apply"><option value="">全部状态</option><option value="success">HTTP 成功</option><option value="error">HTTP 失败</option></select>
      </div>
    </header>
    <div v-if="loading" class="table-loading">正在查询日志…</div>
    <EmptyState v-else-if="!logs.length" title="没有匹配的请求" text="调整筛选条件，或发起一次 API 调用后再查看。" />
    <div v-else class="table-wrap">
      <table class="logs-table">
        <thead><tr><th>时间 / 请求 ID</th><th>Key / 供应商</th><th>模型</th><th>IP / 地区</th><th>分类</th><th>Token（入 / 出）</th><th>用户客户端</th><th>详情</th></tr></thead>
        <tbody v-for="log in logs" :key="log.id">
          <tr>
            <td><div>{{ formatDate(log.created_at) }}</div><code class="request-id">{{ log.request_id.slice(0, 8) }}</code></td>
            <td><div>{{ log.key_name || (log.key_id ? '已删除 Key' : '未通过认证') }}</div><small class="muted">{{ log.provider_name || (log.provider_id ? '已删除供应商' : '未分配供应商') }}</small></td>
            <td><code class="model-name">{{ log.model || '—' }}</code></td>
            <td><code class="log-ip">{{ log.ip || '—' }}</code><small class="muted">{{ log.ip_region || (log.ip ? '查询中 / 未知' : '详情已过期') }}</small></td>
            <td><span class="badge" :class="badgeType(log.category)">{{ labels[log.category] || log.category }}</span></td>
            <td>{{ formatNumber(log.prompt_tokens) }} / {{ formatNumber(log.completion_tokens) }}</td>
            <td class="client-cell" :title="log.headers?.['user-agent'] || '未知或详情已过期'">{{ log.headers?.['user-agent'] || '未知或详情已过期' }}</td>
            <td><button class="button small" :aria-expanded="expanded === log.id" @click="expanded = expanded === log.id ? null : log.id"><UiIcon name="info" :size="14" />{{ expanded === log.id ? '收起' : '详情' }}</button></td>
          </tr>
          <tr v-if="expanded === log.id" class="request-detail-row">
            <td colspan="8">
              <div class="request-detail">
                <div class="detail-grid">
                  <div><span>请求分类</span><strong>{{ labels[log.category] || log.category }}</strong></div>
                  <div><span>请求 IP</span><code>{{ log.ip || '详情已过期' }}</code></div>
                  <div><span>IP 地区</span><code>{{ log.ip_region || (log.ip ? '查询中或未知' : '详情已过期') }}</code></div>
                  <div><span>User-Agent</span><code>{{ log.headers?.['user-agent'] || '未知或详情已过期' }}</code></div>
                </div>
                <div class="detail-error"><strong>{{ log.category === 'success' ? '请求结果' : '具体原因' }}</strong><p>{{ log.error || (log.category === 'success' ? '请求正常完成' : '未记录额外错误信息') }}</p></div>
                <details open><summary>请求头（凭据已脱敏，仅保留 5 小时）</summary><pre>{{ formatHeaders(log) }}</pre></details>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <footer class="pagination"><span>第 {{ page }} / {{ pages }} 页</span><div><button class="button small" :disabled="page <= 1" @click="move(-1)">上一页</button><button class="button small" :disabled="page >= pages" @click="move(1)">下一页</button></div></footer>
  </section>
</template>
