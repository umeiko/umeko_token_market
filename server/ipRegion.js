import { isIP } from 'node:net';

function localRegion(ip) {
  let value = String(ip || '').trim();
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    if (parts[0] === 127) return '本地地址';
    if (parts[0] === 10 || parts[0] === 0 || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 192 && parts[1] === 0 && parts[2] === 2)
      || (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)) return '内网地址';
    if (parts[0] >= 224) return '';
    return null;
  }
  if (isIP(value) === 6) {
    const normalized = value.toLowerCase();
    if (normalized === '::1') return '本地地址';
    if (normalized === '::' || normalized.startsWith('ff')) return '';
    if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) || normalized.startsWith('2001:db8:')) return '内网地址';
    return null;
  }
  return '';
}

async function lookup(ip) {
  const template = process.env.IP_GEO_LOOKUP_URL || 'https://ipwho.is/{ip}';
  const response = await fetch(template.replaceAll('{ip}', encodeURIComponent(ip)), {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`IP region lookup returned ${response.status}`);
  const data = await response.json();
  if (data.success === false) return '';
  return [...new Set([data.country, data.region, data.city]
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim().replace(/\s+/g, ' ')))].join(' · ').slice(0, 200);
}

export class IpRegionResolver {
  constructor() {
    this.cache = new Map();
    this.pending = new Map();
  }

  resolve(ip) {
    const local = localRegion(ip);
    if (local !== null) return Promise.resolve(local);
    const cached = this.cache.get(ip);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.region);
    if (this.pending.has(ip)) return this.pending.get(ip);
    const task = lookup(ip).then((region) => {
      this.cache.set(ip, { region, expires: Date.now() + (region ? 86400000 : 300000) });
      return region;
    }).catch(() => {
      this.cache.set(ip, { region: '', expires: Date.now() + 300000 });
      return '';
    }).finally(() => this.pending.delete(ip));
    this.pending.set(ip, task);
    return task;
  }
}
