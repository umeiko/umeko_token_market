<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from './api.js';
import { toasts } from './store.js';
import UiIcon from './components/UiIcon.vue';
import Dashboard from './views/Dashboard.vue';
import Providers from './views/Providers.vue';
import Keys from './views/Keys.vue';
import Users from './views/Users.vue';
import Usage from './views/Usage.vue';
import Logs from './views/Logs.vue';
import Settings from './views/Settings.vue';

const tabs = [
  { id: 'dashboard', label: '运行概览', icon: 'dashboard', description: '服务状态与核心运营指标', component: Dashboard },
  { id: 'providers', label: '供应商与模型', icon: 'server', description: '管理本地节点、模型价格与并发', component: Providers },
  { id: 'keys', label: 'API Key', icon: 'key', description: '凭据下发、额度与访问限制', component: Keys },
  { id: 'users', label: '注册用户', icon: 'users', description: '搜索用户、调整额度与重置用量', component: Users },
  { id: 'usage', label: '用量与账单', icon: 'chart', description: 'Token 消耗与费用统计', component: Usage },
  { id: 'logs', label: '请求日志', icon: 'logs', description: '追踪每一次中转请求', component: Logs },
  { id: 'settings', label: '系统设置', icon: 'settings', description: '服务参数与管理员安全', component: Settings },
];
const initial = location.hash.slice(1);
const current = ref(tabs.some((tab) => tab.id === initial) ? initial : 'dashboard');
const active = computed(() => tabs.find((tab) => tab.id === current.value));
const ready = ref(false), user = ref(null), username = ref(''), password = ref(''), error = ref(''), busy = ref(false), nav = ref(false);
const siteName = ref('Umeko Token Relay');
async function loadSettings() {
  try { siteName.value = (await api('GET', '/api/admin/settings')).settings.site_name || 'Umeko Token Relay'; } catch { /* Login page does not need settings. */ }
}
onMounted(async () => {
  try { user.value = (await api('GET', '/api/admin/me')).user; await loadSettings(); } catch { /* Show sign-in. */ }
  ready.value = true;
  window.addEventListener('session-expired', expire);
  window.addEventListener('hashchange', syncHash);
});
onBeforeUnmount(() => {
  window.removeEventListener('session-expired', expire);
  window.removeEventListener('hashchange', syncHash);
});
function expire() { user.value = null; }
function syncHash() {
  const id = location.hash.slice(1);
  if (tabs.some((tab) => tab.id === id)) current.value = id;
}
async function login() {
  busy.value = true; error.value = '';
  try {
    user.value = (await api('POST', '/api/admin/login', { username: username.value, password: password.value })).user;
    password.value = '';
    await loadSettings();
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function logout() {
  await api('POST', '/api/admin/logout').catch(() => {});
  user.value = null;
}
function select(id) { current.value = id; location.hash = id; nav.value = false; }
function refresh() { window.dispatchEvent(new Event('relay-refresh')); }
</script>
<template>
  <div v-if="!ready" class="loading-screen"><span class="brand-mark small"><UiIcon name="activity" /></span><span>正在连接管理服务…</span></div>
  <main v-else-if="!user" class="login-page">
    <section class="login-card">
      <div class="login-brand"><span class="brand-mark"><UiIcon name="activity" :size="24" /></span><span>UMEKO <b>TOKEN</b></span></div>
      <div class="login-heading"><span class="eyebrow">ADMIN CONSOLE</span><h1>欢迎回来</h1><p>登录以管理你的模型中转服务</p></div>
      <form class="stack" @submit.prevent="login">
        <div class="field"><label for="username">管理员账号</label><input id="username" v-model="username" autocomplete="username" placeholder="请输入账号" required autofocus /></div>
        <div class="field"><label for="password">密码</label><input id="password" v-model="password" type="password" autocomplete="current-password" placeholder="请输入密码" required /></div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary login-button" :disabled="busy">{{ busy ? '正在登录…' : '登录控制台' }}<UiIcon v-if="!busy" name="arrow" :size="17" /></button>
      </form>
      <div class="login-foot"><UiIcon name="shield" :size="15" />凭据通过安全会话验证，请勿在公共设备上保存密码<a href="./portal" class="portal-admin-link">模型用户入口</a></div>
    </section>
    <div class="login-decoration"><span></span><span></span><span></span></div>
  </main>
  <div v-else class="admin-layout">
    <div v-if="nav" class="nav-scrim" @click="nav = false"></div>
    <aside class="sidebar" :class="{ open: nav }">
      <div class="brand"><span class="brand-mark small"><UiIcon name="activity" :size="20" /></span><div>UMEKO <b>TOKEN</b><span>API GATEWAY</span></div></div>
      <div class="nav-caption">管理控制台</div>
      <nav class="admin-nav" aria-label="管理导航">
        <button v-for="tab in tabs" :key="tab.id" :class="{ active: current === tab.id }" :aria-current="current === tab.id ? 'page' : undefined" @click="select(tab.id)"><UiIcon :name="tab.icon" /><span>{{ tab.label }}</span><i v-if="current === tab.id"></i></button>
      </nav>
      <a class="sidebar-status" href="/remote/"><UiIcon name="server" /><div><strong>远程工作台 ↗</strong><small>专属密钥 · 桌面与 SSH</small></div></a>
      <div class="sidebar-status"><span class="status-dot"></span><div><strong>网关运行中</strong><small>OpenAI Compatible</small></div></div>
      <div class="sidebar-footer"><span class="avatar">{{ user.username.slice(0, 1).toUpperCase() }}</span><div class="grow"><strong>{{ user.username }}</strong><small>系统管理员</small></div><button class="icon-button" title="退出登录" @click="logout"><UiIcon name="logout" :size="17" /></button></div>
    </aside>
    <main class="admin-content">
      <header class="topbar"><div class="breadcrumb"><button class="icon-button mobile-menu" @click="nav = true"><UiIcon name="menu" /></button><span>控制台</span><span class="slash">/</span><strong>{{ active.label }}</strong></div><div class="topbar-actions"><span class="connection"><i></i>管理服务已连接</span><button class="icon-button bordered" title="刷新当前页面" @click="refresh"><UiIcon name="refresh" :size="17" /></button></div></header>
      <div class="page-heading"><div><h1>{{ active.label }}</h1><p>{{ active.description }}</p></div><span class="site-pill">{{ siteName }}</span></div>
      <component :is="active.component" :key="current" />
    </main>
  </div>
  <footer class="icp-footer"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer nofollow">黔ICP备2026019339号</a></footer>
  <div class="toast-stack" aria-live="polite"><div v-for="toast in toasts" :key="toast.id" class="toast" :class="{ bad: toast.bad }"><UiIcon :name="toast.bad ? 'info' : 'check'" :size="17" />{{ toast.message }}</div></div>
</template>
