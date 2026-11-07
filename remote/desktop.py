#!/usr/bin/env python3
"""Desktop frontend for the outbound-only Umeko connector (Python 3 / Tk)."""
import fcntl
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import messagebox
import webbrowser

ROOT = Path(__file__).resolve().parent
CONFIG = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / '.config/umeko-remote/agent.json'
CONFIG.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
lock = open(CONFIG.parent / 'desktop.lock', 'w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    window = tk.Tk()
    window.withdraw()
    messagebox.showinfo('Umeko 远程连接器', '连接器已经运行，请使用已打开的窗口。')
    sys.exit(0)

window = tk.Tk()
window.title('Umeko · 远程连接器')
window.geometry('560x475')
window.minsize(490, 450)
window.configure(bg='#101215')
process = None
events = queue.Queue()
state = tk.StringVar(value='准备连接')
detail = tk.StringVar(value='启动后，通过网站即可远程使用这台电脑。')


def launch():
    global process
    if process and process.poll() is None:
        return
    if not CONFIG.is_file():
        messagebox.showerror('缺少连接配置', f'请先配置本机密钥和连接地址：\n{CONFIG}')
        return
    executable = shutil.which('node')
    if not executable:
        messagebox.showerror('缺少运行环境', '请安装 Node.js 22 或更新版本。')
        return
    process = subprocess.Popen([executable, str(ROOT / 'agent.js'), str(CONFIG)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    current = process

    def reader():
        for line in current.stdout:
            events.put((current, line.strip()))
        events.put((current, json.dumps({'state': 'stopped', 'message': '连接器已停止'})))
    threading.Thread(target=reader, daemon=True).start()


def stop():
    if process and process.poll() is None:
        process.terminate()
    state.set('已断开')
    detail.set('远程访问已关闭，可以再次点击连接。')


def close():
    stop()
    if process:
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
    window.destroy()


def open_site():
    try:
        config = json.loads(CONFIG.read_text())
        webbrowser.open(config['url'].rstrip('/') + '/')
    except (OSError, ValueError, KeyError):
        webbrowser.open('https://umekolab.cn/remote/')


def update():
    while True:
        try:
            source, raw = events.get_nowait()
        except queue.Empty:
            break
        if source is not process:
            continue
        try:
            event = json.loads(raw)
            names = {'online': '已连接 · 可远程访问', 'connecting': '正在连接', 'offline': '等待自动重连', 'stopped': '已断开'}
            state.set(names.get(event.get('state'), '连接器运行中'))
            detail.set(event.get('message', ''))
            raw = event.get('message', raw)
        except ValueError:
            pass
        output.configure(state='normal')
        output.insert('end', raw + '\n')
        if int(output.index('end-1c').split('.')[0]) > 100:
            output.delete('1.0', '2.0')
        output.see('end')
        output.configure(state='disabled')
    window.after(200, update)


frame = tk.Frame(window, bg='#101215', padx=30, pady=25)
frame.pack(fill='both', expand=True)
tk.Label(frame, text='UMEKO  /  REMOTE CONNECTOR', fg='#e7a66d', bg='#101215', font=('Sans', 10, 'bold')).pack(anchor='w')
tk.Label(frame, text='把这台电脑，带在身边。', fg='#f1f0ec', bg='#101215', font=('Sans', 22), pady=18).pack(anchor='w')
tk.Label(frame, textvariable=state, fg='#9ad4b1', bg='#101215', font=('Sans', 14, 'bold')).pack(anchor='w')
tk.Label(frame, textvariable=detail, fg='#a3a8ae', bg='#101215', font=('Sans', 10), pady=8, wraplength=490, justify='left').pack(anchor='w')
buttons = tk.Frame(frame, bg='#101215', pady=15)
buttons.pack(fill='x')
for label, command, bg, fg in [('连接', launch, '#e7a66d', '#231a13'), ('断开', stop, '#30343a', '#f1f0ec'), ('打开工作台 ↗', open_site, '#30343a', '#f1f0ec')]:
    tk.Button(buttons, text=label, command=command, bg=bg, fg=fg, activebackground=bg, activeforeground=fg, relief='flat', padx=17, pady=9).pack(side='left', padx=(0, 10))
output = tk.Text(frame, height=5, bg='#181c20', fg='#94999f', font=('Monospace', 9), relief='flat', padx=12, pady=10, state='disabled', wrap='word')
output.pack(fill='both', expand=True)
tk.Label(frame, text='关闭窗口将停止远程连接。出差期间请保持电脑开机、联网且不休眠。\n请提前将 admin.umeko-key 安全备份到出差设备。', fg='#838a91', bg='#101215', font=('Sans', 9), wraplength=490, justify='left', pady=12).pack(anchor='w')
window.protocol('WM_DELETE_WINDOW', close)
signal.signal(signal.SIGTERM, lambda *_: window.after(0, close))
signal.signal(signal.SIGINT, lambda *_: window.after(0, close))
window.after(200, update)
window.after(500, launch)
window.mainloop()
