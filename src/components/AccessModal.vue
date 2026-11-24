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
const copied = ref('');
const hasFullKey = computed(() => Boolean(props.apiKey));
const envText = computed(() => {
  const lines = [`OPENAI_BASE_URL=${props.baseUrl}`, `OPENAI_API_KEY=${props.apiKey}`];
  const [model] = props.models;
  if (props.models.length === 1) {
    const id = /^[\w./:-]+$/.test(model.id) ? model.id : "'" + model.id.replaceAll("'", "'\\''") + "'";
    lines.push(`OPENAI_MODEL=${id}`);
  } else {
    for (const { id } of props.models) lines.push(`# Model ID: ${id.replace(/[\r\n]/g, ' ')}`);
  }
  if (props.models.some(({ h3 }) => h3)) lines.push(`# H3 API JSON: ${props.baseUrl}/videos/help.json`);
  return lines.join('\n');
});
async function copy(value, field) {
  await copyText(value);
  copied.value = field;
  setTimeout(() => copied.value = '', 1500);
}
defineExpose({ copy, envText });
</script>
<template>
  <UiModal title="API 接入信息" subtitle="请求时填写下面对应的 Model ID。" @close="emit('close')">
    <div class="secret-notice"><UiIcon name="shield" /><span>请妥善保管接入信息和 API Key。</span></div>
    <div class="stack">
      <div class="field"><label>Base URL</label><div class="secret-box"><code>{{ baseUrl }}</code><button class="icon-button" title="复制 Base URL" @click="copy(baseUrl, 'url')"><UiIcon :name="copied === 'url' ? 'check' : 'copy'" /></button></div></div>
      <div class="field">
        <label>Model ID</label>
        <ul v-if="models.length" class="access-models">
          <li v-for="model in models" :key="model.id" class="secret-box">
            <code>{{ model.id }}</code>
            <button class="icon-button" :aria-label="`复制 Model ID ${model.id}`" @click="copy(model.id, model.id)">
              <UiIcon :name="copied === model.id ? 'check' : 'copy'" />
            </button>
          </li>
        </ul>
        <span v-else class="help-text">这把 Key 暂无可展示的模型。</span>
      </div>
      <div class="field"><label>API Key</label><div class="secret-box"><code>{{ apiKey || keyPrefix }}</code><button v-if="hasFullKey" class="icon-button" title="复制 API Key" @click="copy(apiKey, 'key')"><UiIcon :name="copied === 'key' ? 'check' : 'copy'" /></button></div><span v-if="!hasFullKey" class="help-text">这是掩码，不能用于调用。点击“生成替代 Key 并复制”会停用旧 Key 的后续请求。</span></div>
      <div v-if="hasFullKey" class="field"><label>完整接入信息</label><div class="command-box"><pre><code>{{ envText }}</code></pre><button class="icon-button" title="复制完整接入信息" @click="copy(envText, 'env')"><UiIcon :name="copied === 'env' ? 'check' : 'copy'" /></button></div></div>
      <p v-else class="help-text">生成替代 Key 后，将自动复制包含 Base URL、Model ID 和新 Key 的环境变量。</p>
    </div>
    <template #footer><button v-if="!hasFullKey" class="primary" :disabled="rotating" @click="emit('rotate')"><UiIcon name="refresh" :size="15" />{{ rotating ? '正在生成…' : '生成替代 Key 并复制' }}</button><button v-else class="primary" @click="copy(envText, 'env')"><UiIcon name="copy" :size="15" />复制全部</button></template>
  </UiModal>
</template>

<style scoped>
.access-models { display: grid; gap: 6px; margin: 0; padding: 0; }
.access-models .secret-box { flex-wrap: wrap; margin: 0; }
.access-models code { min-width: 0; flex: 1 1 130px; overflow-wrap: anywhere; }
</style>
