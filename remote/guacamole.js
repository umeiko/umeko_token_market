import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export function instruction(...parts) {
  return parts.map((part) => { const value = String(part); return `${[...value].length}.${value}`; }).join(',') + ';';
}

// Handshake only; afterwards guacd's protocol stream passes through untouched.
export class GuacParser {
  constructor(onInstruction) { this.buffer = ''; this.onInstruction = onInstruction; }
  receive(text) {
    this.buffer += text;
    if (this.buffer.length > 262144) throw new Error('Guacamole handshake too large');
    while (this.buffer.length) {
      let offset = 0;
      const values = [];
      while (true) {
        const dot = this.buffer.indexOf('.', offset);
        if (dot < 0) return;
        const length = this.buffer.slice(offset, dot);
        if (!/^\d{1,6}$/.test(length)) throw new Error('Invalid Guacamole length');
        let end = dot + 1;
        for (let n = 0; n < Number(length); n++) {
          if (end >= this.buffer.length) return;
          end += this.buffer.codePointAt(end) > 0xffff ? 2 : 1;
        }
        if (end >= this.buffer.length) return;
        values.push(this.buffer.slice(dot + 1, end));
        const separator = this.buffer[end];
        if (separator !== ',' && separator !== ';') throw new Error('Invalid Guacamole separator');
        offset = end + 1;
        if (separator === ';') break;
      }
      this.buffer = this.buffer.slice(offset);
      this.onInstruction(values);
    }
  }
}

export async function openDesktop({ guacdPort, rdpPort, username, password, width, height, onData, onSocket }) {
  const socket = net.connect({ host: '127.0.0.1', port: guacdPort });
  onSocket?.(socket);
  const decoder = new StringDecoder('utf8');
  let ready = false;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('桌面网关连接超时')); }, 20000);
    const parser = new GuacParser(([opcode, ...args]) => {
      if (opcode === 'args') {
        const parameters = {
          hostname: '127.0.0.1', port: String(rdpPort), username, password,
          security: 'tls', 'ignore-cert': 'true', 'disable-auth': 'true',
          'enable-wallpaper': 'false', 'enable-theming': 'false', 'enable-font-smoothing': 'true',
          'resize-method': 'display-update', 'disable-audio': 'true',
          'enable-drive': 'false', 'enable-printing': 'false', 'disable-upload': 'true', 'disable-download': 'true',
          'server-layout': 'en-us-qwerty', 'color-depth': '32', 'timezone': 'America/New_York',
        };
        socket.write(instruction('size', width, height, 96));
        socket.write(instruction('audio'));
        socket.write(instruction('video'));
        socket.write(instruction('image', 'image/png', 'image/jpeg'));
        socket.write(instruction('connect', ...args.map((name) => name.startsWith('VERSION_') ? 'VERSION_1_5_0' : parameters[name] || '')));
      } else if (opcode === 'ready') {
        ready = true;
        clearTimeout(timeout);
        // The WebSocket tunnel expects an internal UUID instruction first.
        onData(instruction('', args[0]));
        if (parser.buffer) { const rest = parser.buffer; parser.buffer = ''; onData(rest); }
        resolve(socket);
      } else if (opcode === 'error') {
        socket.destroy();
        reject(new Error('远程桌面连接失败，请确认本机桌面服务和登录信息'));
      }
    });
    socket.on('connect', () => socket.write(instruction('select', 'rdp')));
    socket.on('data', (chunk) => {
      const text = decoder.write(chunk);
      try { if (ready) onData(text); else parser.receive(text); }
      catch { socket.destroy(); reject(new Error('桌面网关协议错误')); }
    });
    socket.on('error', () => { clearTimeout(timeout); reject(new Error('桌面网关不可用')); });
    socket.on('close', () => { clearTimeout(timeout); if (!ready) reject(new Error('桌面网关连接已关闭')); });
  });
}
