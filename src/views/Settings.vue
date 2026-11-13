<script setup>
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api.js';
import { notify, run } from '../store.js';
import UiIcon from '../components/UiIcon.vue';
import SshKeys from '../components/SshKeys.vue';
const settings = reactive({ site_name: '', request_timeout_ms: 300000 });
const password = reactive({ current_password: '', new_password: '', confirm: '' });
const saving = ref(false);
onMounted(async () => Object.assign(settings, (await api('GET', '/api/admin/settings')).settings));
async function saveSettings() { saving.value = true; const result = await run(() => api('PATCH', '/api/admin/settings', settings)); saving.value = false; if (result) notify('系统设置已保存'); }
async function changePassword() {
  if (password.new_password !== password.confirm) return notify('两次输入的新密码不一致', true);
  const result = await run(() => api('POST', '/api/admin/password', password));
  if (result?.ok) { Object.assign(password, { current_password: '', new_password: '', confirm: '' }); notify('管理员密码已更新'); }
  else if (result) notify(result.error, true);
}
</script>
<template><div class="settings-grid"><section class="panel"><header class="panel-header"><div><h2>基本设置</h2><p>调整控制台名称与中转请求行为</p></div></header><form class="panel-form stack" @submit.prevent="saveSettings"><div class="field"><label>服务名称</label><input v-model="settings.site_name" maxlength="60" required /><span class="help-text">显示在管理控制台顶部。</span></div><div class="field"><label>本地推理请求超时（毫秒）</label><input v-model.number="settings.request_timeout_ms" type="number" min="5000" max="1800000" step="1000" required /><span class="help-text">长文本生成可适当调大，允许 5 秒至 30 分钟。</span></div><button class="primary self-start" :disabled="saving">{{ saving ? '保存中…' : '保存设置' }}</button></form></section><section class="panel"><header class="panel-header"><div><h2>管理员安全</h2><p>定期更新密码，保护供应商和 Key 管理权限</p></div></header><form class="panel-form stack" @submit.prevent="changePassword"><div class="field"><label>当前密码</label><input v-model="password.current_password" type="password" autocomplete="current-password" required /></div><div class="field"><label>新密码</label><input v-model="password.new_password" type="password" autocomplete="new-password" minlength="10" required /><span class="help-text">至少 10 个字符，建议使用密码管理器生成。</span></div><div class="field"><label>确认新密码</label><input v-model="password.confirm" type="password" autocomplete="new-password" minlength="10" required /></div><button class="primary self-start">更新密码</button></form></section><section class="panel deployment-panel"><header class="panel-header"><div><h2>部署检查清单</h2><p>将服务暴露到公网前，请确认以下项目</p></div></header><div class="checklist"><div><span><UiIcon name="check" :size="16" /></span><p><strong>使用 HTTPS / WSS</strong><small>通过 Caddy 或 Nginx 为云端配置有效证书，保护 API Key 和模型内容。</small></p></div><div><span><UiIcon name="check" :size="16" /></span><p><strong>持久化 data 目录</strong><small>供应商、Key 和账单存储在 SQLite 数据库中，请勿丢失 data/market.db。</small></p></div><div><span><UiIcon name="check" :size="16" /></span><p><strong>保护本地推理端口</strong><small>llama.cpp、vLLM 或 SGLang 只需监听家中内网，云端不会直接访问该端口。</small></p></div></div></section><SshKeys /></div></template>
