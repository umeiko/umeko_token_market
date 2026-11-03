<script setup>
const props = defineProps({ name: { type: String, required: true }, size: { type: Number, default: 19 } });
const paths = {
  dashboard: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  server: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h.01', 'M8 17h.01', 'M12 7h5', 'M12 17h5'],
  key: ['M15 7a5 5 0 110 10 5 5 0 010-10z', 'M11 11L3 19', 'M6 16l2 2', 'M8 14l2 2'],
  users: ['M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2', 'M9 11a4 4 0 100-8 4 4 0 000 8z', 'M22 21v-2a4 4 0 00-3-3.87', 'M16 3.13a4 4 0 010 7.75'],
  chart: ['M4 19V5', 'M4 19h17', 'M7 15l4-5 4 2 5-7'],
  logs: ['M6 3h12v18H6z', 'M9 8h6', 'M9 12h6', 'M9 16h4'],
  settings: ['M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z', 'M19.4 15a1.7 1.7 0 00.34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0015 19.4a1.7 1.7 0 00-1 .6 1.7 1.7 0 00-.4 1.1V21h-4v-.09A1.7 1.7 0 008.6 19.4a1.7 1.7 0 00-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.6-1H3v-4h.09A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001-1.6V3h4v.09A1.7 1.7 0 0015 4.6a1.7 1.7 0 001.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0019.4 9a1.7 1.7 0 001.6 1h.09v4H21a1.7 1.7 0 00-1.6 1z'],
  plus: ['M12 5v14', 'M5 12h14'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  logout: ['M10 5H4v14h6', 'M14 8l4 4-4 4', 'M8 12h10'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  refresh: ['M20 6v5h-5', 'M4 18v-5h5', 'M6.1 9a7 7 0 0111.5-2.6L20 11', 'M4 13l2.4 4.6A7 7 0 0018 15'],
  copy: ['M8 8h12v12H8z', 'M4 16V4h12'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 14h10l1-14', 'M10 11v6', 'M14 11v6'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12l4 4L19 6'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  info: ['M12 11v6', 'M12 7h.01', 'M12 22a10 10 0 100-20 10 10 0 000 20z'],
  cloud: ['M7 18a5 5 0 01-.5-10A7 7 0 0120 10a4 4 0 01-1 8z'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 13v7H4V6h7'],
};
</script>
<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path v-for="path in paths[props.name] || paths.info" :key="path" :d="path" />
  </svg>
</template>
