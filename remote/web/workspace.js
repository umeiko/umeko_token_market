'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const base = location.pathname.replace(/\/+$/, '');
  let directory = '', parent = '', entries = [], requestId = 0, filesAbort, uploading = false, uploadCancelled = false, xhr;
  let terminal, fit, socket, observer, loading = false, available = false;
  function fileActions() {
    $('files-upload').disabled = uploading || loading || !directory || !available;
    $('files-mkdir').disabled = loading || !directory || !available;
  }
  const show = (id, yes = true) => { $(id).hidden = !yes; };
  const message = (text) => { $('files-status').textContent = text; };
  async function api(path, body, signal) {
    const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '连接失败');
    return value;
  }
  function overlay(id, yes) {
    show(id, yes);
    const files = !$('files-view').hidden, term = !$('terminal-view').hidden;
    $('workspace').inert = files || term || !$('desktop-view').hidden;
    $('desktop-view').inert = files || term;
    document.body.classList.toggle('tools-open', files || term);
    if (!files && !term && !$('desktop-view').hidden) $('display').focus();
  }
  function size(bytes) { if (bytes < 1024) return `${bytes} B`; for (const [unit, factor] of [['GiB', 1024 ** 3], ['MiB', 1024 ** 2], ['KiB', 1024]]) if (bytes >= factor) return `${(bytes / factor).toFixed(1)} ${unit}`; }
  function filePath(name) { return `${directory === '/' ? '' : directory}/${name}`; }
  function render() {
    const list = document.createDocumentFragment();
    const visible = entries.filter((e) => $('files-hidden').checked || !e.name.startsWith('.'));
    for (const entry of visible) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const button = document.createElement('button'); button.className = 'file-name text-button'; button.textContent = `${entry.directory ? '▸ ' : entry.symlink ? '↗ ' : '· '}${entry.name}`;
      button.title = entry.name;
      if (entry.directory || entry.symlink) button.addEventListener('click', () => load(filePath(entry.name)));
      else button.addEventListener('click', () => download(filePath(entry.name)));
      name.append(button); row.append(name);
      for (const value of [entry.directory ? '文件夹' : size(entry.size), new Date(entry.modified).toLocaleString('zh-CN', { hour12: false })]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      const action = document.createElement('td');
      const link = document.createElement('button'); link.className = 'text-button'; link.textContent = entry.directory ? '打开' : '下载';
      link.addEventListener('click', () => entry.directory ? load(filePath(entry.name)) : download(filePath(entry.name)));
      action.append(link); row.append(action); list.append(row);
    }
    $('file-entries').replaceChildren(list);
    message(`${visible.length} 项${visible.length < entries.length ? `（另有 ${entries.length - visible.length} 个隐藏项）` : ''}${visible.length ? '' : ' · 当前目录为空'}`);
  }
  async function load(path = '') {
    const id = ++requestId; filesAbort?.abort(); filesAbort = new AbortController();
    loading = true; fileActions(); $('file-entries').replaceChildren(); message('正在读取目录…');
    try {
      const result = await api(`files${path ? `?path=${encodeURIComponent(path)}` : ''}`, undefined, filesAbort.signal);
      if (id !== requestId) return;
      directory = result.path; parent = result.parent; entries = result.entries;
      $('files-path').value = directory; $('files-user').textContent = `${result.username} · SFTP 安全连接`;
      $('files-parent').disabled = directory === '/'; render();
      if (result.truncated) message('此目录超过 10,000 项，仅显示前 10,000 项。');
    } catch (err) {
      if (id === requestId && err.name !== 'AbortError') { $('files-path').value = directory; render(); message(err.message); }
    } finally { if (id === requestId) { loading = false; fileActions(); } }
  }
  function openFiles() { overlay('files-view', true); $('files-path').focus(); load(directory); }
  function download(path) {
    const link = document.createElement('a'); link.href = `${base}/api/files/download?path=${encodeURIComponent(path)}`; link.download = path.split('/').pop(); document.body.append(link); link.click(); link.remove();
  }
  function upload(file, target) {
    return new Promise((resolve, reject) => {
      const request = xhr = new XMLHttpRequest();
      request.open('POST', `${base}/api/files/upload?directory=${encodeURIComponent(target)}&name=${encodeURIComponent(file.name)}`);
      request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.upload.onprogress = (event) => {
        const percent = event.lengthComputable ? Math.round(event.loaded / event.total * 100) : 0;
        $('upload-progress').value = percent; $('upload-status').textContent = `${file.name} · ${percent}%${percent === 100 ? ' · 正在写入电脑…' : ''}`;
      };
      request.onload = () => { let result; try { result = JSON.parse(request.responseText); } catch { result = {}; }
        if (request.status >= 200 && request.status < 300) resolve(); else reject(new Error(result.error || `上传失败（${request.status}）`)); };
      request.onerror = () => reject(new Error('上传中断，请检查网络'));
      request.onabort = () => reject(new Error('上传已取消'));
      request.send(file);
    });
  }
  $('open-files').addEventListener('click', openFiles); $('desktop-files').addEventListener('click', openFiles);
  $('close-files').addEventListener('click', () => overlay('files-view', false));
  $('files-home').addEventListener('click', () => load()); $('files-parent').addEventListener('click', () => load(parent));
  $('files-refresh').addEventListener('click', () => load(directory)); $('files-hidden').addEventListener('change', () => { if (!loading) render(); });
  $('files-path-form').addEventListener('submit', (event) => { event.preventDefault(); load($('files-path').value); });
  $('files-mkdir').addEventListener('click', () => { $('folder-name').value = ''; $('folder-dialog').showModal(); });
  $('folder-cancel').addEventListener('click', () => $('folder-dialog').close());
  $('folder-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.target.querySelector('.primary'); button.disabled = true;
    try { await api('files/mkdir', { directory, name: $('folder-name').value }); $('folder-dialog').close(); await load(directory); }
    catch (err) { message(err.message); $('folder-dialog').close(); } finally { button.disabled = false; }
  });
  $('files-upload').addEventListener('change', async (event) => {
    const files = [...event.target.files]; event.target.value = ''; if (!files.length || uploading || loading || !directory || !available) return;
    const target = directory; uploading = true; uploadCancelled = false; fileActions(); show('files-transfer');
    const results = [];
    for (const file of files) {
      if (uploadCancelled) break;
      try { if (file.size > 2 * 1024 ** 3) throw new Error('单个文件最大支持 2 GiB'); await upload(file, target); results.push(`${file.name}：已上传`); }
      catch (err) { results.push(`${file.name}：${err.message}`); }
    }
    uploading = false; xhr = null; fileActions(); show('files-transfer', false);
    if (directory === target) await load(directory);
    message(results.join('；'));
  });
  $('upload-cancel').addEventListener('click', () => { uploadCancelled = true; xhr?.abort(); });

  function disconnectTerminal() {
    socket?.close(); socket = null; observer?.disconnect(); observer = null; terminal?.dispose(); terminal = null; fit = null; $('terminal').replaceChildren();
  }
  function send(data) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }
  async function connectTerminal() {
    disconnectTerminal(); overlay('terminal-view', true); $('terminal-status').textContent = '正在安全连接…';
    const term = terminal = new Terminal({ cursorBlink: true, fontSize: 15, fontFamily: '"Noto Sans Mono", "DejaVu Sans Mono", monospace', theme: { background: '#101215', foreground: '#f1f0ec', cursor: '#e7a66d' }, scrollback: 5000, disableStdin: true, allowProposedApi: false });
    fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('terminal')); fit.fit();
    const localFit = fit;
    observer = new ResizeObserver(() => { if (fit === localFit) { localFit.fit(); send({ type: 'resize', cols: term.cols, rows: term.rows }); } }); observer.observe($('terminal'));
    try {
      const { ticket } = await api('terminal-ticket', {}); if (terminal !== term) return;
      let failure = '';
      const ws = socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${base}/ws/terminal`); ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(JSON.stringify({ ticket, cols: term.cols, rows: term.rows }));
      term.onData((data) => { for (const chunk of data.match(/[\s\S]{1,4096}/gu) || []) send({ type: 'input', data: chunk }); });
      ws.onmessage = (event) => {
        if (terminal !== term) return;
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data); term.write(bytes, () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', bytes: bytes.length })); });
        } else { const result = JSON.parse(event.data); if (result.type === 'error') failure = result.message; $('terminal-status').textContent = result.type === 'ready' ? `${result.username} · 已连接本机 SSH` : result.message || '连接失败'; if (result.type === 'ready') { term.options.disableStdin = false; term.focus(); } }
      };
      ws.onclose = (event) => { if (terminal === term) { $('terminal-status').textContent = failure || (event.code === 1012 ? '本机 SSH 连接已结束；电脑上线后可重新连接' : 'SSH 已断开，可重新连接'); term.options.disableStdin = true; term.write('\r\n\x1b[90m[连接已结束]\x1b[0m\r\n'); } };
      ws.onerror = () => ws.close();
    } catch (err) { if (terminal === term) $('terminal-status').textContent = err.message; }
  }
  $('connect-terminal').addEventListener('click', connectTerminal); $('terminal-reconnect').addEventListener('click', connectTerminal);
  $('close-terminal').addEventListener('click', () => { disconnectTerminal(); overlay('terminal-view', false); });
  $('terminal-interrupt').addEventListener('click', () => { send({ type: 'input', data: '\x03' }); terminal?.focus(); });
  $('terminal-copy').addEventListener('click', async () => { try { const text = terminal?.getSelection(); if (text) await navigator.clipboard.writeText(text); else $('terminal-status').textContent = '请先在终端中选择需要复制的文字'; } catch { $('terminal-status').textContent = '请使用 Ctrl Shift C 复制'; } });
  $('terminal-paste').addEventListener('click', async () => { try { terminal?.paste(await navigator.clipboard.readText()); terminal?.focus(); } catch { $('terminal-status').textContent = '请使用 Ctrl Shift V 粘贴'; } });
  window.UmekoWorkspace = {
    setAvailable(yes) { available = !!yes; fileActions(); for (const id of ['open-files', 'desktop-files', 'connect-terminal']) $(id).disabled = !yes; },
    reset() { uploadCancelled = true; xhr?.abort(); filesAbort?.abort(); ++requestId; disconnectTerminal(); overlay('files-view', false); overlay('terminal-view', false); $('folder-dialog').close(); entries = []; directory = ''; $('file-entries').replaceChildren(); },
  };
  window.addEventListener('pagehide', () => { xhr?.abort(); filesAbort?.abort(); disconnectTerminal(); });
})();
