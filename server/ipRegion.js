import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
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

function getJson(url) {
  return new Promise((resolve, reject) => {
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(url, { family: 4, headers: { accept: 'application/json' } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
        if (text.length > 2 * 1024 * 1024) request.destroy(new Error('IP region response too large'));
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`IP region lookup returned ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('IP region lookup timeout')));
    request.on('error', reject);
  });
}

async function lookup(ip) {
  const template = process.env.IP_GEO_LOOKUP_URL || 'https://ipwho.is/{ip}';
  const data = await getJson(new URL(template.replaceAll('{ip}', encodeURIComponent(ip))));
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
    }).catch((error) => {
      console.warn(`IP region lookup failed for ${ip}: ${error.message}`);
      this.cache.set(ip, { region: '', expires: Date.now() + 300000 });
      return '';
    }).finally(() => this.pending.delete(ip));
    this.pending.set(ip, task);
    return task;
  }
}
