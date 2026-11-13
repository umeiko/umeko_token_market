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
const loginMethod = ref('password'), sshPublicKey = ref(''), sshChallenge = ref(null), sshSignature = ref('');
const identityFileName = ref('');
const sshCommand = computed(() => sshChallenge.value ? `printf '%s' '${sshChallenge.value.challenge}' > /tmp/umeko-admin-challenge\nssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n umeko-admin /tmp/umeko-admin-challenge` : '');
function base64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
async function identityLogin(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  busy.value = true; error.value = ''; identityFileName.value = file.name;
  try {
    const identity = JSON.parse(await file.text());
    if (identity.version !== 1 || typeof identity.privateKey !== 'string') throw new Error('请选择有效的 .umeko-key 身份文件');
    const bytes = Uint8Array.from(atob(identity.privateKey), (char) => char.charCodeAt(0));
    const privateKey = await crypto.subtle.importKey('pkcs8', bytes.buffer, { name: 'Ed25519' }, false, ['sign']);
    const challenge = await api('POST', '/api/admin/ed25519/challenge', {});
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(challenge.challenge));
    const result = await api('POST', '/api/admin/ed25519/login', { id: challenge.id, challenge: challenge.challenge, signature: base64(signature) });
    user.value = result.user;
    await loadSettings();
  } catch (e) {
    error.value = `无法使用此身份文件：${e.message}`;
  } finally {
    event.target.value = '';
    busy.value = false;
  }
}
async function createSshChallenge() {
  busy.value = true; error.value = '';
  try { sshChallenge.value = await api('POST', '/api/admin/ssh/challenge', { publicKey: sshPublicKey.value }); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
function readSignature(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { sshSignature.value = String(reader.result).split(',')[1] || ''; };
  reader.readAsDataURL(file);
}
async function sshLogin() {
  busy.value = true; error.value = '';
  try {
    const result = await api('POST', '/api/admin/ssh/login', { id: sshChallenge.value.id, publicKey: sshPublicKey.value, signature: sshSignature.value });
    user.value = result.user;
    await loadSettings();
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
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
      <div class="login-methods"><button :class="{ active: loginMethod === 'password' }" @click="loginMethod = 'password'; error = ''">密码登录</button><button :class="{ active: loginMethod === 'ssh' }" @click="loginMethod = 'ssh'; error = ''">SSH Key</button><button :class="{ active: loginMethod === 'identity' }" @click="loginMethod = 'identity'; error = ''">身份 Key</button></div>
      <form v-if="loginMethod === 'password'" class="stack" @submit.prevent="login">
        <div class="field"><label for="username">管理员账号</label><input id="username" v-model="username" autocomplete="username" placeholder="请输入账号" required autofocus /></div>
        <div class="field"><label for="password">密码</label><input id="password" v-model="password" type="password" autocomplete="current-password" placeholder="请输入密码" required /></div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="primary login-button" :disabled="busy">{{ busy ? '正在登录…' : '登录控制台' }}<UiIcon v-if="!busy" name="arrow" :size="17" /></button>
      </form>
      <div v-else-if="loginMethod === 'identity'" class="stack">
        <div class="field"><label for="identity-private-key">.umeko-key 身份文件</label><input id="identity-private-key" type="file" accept=".umeko-key,application/json" :disabled="busy" @change="identityLogin" /><span class="help-text">选择 admin.umeko-key。Ed25519 签名仅在浏览器本地完成，私钥不会上传。</span></div>
        <p v-if="identityFileName" class="help-text">{{ busy ? `正在验证 ${identityFileName}…` : identityFileName }}</p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </div>
      <div v-else class="stack">
        <template v-if="!sshChallenge"><div class="field"><label for="ssh-public-key">已授权的 OpenSSH 公钥</label><textarea id="ssh-public-key" v-model="sshPublicKey" rows="3" placeholder="ssh-ed25519 AAAA..." required></textarea><span class="help-text">先在系统设置中添加公钥，可直接复用云电脑 Key。</span></div><p v-if="error" class="form-error">{{ error }}</p><button class="primary login-button" :disabled="busy || !sshPublicKey.trim()" @click="createSshChallenge">获取签名挑战</button></template>
        <template v-else><div class="field"><label>在保存私钥的电脑执行</label><div class="command-box"><pre><code>{{ sshCommand }}</code></pre></div><span class="help-text">会生成 /tmp/umeko-admin-challenge.sig。挑战 5 分钟内有效。</span></div><div class="field"><label>上传签名文件</label><input type="file" accept=".sig" @change="readSignature" /></div><p v-if="error" class="form-error">{{ error }}</p><button class="primary login-button" :disabled="busy || !sshSignature" @click="sshLogin">验证签名并登录</button><button class="text-button self-start" @click="sshChallenge = null; sshSignature = ''">重新获取挑战</button></template>
      </div>
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
