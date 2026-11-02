<script setup>
import { ref } from 'vue';
import UiModal from './UiModal.vue';
import UiIcon from './UiIcon.vue';
import { copyText } from '../api.js';
defineProps({ title: String, secret: String, description: String, command: String });
const emit = defineEmits(['close']);
const copied = ref('');
async function copy(value, type) {
  await copyText(value);
  copied.value = type;
  setTimeout(() => copied.value = '', 1500);
}
</script>
<template>
  <UiModal :title="title" subtitle="此凭据只显示一次，关闭后无法再次查看。" @close="emit('close')">
    <div class="secret-notice"><UiIcon name="shield" /><span>{{ description || '请立即复制并妥善保存，服务器仅保存它的 SHA-256 哈希。' }}</span></div>
    <label class="field-label">访问凭据</label>
    <div class="secret-box"><code>{{ secret }}</code><button class="icon-button" @click="copy(secret, 'secret')"><UiIcon :name="copied === 'secret' ? 'check' : 'copy'" /></button></div>
    <template v-if="command">
      <label class="field-label">本地端启动命令</label>
      <div class="command-box"><pre><code>{{ command }}</code></pre><button class="icon-button" @click="copy(command, 'command')"><UiIcon :name="copied === 'command' ? 'check' : 'copy'" /></button></div>
      <p class="help-text">请先修改 LOCAL_BASE_URL 为你自己的 llama.cpp、vLLM 或 SGLang 服务地址。</p>
    </template>
    <template #footer><button class="primary" @click="emit('close')">我已安全保存</button></template>
  </UiModal>
</template>
