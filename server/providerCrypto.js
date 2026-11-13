import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

function secret() {
  if (process.env.PROVIDER_ENCRYPTION_KEY) return createHash('sha256').update(process.env.PROVIDER_ENCRYPTION_KEY).digest();
  const directory = dirname(resolve(process.env.DATA_PATH || 'data/market.db'));
  mkdirSync(directory, { recursive: true });
  const path = `${directory}/provider.secret`;
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return createHash('sha256').update(readFileSync(path, 'utf8').trim()).digest();
}

const key = secret();

export function encryptProviderKey(value) {
  if (!value) return { api_key_ciphertext: '', api_key_iv: '', api_key_tag: '', api_key_prefix: '' };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    api_key_ciphertext: ciphertext.toString('base64'),
    api_key_iv: iv.toString('base64'),
    api_key_tag: cipher.getAuthTag().toString('base64'),
    api_key_prefix: `${value.slice(0, Math.min(10, value.length))}••••`,
  };
}

export function decryptProviderKey(row) {
  if (!row.api_key_ciphertext) return '';
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.api_key_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.api_key_tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.api_key_ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
