'use strict';
const $ = (id) => document.getElementById(id);
const base = location.pathname.replace(/\/+$/, '');
let identity = null, expires = 0, client = null, keyboard = null, noticeTimer;
let pointerCleanup = [];
const show = (id, visible = true) => { $(id).hidden = !visible; };
function notice(message) { $('notice').textContent = message; show('notice'); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => show('notice', false), 6500); }
async function api(path, data) {
  const response = await fetch(`${base}/api/${path}`, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
  if (response.status === 401 && path !== 'verify') signedOut();
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '连接失败，请稍后再试');
  return value;
}
function signedOut() {
  expires = 0; disconnectDesktop(); window.UmekoWorkspace?.reset();
  show('loading', false); show('workspace', false); show('login');
  $('desktop-login').close(); $('clipboard-dialog').close();
}
function elapsed(seconds) {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${days ? `${days} 天 ` : ''}${hours} 小时 ${minutes} 分钟`;
}
async function refresh() {
  try {
    const value = await api('status');
    expires = value.expires;
    show('loading', false); show('login', false); show('workspace');
    const { device } = value;
    $('device-name').textContent = device.name;
    $('device-host').textContent = device.online ? `${device.status?.hostname || '已建立安全连接'} · ${device.status?.platform || '正在获取系统信息'}` : '连接器离线';
    $('online-badge').textContent = device.online ? '● 在线' : '○ 离线';
    $('online-badge').classList.toggle('online', device.online);
    $('uptime').textContent = device.status ? elapsed(device.status.uptime) : '—';
    $('ssh-state').textContent = device.online ? (device.status?.ssh ? '可连接' : '等待服务') : '—';
    $('rdp-state').textContent = device.online ? (device.status?.rdp ? '可连接' : '等待服务') : '—';
    $('last-seen').textContent = device.online ? '刚刚' : device.lastSeen ? new Date(device.lastSeen).toLocaleString('zh-CN', { hour12: false }) : '尚未连接';
    $('offline-note').textContent = device.online ? '仅在本机连接器运行时允许远程访问。关闭连接器将断开桌面与 SSH 隧道。' : '离线可能是电脑关机、断网或连接器未启动。请提前在本机启动 Umeko 远程连接器。';
    $('connect-desktop').disabled = !device.online || !device.status?.rdp;
    UmekoWorkspace.setAvailable(value.webTools && device.online && device.status?.ssh);
    $('session-time').textContent = `登录有效至 ${new Date(expires).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    if (!expires) signedOut();
    else { $('online-badge').textContent = '状态暂不可用'; $('online-badge').classList.remove('online'); $('connect-desktop').disabled = true; UmekoWorkspace.setAvailable(false); }
  }
}
$('identity').addEventListener('change', async (event) => {
  identity = null; $('login-button').disabled = true;
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 8192) throw new Error('密钥文件过大');
    const value = JSON.parse(await file.text());
    if (value.version !== 1 || typeof value.keyId !== 'string' || typeof value.privateKey !== 'string') throw new Error('请选择有效的 .umeko-key 密钥文件');
    const bytes = Uint8Array.from(atob(value.privateKey), (character) => character.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', bytes, { name: 'Ed25519' }, false, ['sign']);
    bytes.fill(0);
    identity = { keyId: value.keyId, key };
    $('file-name').textContent = file.name;
    $('login-button').textContent = '安全登录 ↗'; $('login-button').disabled = false;
  } catch (error) { notice(error.message || '无法读取密钥，请使用新版浏览器'); }
  event.target.value = '';
});
$('login-button').addEventListener('click', async () => {
  if (!identity) return;
  $('login-button').disabled = true; $('login-button').textContent = '正在验证签名…';
  try {
    const { id, challenge } = await api('challenge', { role: 'admin', keyId: identity.keyId });
    const bytes = new Uint8Array(await crypto.subtle.sign('Ed25519', identity.key, new TextEncoder().encode(challenge)));
    const signature = btoa(String.fromCharCode(...bytes));
    await api('verify', { id, signature });
    identity = null; $('file-name').textContent = '选择 .umeko-key 密钥文件';
    await refresh();
  } catch (error) { notice(error.message); }
  finally { $('login-button').disabled = !identity; $('login-button').textContent = identity ? '重新验证密钥 ↗' : '选择密钥后安全登录'; }
});
$('logout').addEventListener('click', async () => { try { await api('logout', {}); signedOut(); } catch (error) { notice(error.message); } });
$('show-ssh').addEventListener('click', () => { show('ssh-panel'); $('ssh-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
$('close-ssh').addEventListener('click', () => show('ssh-panel', false));
$('ssh-command').textContent = `node umeko-remote.mjs --identity ./admin.umeko-key --url ${location.origin}${base}`;
$('copy-command').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('ssh-command').textContent); notice('连接命令已复制'); } catch { notice('请手动选中并复制命令'); } });
$('connect-desktop').addEventListener('click', () => $('desktop-login').showModal());
$('cancel-desktop').addEventListener('click', () => { $('desktop-password').value = ''; $('desktop-login').close(); });
$('desktop-login').addEventListener('close', () => { $('desktop-password').value = ''; });

// A Guacamole tunnel with a first-frame ticket, keeping credentials out of URLs.
function createTunnel(ticket) {
  const tunnel = new Guacamole.Tunnel();
  let socket, pingTimer, lastReceived = Date.now(), intentional = false;
  tunnel.connect = () => {
    tunnel.setState(Guacamole.Tunnel.State.CONNECTING);
    const parser = new Guacamole.Parser();
    parser.oninstruction = (opcode, args) => {
      if (tunnel.state === Guacamole.Tunnel.State.CONNECTING) {
        if (opcode === '' && args.length === 1) tunnel.setUUID(args[0]);
        tunnel.setState(Guacamole.Tunnel.State.OPEN);
      }
      if (opcode !== '' && tunnel.oninstruction) tunnel.oninstruction(opcode, args);
    };
    socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${base}/ws/desktop`);
    socket.onopen = () => {
      socket.send(JSON.stringify({ ticket }));
      pingTimer = setInterval(() => {
        if (Date.now() - lastReceived > 45000) { socket.close(); return; }
        if (tunnel.state === Guacamole.Tunnel.State.OPEN) tunnel.sendMessage('', 'ping', Date.now());
      }, 10000);
    };
    socket.onmessage = (event) => { lastReceived = Date.now(); try { parser.receive(event.data); } catch { socket.close(); } };
    socket.onclose = () => {
      clearInterval(pingTimer); tunnel.setState(Guacamole.Tunnel.State.CLOSED);
      if (!intentional && tunnel.onerror) tunnel.onerror(new Guacamole.Status(Guacamole.Status.Code.UPSTREAM_UNAVAILABLE, '桌面连接已关闭，请检查本机连接器或重新连接'));
    };
    socket.onerror = () => socket.close();
  };
  tunnel.sendMessage = (...args) => { if (socket?.readyState === WebSocket.OPEN) socket.send(Guacamole.Parser.toInstruction(args)); };
  tunnel.disconnect = () => { intentional = true; clearInterval(pingTimer); socket?.close(); tunnel.setState(Guacamole.Tunnel.State.CLOSED); };
  return tunnel;
}
function disconnectDesktop() {
  for (const dispose of pointerCleanup) dispose();
  pointerCleanup = [];
  keyboard?.reset(); keyboard = null;
  client?.disconnect(); client = null;
  $('display').replaceChildren();
  show('desktop-view', false);
  document.body.classList.remove('remote-open');
  $('workspace').inert = false;
  $('mobile-input').classList.remove('open'); show('send-mobile', false);
  if (document.fullscreenElement === $('desktop-view')) document.exitFullscreen().catch(() => {});
}
function scaleDesktop() {
  if (!client) return;
  const display = client.getDisplay(), region = $('display');
  if (!display.getWidth() || !display.getHeight()) return;
  $('desktop-state').textContent = '安全连接已建立';
  display.scale(Math.min(region.clientWidth / display.getWidth(), region.clientHeight / display.getHeight()));
}
$('desktop-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type=submit], button.primary'); button.disabled = true;
  try {
    const credentials = { username: $('desktop-user').value, password: $('desktop-password').value,
      width: Math.max(1024, Math.min(1920, innerWidth)), height: Math.max(768, Math.min(1080, innerHeight - 65)) };
    $('desktop-password').value = '';
    const { ticket } = await api('desktop-ticket', credentials);
    credentials.password = '';
    $('desktop-login').close(); disconnectDesktop(); show('desktop-view');
    document.body.classList.add('remote-open'); $('workspace').inert = true;
    $('desktop-state').textContent = '正在连接…';
    const tunnel = createTunnel(ticket);
    client = new Guacamole.Client(tunnel);
    $('display').appendChild(client.getDisplay().getElement());
    client.getDisplay().onresize = scaleDesktop;
    client.onerror = (status) => { $('desktop-state').textContent = status.message || '连接发生错误'; notice(status.message || '桌面连接失败'); };
    tunnel.onerror = (status) => { $('desktop-state').textContent = status.message; };
    client.onstatechange = (state) => {
      if (state === 3) { $('desktop-state').textContent = '正在连接本机桌面…'; scaleDesktop(); $('display').focus(); }
      else if (state === 5) $('desktop-state').textContent = '连接已断开';
    };
    client.onrequired = (parameters) => {
      // FreeRDP may ask for explicitly empty credentials before showing the
      // xrdp system login screen. Do not leave the connection waiting silently.
      $('desktop-state').textContent = '正在打开系统登录界面…';
      for (const name of parameters) {
        if (!['username', 'password', 'domain'].includes(name)) { notice('桌面网关请求了不支持的连接参数'); continue; }
        const writer = new Guacamole.StringWriter(client.createArgumentValueStream('text/plain', name));
        writer.sendText(''); writer.sendEnd();
      }
    };
    keyboard = new Guacamole.Keyboard($('display'));
    keyboard.onkeydown = (keysym) => { client?.sendKeyEvent(1, keysym); return false; };
    keyboard.onkeyup = (keysym) => { client?.sendKeyEvent(0, keysym); };
    const mouse = new Guacamole.Mouse(client.getDisplay().getElement());
    const touch = new Guacamole.Mouse.Touchscreen(client.getDisplay().getElement());
    pointerCleanup = [mouse, touch].map((source) => UmekoRemoteInput.bindPointer(source, client, () => $('display').focus()));
    client.onclipboard = (stream, type) => {
      if (type !== 'text/plain') { stream.sendAck('Only text is supported', 256); return; }
      const reader = new Guacamole.StringReader(stream); let content = '';
      reader.ontext = (text) => { if (content.length + text.length <= 32768) content += text; };
      reader.onend = () => { $('clipboard-text').value = content; };
    };
    client.connect();
  } catch (error) { notice(error.message); }
  finally { button.disabled = false; }
});
$('desktop-disconnect').addEventListener('click', disconnectDesktop);
$('desktop-fullscreen').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else $('desktop-view').requestFullscreen().catch(() => notice('浏览器不支持全屏')); });
$('desktop-ctrl-alt-del').addEventListener('click', () => { for (const code of [0xffe3, 0xffe9, 0xffff]) client?.sendKeyEvent(1, code); for (const code of [0xffff, 0xffe9, 0xffe3]) client?.sendKeyEvent(0, code); });
$('display').addEventListener('blur', () => keyboard?.reset());
window.addEventListener('blur', () => keyboard?.reset());
window.addEventListener('resize', scaleDesktop);
document.addEventListener('fullscreenchange', scaleDesktop);
$('desktop-ime').addEventListener('click', () => {
  keyboard?.reset();
  for (const code of [0xffe3, 0x20]) client?.sendKeyEvent(1, code);
  for (const code of [0x20, 0xffe3]) client?.sendKeyEvent(0, code);
  $('display').focus();
});
$('desktop-keyboard').addEventListener('click', () => { const open = $('mobile-input').classList.toggle('open'); show('send-mobile', open); if (open) $('mobile-input').focus(); scaleDesktop(); });
$('send-mobile').addEventListener('click', () => {
  if (!client) return;
  for (const character of $('mobile-input').value) {
    const point = character.codePointAt(0), keysym = point === 10 ? 0xff0d : point <= 255 ? point : 0x01000000 | point;
    client.sendKeyEvent(1, keysym); client.sendKeyEvent(0, keysym);
  }
  $('mobile-input').value = '';
});
$('desktop-clipboard').addEventListener('click', () => $('clipboard-dialog').showModal());
$('close-clipboard').addEventListener('click', () => $('clipboard-dialog').close());
$('clipboard-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (client) { const writer = new Guacamole.StringWriter(client.createClipboardStream('text/plain')); writer.sendText($('clipboard-text').value); writer.sendEnd(); }
  $('clipboard-dialog').close(); $('display').focus();
});
window.addEventListener('pagehide', () => { identity = null; client?.disconnect(); });
refresh();
setInterval(() => { if (expires && Date.now() >= expires) { signedOut(); notice('登录已到期，请重新使用密钥登录'); } else if (expires) refresh(); }, 10000);
