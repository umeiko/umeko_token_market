<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, formatCost, formatDate, formatNumber } from '../api.js';
import UiIcon from '../components/UiIcon.vue';
import UsageChart from '../components/UsageChart.vue';
import EmptyState from '../components/EmptyState.vue';
const loading = ref(true), metric = ref('requests');
const data = ref({ today: {}, totals: {}, series: [], recent: [] });
async function load() { data.value = await api('GET', '/api/admin/overview'); loading.value = false; }
onMounted(() => { load(); window.addEventListener('relay-refresh', load); });
onBeforeUnmount(() => window.removeEventListener('relay-refresh', load));
</script>
<template>
  <div v-if="loading" class="panel skeleton-panel"></div>
  <template v-else>
    <section class="stats-grid">
      <article class="stat-card"><div class="stat-icon cyan"><UiIcon name="activity" /></div><div class="stat-label">今日请求<span class="trend">实时</span></div><strong>{{ formatNumber(data.today.requests) }}</strong><p>累计 {{ formatNumber(data.totals.providers) }} 个供应商</p></article>
      <article class="stat-card"><div class="stat-icon blue"><UiIcon name="chart" /></div><div class="stat-label">今日 Token</div><strong>{{ formatNumber(data.today.tokens) }}</strong><p>历史累计 {{ formatNumber(data.totals.tokens) }}</p></article>
      <article class="stat-card"><div class="stat-icon violet"><UiIcon name="key" /></div><div class="stat-label">活跃 API Key</div><strong>{{ formatNumber(data.totals.active_keys) }}</strong><p>{{ data.totals.online }} 个供应商节点在线</p></article>
      <article class="stat-card"><div class="stat-icon amber"><UiIcon name="cloud" /></div><div class="stat-label">今日费用</div><strong>{{ formatCost(data.today.cost) }}</strong><p>历史累计 {{ formatCost(data.totals.cost) }}</p></article>
    </section>
    <section class="dashboard-grid">
      <article class="panel chart-panel"><header class="panel-header"><div><h2>用量趋势</h2><p>最近 14 天的请求与 Token 消耗</p></div><div class="segmented"><button :class="{ active: metric === 'requests' }" @click="metric = 'requests'">请求</button><button :class="{ active: metric === 'tokens' }" @click="metric = 'tokens'">Token</button></div></header><UsageChart :series="data.series" :metric="metric" /></article>
      <article class="panel health-panel"><header class="panel-header"><div><h2>服务健康度</h2><p>当前网关运行概况</p></div></header><div class="health-ring" :style="{ '--percent': `${data.today.requests ? (data.today.successful / data.today.requests * 100) : 100}` }"><div><strong>{{ data.today.requests ? Math.round(data.today.successful / data.today.requests * 100) : 100 }}%</strong><span>今日成功率</span></div></div><div class="health-list"><div><span><i class="dot good"></i>在线节点</span><strong>{{ data.totals.online }} / {{ data.totals.providers }}</strong></div><div><span><i class="dot good"></i>成功请求</span><strong>{{ formatNumber(data.today.successful) }}</strong></div><div><span><i class="dot"></i>失败请求</span><strong>{{ formatNumber(data.today.requests - data.today.successful) }}</strong></div></div></article>
    </section>
    <section class="panel"><header class="panel-header"><div><h2>最近请求</h2><p>最新 8 条 API 调用记录</p></div><a href="#logs" class="text-link">查看全部<UiIcon name="arrow" :size="15" /></a></header><div v-if="data.recent.length" class="table-wrap"><table><thead><tr><th>时间</th><th>模型</th><th>API Key / 供应商</th><th>Token</th><th>延迟</th><th>状态</th></tr></thead><tbody><tr v-for="log in data.recent" :key="log.id"><td class="muted">{{ formatDate(log.created_at) }}</td><td><code class="model-name">{{ log.model }}</code></td><td><div>{{ log.key_name || '已删除 Key' }}</div><small class="muted">{{ log.provider_name }}</small></td><td>{{ formatNumber(log.total_tokens) }}</td><td>{{ log.latency_ms }} ms</td><td><span class="badge" :class="log.status < 400 ? 'success' : 'danger'">{{ log.status }}</span></td></tr></tbody></table></div><EmptyState v-else icon="activity" title="还没有请求记录" text="创建供应商和 API Key 后，即可开始调用模型。" /></section>
  </template>
</template>
