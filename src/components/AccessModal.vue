<script setup>
import { computed, ref } from 'vue';
import UiModal from './UiModal.vue';
import UiIcon from './UiIcon.vue';
import { copyText } from '../api.js';

const props = defineProps({
  name: String,
  apiKey: String,
  keyPrefix: String,
  baseUrl: String,
  models: { type: Array, default: () => [] },
  rotating: Boolean,
});
const emit = defineEmits(['close', 'rotate']);
const selectedModel = ref(props.models[0]?.name || 'your-model');
const copied = ref('');
const hasFullKey = computed(() => Boolean(props.apiKey));
const envText = computed(() => `OPENAI_BASE_URL=${props.baseUrl}\nOPENAI_API_KEY=${props.apiKey || props.keyPrefix}\nOPENAI_MODEL=${selectedModel.value}`);
async function copy(value, field) {
  await copyText(value);
  copied.value = field;
  setTimeout(() => copied.value = '', 1500);
}
</script>
<template>
  <UiModal title="API 接入信息" subtitle="选择模型并复制到你的应用。完整 Key 仅在创建或替换时显示一次。" @close="emit('close')">
    <div class="secret-notice"><UiIcon name="shield" /><span>请勿把接入信息发送到公开频道。已有 Key 只保存哈希，不能查看原文，可生成替代 Key。</span></div>
    <div class="stack">
      <div class="field"><label>Base URL</label><div class="secret-box"><code>{{ baseUrl }}</code><button class="icon-button" title="复制 Base URL" @click="copy(baseUrl, 'url')"><UiIcon :name="copied === 'url' ? 'check' : 'copy'" /></button></div></div>
      <div class="field"><label>Model ID</label><div class="secret-box"><select v-model="selectedModel"><option v-for="model in models" :key="`${model.provider_id}-${model.name}`" :value="model.name">{{ model.name }}</option><option v-if="!models.length" value="your-model">your-model</option></select><button class="icon-button" title="复制 Model ID" @click="copy(selectedModel, 'model')"><UiIcon :name="copied === 'model' ? 'check' : 'copy'" /></button></div></div>
      <div class="field"><label>API Key</label><div class="secret-box"><code>{{ apiKey || keyPrefix }}</code><button class="icon-button" title="复制 API Key" @click="copy(apiKey || keyPrefix, 'key')"><UiIcon :name="copied === 'key' ? 'check' : 'copy'" /></button></div><span v-if="!hasFullKey" class="help-text">这是掩码，不能用于调用。点击“生成替代 Key”会停用旧 Key 的后续请求。</span></div>
      <div class="field"><label>环境变量</label><div class="command-box"><pre><code>{{ envText }}</code></pre><button class="icon-button" title="复制环境变量" @click="copy(envText, 'env')"><UiIcon :name="copied === 'env' ? 'check' : 'copy'" /></button></div></div>
    </div>
    <template #footer><button v-if="!hasFullKey" :disabled="rotating" @click="emit('rotate')"><UiIcon name="refresh" :size="15" />{{ rotating ? '正在生成…' : '生成替代 Key' }}</button><button class="primary" @click="copy(envText, 'env')"><UiIcon name="copy" :size="15" />复制全部</button></template>
  </UiModal>
</template>
