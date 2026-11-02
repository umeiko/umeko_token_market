<script setup>
import UiIcon from './UiIcon.vue';
defineProps({ title: String, subtitle: String, wide: Boolean });
const emit = defineEmits(['close']);
</script>
<template>
  <Teleport to="body">
    <div class="modal-backdrop" @mousedown.self="emit('close')">
      <section class="modal" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
        <header class="modal-header">
          <div><h2>{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></div>
          <button class="icon-button" aria-label="关闭" @click="emit('close')"><UiIcon name="close" /></button>
        </header>
        <div class="modal-body"><slot /></div>
        <footer v-if="$slots.footer" class="modal-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
