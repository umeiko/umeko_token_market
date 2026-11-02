export async function api(method, path, body) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const response = await fetch(`${base}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/admin/login') window.dispatchEvent(new Event('session-expired'));
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return data;
}

export const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
export const formatCost = (value) => `$${Number(value || 0).toFixed(4)}`;
export const formatDate = (value) => value ? new Date(`${value.replace(' ', 'T')}Z`).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const percent = (used, quota) => quota > 0 ? Math.min(100, (used / quota) * 100) : 0;

export async function copyText(text) {
  await navigator.clipboard.writeText(text);
}
