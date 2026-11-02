<script setup>
import { computed } from 'vue';
import { formatNumber } from '../api.js';
const props = defineProps({ series: { type: Array, default: () => [] }, metric: { type: String, default: 'requests' } });
const width = 760, height = 210, pad = 24;
const values = computed(() => props.series.map((item) => Number(item[props.metric] || 0)));
const max = computed(() => Math.max(1, ...values.value));
const points = computed(() => values.value.map((value, index) => ({
  x: pad + index * ((width - pad * 2) / Math.max(1, values.value.length - 1)),
  y: height - pad - (value / max.value) * (height - pad * 2), value,
})));
const line = computed(() => points.value.map((point) => `${point.x},${point.y}`).join(' '));
const area = computed(() => points.value.length ? `${pad},${height - pad} ${line.value} ${points.value.at(-1).x},${height - pad}` : '');
</script>
<template>
  <div class="chart-wrap">
    <svg class="usage-chart" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" role="img" aria-label="近14天用量趋势">
      <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#159fb2" stop-opacity=".22"/><stop offset="1" stop-color="#159fb2" stop-opacity="0"/></linearGradient></defs>
      <line v-for="n in 4" :key="n" x1="24" :x2="736" :y1="24 + (n - 1) * 54" :y2="24 + (n - 1) * 54" class="chart-grid" />
      <polygon :points="area" fill="url(#chart-fill)" />
      <polyline :points="line" fill="none" stroke="#0b8da2" stroke-width="2.5" vector-effect="non-scaling-stroke" />
      <g v-for="(point, index) in points" :key="index"><circle :cx="point.x" :cy="point.y" r="3" fill="#fff" stroke="#0b8da2" stroke-width="2" vector-effect="non-scaling-stroke"><title>{{ series[index].day }} · {{ formatNumber(point.value) }}</title></circle></g>
    </svg>
    <div class="chart-labels"><span>{{ series[0]?.day?.slice(5) }}</span><span>{{ series[6]?.day?.slice(5) }}</span><span>{{ series.at(-1)?.day?.slice(5) }}</span></div>
  </div>
</template>
