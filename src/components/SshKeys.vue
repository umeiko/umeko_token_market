<script setup>
import { onMounted, ref } from 'vue';
import { api, formatDate } from '../api.js';
import { notify, run } from '../store.js';
import UiIcon from './UiIcon.vue';
const keys = ref([]), name = ref('云电脑 SSH Key'), publicKey = ref(''), busy = ref(false);
async function load() { keys.value = (await api('GET', '/api/admin/ssh-keys')).keys; }
async function add() {
  busy.value = true;
  const result = await run(() => api('POST', '/api/admin/ssh-keys', { name: name.value, publicKey: publicKey.value }));
  busy.value = false;
  if (result) { publicKey.value = ''; notify('SSH 公钥已授权'); load(); }
}
async function remove(key) {
  if (!window.confirm(`确定移除“${key.name}”吗？该公钥将立即无法登录。`)) return;
  const result = await run(() => api('DELETE', `/api/admin/ssh-keys/${key.id}`));
  if (result) { notify('公钥已移除'); load(); }
}
onMounted(load);
</script>
<template>
  <section class="panel deployment-panel"><header class="panel-header"><div><h2>SSH Key 登录</h2><p>仅管理员可用，可直接复用云电脑已有的 OpenSSH 公钥</p></div><span class="badge neutral">{{ keys.length }} 个授权</span></header><div class="panel-form stack"><div class="form-grid two"><div class="field"><label>名称</label><input v-model="name" maxlength="60" placeholder="云电脑 SSH Key" /></div><div class="field"><label>OpenSSH 公钥</label><input v-model="publicKey" placeholder="ssh-ed25519 AAAA... 或 ssh-rsa AAAA..." required /></div></div><button class="primary self-start" :disabled="busy || !publicKey.trim()" @click="add"><UiIcon name="plus" :size="16" />授权公钥</button><div v-if="keys.length" class="ssh-key-list"><div v-for="key in keys" :key="key.id"><span class="key-icon"><UiIcon name="shield" /></span><div class="grow"><strong>{{ key.name }}</strong><code>{{ key.fingerprint }}</code><small>最后使用 {{ formatDate(key.last_used_at) }}</small></div><button class="button small danger-text" @click="remove(key)">移除</button></div></div><p class="help-text">私钥始终保留在你的电脑。登录时服务器只验证 ssh-keygen 对随机挑战的签名。</p></div></section>
</template>
