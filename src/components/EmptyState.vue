<script setup>
import UiIcon from './UiIcon.vue';
defineProps({ icon: { type: String, default: 'logs' }, title: String, text: String });
</script>
<template><div class="empty-state"><span class="empty-icon"><UiIcon :name="icon" :size="25" /></span><h3>{{ title }}</h3><p>{{ text }}</p><slot /></div></template>
