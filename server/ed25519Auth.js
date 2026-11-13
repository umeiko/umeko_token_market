import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const authorizedKey = process.env.ADMIN_ED25519_PUBLIC_KEY_FILE
  ? createPublicKey(readFileSync(process.env.ADMIN_ED25519_PUBLIC_KEY_FILE, 'utf8'))
  : process.env.ADMIN_ED25519_PUBLIC_KEY
    ? createPublicKey(process.env.ADMIN_ED25519_PUBLIC_KEY)
    : null;

export function createEd25519Challenge() {
  if (!authorizedKey) throw Object.assign(new Error('Ed25519 管理员登录未启用'), { statusCode: 404 });
  return { id: randomBytes(18).toString('base64url'), challenge: randomBytes(32).toString('base64url') };
}

export function verifyEd25519Signature({ challenge, signature }) {
  if (!authorizedKey) return false;
  return verify(null, Buffer.from(challenge), authorizedKey, Buffer.from(String(signature || ''), 'base64'));
}
