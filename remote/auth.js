import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const keyId = (publicKey) => digest(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).slice(0, 24);

export function verifySignature(publicKey, challenge, signature) {
  try {
    const bytes = Buffer.from(signature, 'base64');
    return bytes.length === 64 && verify(null, Buffer.from(challenge), publicKey, bytes);
  } catch { return false; }
}

export async function loadIdentity(path) {
  const identity = JSON.parse(await readFile(path, 'utf8'));
  if (identity.version !== 1 || !identity.keyId || !identity.privateKey) throw new Error('无效的 Umeko 密钥文件');
  const privateKey = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64'), type: 'pkcs8', format: 'der' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('需要 Ed25519 密钥');
  return { keyId: identity.keyId, privateKey };
}

export async function loginWithKey(base, identity, role = 'admin') {
  const call = async (path, data) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(base).origin },
      body: JSON.stringify(data), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`密钥验证失败 (${response.status})`);
    return response;
  };
  const { challenge, id } = await (await call('/api/challenge', { keyId: identity.keyId, role })).json();
  const signature = sign(null, Buffer.from(challenge), identity.privateKey).toString('base64');
  const response = await call('/api/verify', { id, signature });
  return { ...(await response.json()), cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
}
