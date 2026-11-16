<script setup>
import { computed } from 'vue';
import {
  Activity,
  ArrowRight,
  Check,
  Cloud,
  Copy,
  ExternalLink,
  FileText,
  Info,
  KeyRound,
  LayoutDashboard,
  LineChart,
  LogOut,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from '@lucide/vue';

const props = defineProps({ name: { type: String, required: true }, size: { type: Number, default: 19 } });
const icons = {
  dashboard: LayoutDashboard,
  server: Server,
  key: KeyRound,
  users: Users,
  chart: LineChart,
  logs: FileText,
  settings: Settings,
  plus: Plus,
  menu: Menu,
  logout: LogOut,
  shield: ShieldCheck,
  refresh: RefreshCw,
  copy: Copy,
  edit: Pencil,
  trash: Trash2,
  close: X,
  check: Check,
  arrow: ArrowRight,
  activity: Activity,
  info: Info,
  cloud: Cloud,
  external: ExternalLink,
};
const icon = computed(() => icons[props.name] || Info);
</script>
<template>
  <component :is="icon" :size="size" :stroke-width="1.8" aria-hidden="true" />
</template>
