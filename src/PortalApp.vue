<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, copyText, formatCost, formatDate, formatNumber, percent } from './api.js';
import { notify, run, toasts } from './store.js';
import UiIcon from './components/UiIcon.vue';
import UiModal from './components/UiModal.vue';
import SecretModal from './components/SecretModal.vue';
import EmptyState from './components/EmptyState.vue';

const ready = ref(false), user = ref(null), tab = ref('overview'), nav = ref(false);
const email = ref(''), code = ref(''), website = ref(''), step = ref(1), busy = ref(false), error = ref(''), cooldown = ref(0);
const config = ref({ turnstile_site_key: '', development_email: false });
const overview = ref({ usage: { five_hours: {}, week: {} }, stats: {}, models: [], logs: [], plans: [] });
const keys = ref([]), keyModal = ref(false), keyName = ref('我的 API Key'), newKey = ref(''), selectedPlan = ref('');
let cooldownTimer, turnstileWidget;
const apiBase = `${location.origin}${(import.meta.env.VITE_API_BASE || import.meta.env.BASE_URL).replace(/\/$/, '')}`;
const curlExample = computed(() => `curl ${apiBase}/v1/chat/completions \\\n  -H 'Authorization: Bearer umo-sk-...' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"${overview.value.models[0]?.name || 'your-model'}","messages":[{"role":"user","content":"你好"}]}'`);
const pythonExample = computed(() => `from openai import OpenAI\n\nclient = OpenAI(\n    api_key="umo-sk-...",\n    base_url="${apiBase}/v1"\n)\n\nresponse = client.chat.completions.create(\n    model="${overview.value.models[0]?.name || 'your-model'}",\n    messages=[{"role": "user", "content": "你好"}]\n)\nprint(response.choices[0].message.content)`);
const envExample = computed(() => `OPENAI_BASE_URL=${apiBase}/v1\nOPENAI_API_KEY=umo-sk-...\nOPENAI_MODEL=${overview.value.models[0]?.name || 'your-model'}`);

async function loadData() {
  const [summary, keyData] = await Promise.all([api('GET', '/api/user/overview'), api('GET', '/api/user/keys')]);
  overview.value = summary;
  keys.value = keyData.keys;
}
function expire() { user.value = null; step.value = 1; code.value = ''; }
async function setupTurnstile() {
  if (!config.value.turnstile_site_key || turnstileWidget !== undefined) return;
  await nextTick();
  const render = () => {
    if (!document.getElementById('turnstile')) return;
    turnstileWidget = window.turnstile.render('#turnstile', { sitekey: config.value.turnstile_site_key, callback: () => {} });
  };
  if (window.turnstile) return render();
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.onload = render;
  document.head.append(script);
}
onMounted(async () => {
  try { config.value = await api('GET', '/api/user/config'); } catch { /* Login can still report server errors. */ }
  try { user.value = (await api('GET', '/api/user/me')).user; await loadData(); } catch { /* Show email login. */ }
  ready.value = true;
  if (!user.value) setupTurnstile();
  window.addEventListener('user-session-expired', expire);
});
onBeforeUnmount(() => { clearInterval(cooldownTimer); window.removeEventListener('user-session-expired', expire); });
function startCooldown() {
  cooldown.value = 60;
  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => { if (--cooldown.value <= 0) clearInterval(cooldownTimer); }, 1000);
}
async function sendCode() {
  busy.value = true; error.value = '';
  try {
    await api('POST', '/api/user/code', { email: email.value, website: website.value, turnstile_token: turnstileWidget !== undefined ? window.turnstile.getResponse(turnstileWidget) : '' });
    step.value = 2;
    startCooldown();
    if (window.turnstile && turnstileWidget !== undefined) window.turnstile.reset(turnstileWidget);
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function login() {
  busy.value = true; error.value = '';
  try {
    const result = await api('POST', '/api/user/login', { email: email.value, code: code.value });
    user.value = result.user;
    code.value = '';
    await loadData();
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function logout() { await api('POST', '/api/user/logout').catch(() => {}); expire(); }
function select(id) { tab.value = id; nav.value = false; if (id !== 'guide') loadData().catch(() => {}); }
async function createKey() {
  busy.value = true;
  const result = await run(() => api('POST', '/api/user/keys', { name: keyName.value, plan_id: selectedPlan.value || undefined }));
  busy.value = false;
  if (result) { keyModal.value = false; newKey.value = result.key; await loadData(); }
}
async function toggleKey(key) {
  const result = await run(() => api('PATCH', `/api/user/keys/${key.id}`, { enabled: !key.enabled }));
  if (result) { notify(key.enabled ? 'Key 已停用' : 'Key 已恢复'); loadData(); }
}
async function copy(value) { await copyText(value); notify('已复制到剪贴板'); }
</script>
<template>
  <div v-if="!ready" class="loading-screen"><span class="brand-mark small"><UiIcon name="activity" /></span><span>正在连接用户服务…</span></div>
  <main v-else-if="!user" class="login-page portal-login">
    <section class="login-card">
      <div class="login-brand"><span class="brand-mark"><UiIcon name="activity" :size="24" /></span><span>UMEKO <b>TOKEN</b></span></div>
      <div class="login-heading"><span class="eyebrow">MODEL API PORTAL</span><h1>{{ step === 1 ? '邮箱验证登录' : '输入验证码' }}</h1><p>{{ step === 1 ? '新邮箱验证后会自动创建账户' : `验证码已发送至 ${email}` }}</p></div>
      <form v-if="step === 1" class="stack" @submit.prevent="sendCode">
        <div class="field"><label for="portal-email">邮箱地址</label><input id="portal-email" v-model="email" type="email" autocomplete="email" placeholder="you@example.com" required autofocus /></div>
        <input v-model="website" class="honeypot" tabindex="-1" autocomplete="off" aria-hidden="true" />
        <div v-if="config.turnstile_site_key" id="turnstile"></div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary login-button" :disabled="busy">{{ busy ? '正在发送…' : '发送验证码' }}<UiIcon v-if="!busy" name="arrow" :size="17" /></button>
        <p v-if="config.development_email" class="dev-notice">开发模式：验证码会打印在云端服务日志中，不会通过接口返回。</p>
      </form>
      <form v-else class="stack" @submit.prevent="login">
        <div class="field"><label for="portal-code">6 位验证码</label><input id="portal-code" v-model="code" class="code-input" inputmode="numeric" pattern="\d{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" required autofocus /></div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary login-button" :disabled="busy || code.length !== 6">{{ busy ? '正在验证…' : '验证并登录' }}</button>
        <div class="login-secondary"><button type="button" class="text-button" @click="step = 1; error = ''">更换邮箱</button><button type="button" class="text-button" :disabled="cooldown > 0 || busy" @click="sendCode">{{ cooldown > 0 ? `${cooldown}s 后重发` : '重新发送' }}</button></div>
      </form>
      <div class="login-foot"><UiIcon name="shield" :size="15" />验证码 10 分钟内有效，无需设置密码<a href="/manage_login/" class="portal-admin-link">管理员入口</a></div>
    </section>
    <div class="login-decoration"><span></span><span></span><span></span></div>
  </main>
  <div v-else class="admin-layout portal-layout">
    <div v-if="nav" class="nav-scrim" @click="nav = false"></div>
    <aside class="sidebar" :class="{ open: nav }">
      <div class="brand"><span class="brand-mark small"><UiIcon name="activity" :size="20" /></span><div>UMEKO <b>TOKEN</b><span>USER PORTAL</span></div></div>
      <div class="nav-caption">模型服务</div>
      <nav class="admin-nav"><button :class="{ active: tab === 'overview' }" @click="select('overview')"><UiIcon name="dashboard" />使用概览</button><button :class="{ active: tab === 'keys' }" @click="select('keys')"><UiIcon name="key" />我的 API Key</button><button :class="{ active: tab === 'guide' }" @click="select('guide')"><UiIcon name="logs" />接入指南</button><button :class="{ active: tab === 'logs' }" @click="select('logs')"><UiIcon name="activity" />最近调用</button></nav>
      <div class="sidebar-status"><span class="status-dot"></span><div><strong>模型服务可用</strong><small>OpenAI Compatible</small></div></div>
      <div class="sidebar-footer"><span class="avatar">{{ user.email.slice(0, 1).toUpperCase() }}</span><div class="grow"><strong class="email-truncate">{{ user.email }}</strong><small>注册用户</small></div><button class="icon-button" title="退出登录" @click="logout"><UiIcon name="logout" :size="17" /></button></div>
    </aside>
    <main class="admin-content">
      <header class="topbar"><div class="breadcrumb"><button class="icon-button mobile-menu" @click="nav = true"><UiIcon name="menu" /></button><span>用户中心</span><span class="slash">/</span><strong>{{ { overview: '使用概览', keys: '我的 API Key', guide: '接入指南', logs: '最近调用' }[tab] }}</strong></div><div class="topbar-actions"><span class="connection"><i></i>{{ overview.models.length }} 个模型可用</span><button class="icon-button bordered" @click="loadData"><UiIcon name="refresh" :size="17" /></button></div></header>
      <div class="page-heading"><div><h1>{{ { overview: '使用概览', keys: '我的 API Key', guide: '接入指南', logs: '最近一小时' }[tab] }}</h1><p>{{ { overview: '查看可用模型和账户额度', keys: '申请和管理你自己的访问凭据', guide: '将云端模型接入你的本地 Agent 或应用', logs: '仅展示当前账户最近 60 分钟的调用' }[tab] }}</p></div></div>

      <template v-if="tab === 'overview'">
        <section class="portal-quota-grid"><article class="stat-card"><div class="stat-label">五小时可用额度</div><strong>{{ overview.usage.five_hours.remaining === null ? '不限' : formatNumber(overview.usage.five_hours.remaining) }}</strong><p>已使用 {{ formatNumber(overview.usage.five_hours.used) }} / {{ formatNumber(overview.usage.five_hours.quota) }} Token</p><div class="progress large"><i :style="{ width: `${percent(overview.usage.five_hours.used, overview.usage.five_hours.quota)}%` }"></i></div></article><article class="stat-card"><div class="stat-label">本周可用额度</div><strong>{{ overview.usage.week.remaining === null ? '不限' : formatNumber(overview.usage.week.remaining) }}</strong><p>已使用 {{ formatNumber(overview.usage.week.used) }} / {{ formatNumber(overview.usage.week.quota) }} Token</p><div class="progress large amber"><i :style="{ width: `${percent(overview.usage.week.used, overview.usage.week.quota)}%` }"></i></div></article><article class="stat-card"><div class="stat-label">最近一小时调用</div><strong>{{ formatNumber(overview.stats.requests) }}</strong><p>{{ formatNumber(overview.stats.tokens) }} Token · 成功率 {{ overview.stats.requests ? Math.round(overview.stats.successful / overview.stats.requests * 100) : 100 }}%</p></article></section>
        <section class="panel"><header class="panel-header"><div><h2>可用模型 <span class="count">{{ overview.models.length }}</span></h2><p>以下模型当前在线，可直接用于 API 请求</p></div><button class="primary" @click="select('keys')"><UiIcon name="plus" :size="16" />申请 Key</button></header><div v-if="overview.models.length" class="portal-models"><article v-for="model in overview.models" :key="`${model.provider_name}-${model.name}`"><span class="model-glyph"><UiIcon name="cloud" /></span><div><code>{{ model.name }}</code><p>{{ model.provider_name }}</p></div><dl><div><dt>输入 / 1M</dt><dd>${{ model.input_price }}</dd></div><div><dt>输出 / 1M</dt><dd>${{ model.output_price }}</dd></div></dl></article></div><EmptyState v-else icon="cloud" title="暂时没有在线模型" text="供应商上线后，模型会自动出现在这里。" /></section>
      </template>

      <section v-if="tab === 'keys'" class="panel"><header class="panel-header"><div><h2>我的访问凭据 <span class="count">{{ keys.length }}</span></h2><p>最多保留 3 个启用的 Key，账户下所有 Key 共享额度</p></div><button class="primary" @click="keyModal = true"><UiIcon name="plus" :size="16" />申请 API Key</button></header><EmptyState v-if="!keys.length" icon="key" title="还没有 API Key" text="创建一个 Key，即可在你的应用或本地 Agent 中调用模型。"><button class="primary" @click="keyModal = true">立即申请</button></EmptyState><div v-else class="key-list"><article v-for="key in keys" :key="key.id" class="key-card"><div class="key-card-top"><span class="key-icon"><UiIcon name="key" /></span><div class="grow"><h3>{{ key.name }}</h3><code class="key-prefix">{{ key.key_prefix }}</code></div><span class="badge" :class="key.enabled ? 'success' : 'neutral'">{{ key.enabled ? '正常' : '停用' }}</span></div><div class="key-meta"><span>累计 <b>{{ formatNumber(key.used_tokens) }} Token</b></span><span>最后使用 <b>{{ formatDate(key.last_used_at) }}</b></span></div><button class="button small" @click="toggleKey(key)">{{ key.enabled ? '停用此 Key' : '恢复此 Key' }}</button></article></div></section>

      <template v-if="tab === 'guide'"><section class="panel"><header class="panel-header"><div><h2>接入参数</h2><p>支持 OpenAI SDK、Anthropic Messages 及兼容的本地 Agent</p></div><button class="button small" @click="copy(envExample)"><UiIcon name="copy" :size="15" />复制环境变量</button></header><div class="endpoint-grid"><div><span>Base URL</span><code>{{ apiBase }}/v1</code></div><div><span>API Key</span><code>umo-sk-...（在我的 API Key 中申请）</code></div><div><span>Model</span><code>{{ overview.models[0]?.name || '从使用概览选择模型' }}</code></div></div></section><section class="panel"><header class="panel-header"><div><h2>本地 Agent 环境变量</h2><p>将以下配置填入 Dify、Cherry Studio、NextChat 或你的 Agent 框架</p></div></header><div class="code-block"><button class="icon-button" @click="copy(envExample)"><UiIcon name="copy" :size="16" /></button><pre>{{ envExample }}</pre></div></section><section class="panel"><header class="panel-header"><div><h2>curl 快速验证</h2><p>替换为你自己的 Key 和模型名称</p></div></header><div class="code-block"><button class="icon-button" @click="copy(curlExample)"><UiIcon name="copy" :size="16" /></button><pre>{{ curlExample }}</pre></div></section><section class="panel"><header class="panel-header"><div><h2>Python OpenAI SDK</h2><p>先安装 openai 包，再使用以下代码</p></div></header><div class="code-block"><button class="icon-button" @click="copy(pythonExample)"><UiIcon name="copy" :size="16" /></button><pre>{{ pythonExample }}</pre></div></section></template>

      <section v-if="tab === 'logs'" class="panel"><header class="panel-header"><div><h2>最近一小时调用 <span class="count">{{ overview.logs.length }}</span></h2><p>最多展示 100 条，不记录提示词和输出正文</p></div></header><EmptyState v-if="!overview.logs.length" icon="activity" title="最近一小时没有调用" text="使用你的 API Key 发起请求后，记录会显示在这里。" /><div v-else class="table-wrap"><table><thead><tr><th>时间</th><th>模型</th><th>Key</th><th>输入 / 输出 Token</th><th>延迟</th><th>状态</th></tr></thead><tbody><tr v-for="log in overview.logs" :key="log.id"><td>{{ formatDate(log.created_at) }}</td><td><code class="model-name">{{ log.model }}</code></td><td><code>{{ log.key_prefix }}</code></td><td>{{ formatNumber(log.prompt_tokens) }} / {{ formatNumber(log.completion_tokens) }}</td><td>{{ log.latency_ms }} ms</td><td><span class="badge" :class="log.status < 400 ? 'success' : 'danger'">{{ log.status }}</span></td></tr></tbody></table></div></section>
    </main>
  </div>
  <UiModal v-if="keyModal" title="申请 API Key" subtitle="新 Key 使用账户共享额度，也可选择管理员开放的申请方案。" @close="keyModal = false"><form id="portal-key-form" class="stack" @submit.prevent="createKey"><div class="field"><label>Key 名称</label><input v-model="keyName" maxlength="60" placeholder="例如：我的本地 Agent" required /></div><div v-if="overview.plans.length" class="field"><label>额度方案</label><select v-model="selectedPlan"><option value="">账户默认额度</option><option v-for="plan in overview.plans" :key="plan.id" :value="plan.id">{{ plan.name }} · 5h {{ formatNumber(plan.quota_5h) }} / 周 {{ formatNumber(plan.quota_week) }}</option></select><span class="help-text">申请后会生成你自己的新 Key，不会共享管理员的原始 Key。</span></div></form><template #footer><button @click="keyModal = false">取消</button><button class="primary" form="portal-key-form" :disabled="busy">生成 Key</button></template></UiModal>
  <SecretModal v-if="newKey" title="你的 API Key 已生成" :secret="newKey" description="完整 Key 只显示一次。请将它配置在你的应用或本地 Agent 中。" @close="newKey = ''" />
  <footer class="icp-footer"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer nofollow">黔ICP备2026019339号</a></footer>
  <div class="toast-stack" aria-live="polite"><div v-for="toast in toasts" :key="toast.id" class="toast" :class="{ bad: toast.bad }"><UiIcon :name="toast.bad ? 'info' : 'check'" :size="17" />{{ toast.message }}</div></div>
</template>
