import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';

const SSHSIG = Buffer.from('SSHSIG');

function string(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length);
  return Buffer.concat([length, buffer]);
}

class Reader {
  constructor(buffer) { this.buffer = buffer; this.offset = 0; }
  uint32() {
    if (this.offset + 4 > this.buffer.length) throw new Error('SSH 签名数据不完整');
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  bytes() {
    const length = this.uint32();
    if (this.offset + length > this.buffer.length) throw new Error('SSH 签名数据不完整');
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

export function parsePublicKey(value) {
  const text = String(value || '').trim();
  if (text.length > 16384) throw new Error('公钥过长');
  const parsed = ssh2.utils.parseKey(text);
  if (parsed instanceof Error || !parsed) throw new Error('OpenSSH 公钥格式无效');
  const blob = parsed.getPublicSSH();
  return {
    parsed,
    publicKey: `${parsed.type} ${blob.toString('base64')}`,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
  };
}

export function verifySshSignature({ publicKey, challenge, signature }) {
  const authorized = parsePublicKey(publicKey);
  const reader = new Reader(Buffer.from(String(signature || ''), 'base64'));
  if (!reader.buffer.subarray(0, 6).equals(SSHSIG)) throw new Error('不是有效的 ssh-keygen 签名文件');
  reader.offset = 6;
  if (reader.uint32() !== 1) throw new Error('不支持的 SSH 签名版本');
  const signedKey = reader.bytes();
  const namespace = reader.bytes().toString();
  const reserved = reader.bytes();
  const hashAlgorithm = reader.bytes().toString();
  const wrapped = reader.bytes();
  if (!signedKey.equals(authorized.parsed.getPublicSSH())) throw new Error('签名使用的公钥不匹配');
  if (namespace !== 'umeko-admin') throw new Error('签名命名空间不匹配');
  if (!['sha256', 'sha512'].includes(hashAlgorithm)) throw new Error('不支持的签名哈希算法');
  const inner = new Reader(wrapped);
  inner.bytes();
  const rawSignature = inner.bytes();
  const message = Buffer.concat([SSHSIG, string(namespace), string(reserved), string(hashAlgorithm), string(challenge)]);
  return authorized.parsed.verify(message, rawSignature, authorized.parsed.type === 'ssh-ed25519' ? null : hashAlgorithm) === true;
}
