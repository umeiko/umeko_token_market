import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { keyId } from './auth.js';

const directory = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('用法：node remote/keys.js <仓库外的私密目录>');
await mkdir(directory, { recursive: true, mode: 0o700 });
const keys = {};
for (const role of ['admin', 'device']) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const id = keyId(pem);
  await writeFile(resolve(directory, `${role}.umeko-key`), JSON.stringify({
    version: 1, keyId: id, privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  keys[role] = { id, publicKey: pem };
}
await writeFile(resolve(directory, 'public-keys.json'), JSON.stringify(keys, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(`密钥已创建于 ${directory}。admin.umeko-key 用于异地登录，device.umeko-key 仅用于本机连接器。`);
