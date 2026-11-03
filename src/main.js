import { createApp } from 'vue';
import App from './App.vue';
import PortalApp from './PortalApp.vue';
import './style.css';

const entryPath = location.pathname.replace(/\/+$/, '');
const isPortal = entryPath.endsWith('/api_login') || entryPath.endsWith('/portal');
document.title = isPortal ? 'Umeko Token · 用户中心' : 'Umeko Token Relay · 管理控制台';
createApp(isPortal ? PortalApp : App).mount('#app');
