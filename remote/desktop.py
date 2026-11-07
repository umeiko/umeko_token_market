#!/usr/bin/env python3
"""Desktop control panel for the independent Umeko headless connector service."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import webbrowser
from service import ServiceController

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('config', nargs='?', default=str(Path.home() / '.config/umeko-remote/agent.json'))
parser.add_argument('--headless', action='store_true', help='启动后台服务，不创建窗口')
args = parser.parse_args()
CONFIG = Path(args.config).expanduser().resolve()
controller = ServiceController(CONFIG)

# The boot service runs Node directly and never imports Tkinter. A desktop
# launcher used without a display also falls back to starting that service.
if args.headless or not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
    controller.start()
    print('Umeko 后台连接服务已启动，无需显示器或桌面登录。')
    sys.exit(0)

import tkinter as tk
from tkinter import messagebox

CONFIG.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
lock = open(CONFIG.parent / 'desktop.lock', 'w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    window = tk.Tk()
    window.withdraw()
    messagebox.showinfo('Umeko 远程连接器', '连接器窗口已经打开；后台连接服务独立运行。')
    sys.exit(0)

window = tk.Tk()
window.title('Umeko · 远程连接器')
window.geometry('580x585')
window.minsize(550, 550)
window.configure(bg='#101215')
events = queue.Queue()
state = tk.StringVar(value='准备连接')
detail = tk.StringVar(value='后台服务独立运行，无需显示器。')
autostart_text = tk.StringVar(value='正在检查开机自启动…')
autostart_button_text = tk.StringVar(value='开启开机自启动')
footnote = tk.StringVar(value='出差期间请保持电脑开机、联网且不休眠。')
busy, closing, last_event = False, False, None
enabled = controller.enabled()


def operation(action):
    global busy
    if busy:
        return
    busy = True
    for button in controls:
        button.configure(state='disabled')

    def worker():
        try:
            action()
            events.put(('result', controller.status()))
        except Exception as error:
            events.put(('error', str(error)))
    threading.Thread(target=worker, daemon=True).start()


def toggle_autostart():
    desired = not enabled

    def apply():
        controller.set_autostart(desired)
        if desired:
            controller.start()
    operation(apply)


def close():
    global closing
    if closing:
        return
    if busy:
        window.after(200, close)
        return
    closing = True

    def shutdown():
        try:
            if not controller.enabled():
                controller.stop()
            events.put(('close', None))
        except Exception as error:
            events.put(('close_error', str(error)))
    threading.Thread(target=shutdown, daemon=True).start()


def open_site():
    try:
        webbrowser.open(json.loads(CONFIG.read_text())['url'].rstrip('/') + '/')
    except (OSError, ValueError, KeyError):
        webbrowser.open('https://umekolab.cn/remote/')


def append_log(message):
    output.configure(state='normal')
    output.insert('end', message + '\n')
    if int(output.index('end-1c').split('.')[0]) > 100:
        output.delete('1.0', '2.0')
    output.see('end')
    output.configure(state='disabled')


def render(status):
    global enabled, last_event
    enabled = status['enabled']
    names = {'online': '已连接 · 可远程访问', 'connecting': '正在连接', 'offline': '等待自动重连', 'stopped': '已断开'}
    state.set(names.get(status.get('state'), '后台服务运行中'))
    detail.set(status.get('message', ''))
    autostart_text.set('开机自启动：已开启 · 无需显示器或登录' if enabled else '开机自启动：未开启')
    autostart_button_text.set('关闭开机自启动' if enabled else '开启开机自启动')
    footnote.set(('关闭窗口后，后台继续连接。点击“断开”可停止本次连接。' if enabled else '未开启自启动：关闭窗口将断开本次连接。') + '\n出差期间请保持电脑开机、联网且不休眠。')
    event = (status.get('pid'), status.get('time'), status.get('state'), status.get('message'))
    if event != last_event:
        last_event = event
        append_log(status.get('message', ''))


def poll_service():
    while not stop_poll.is_set():
        try:
            events.put(('status', controller.status()))
        except Exception as error:
            events.put(('poll_error', str(error)))
        if stop_poll.wait(1):
            break


def update():
    global busy, closing
    while True:
        try:
            kind, value = events.get_nowait()
        except queue.Empty:
            break
        if kind == 'close':
            stop_poll.set()
            window.destroy()
            return
        if kind == 'close_error':
            closing = False
            messagebox.showerror('未能关闭后台连接', value)
        elif kind in ('status', 'result'):
            render(value)
        elif kind == 'error':
            messagebox.showerror('连接器设置失败', value)
        elif kind == 'poll_error':
            detail.set('暂时无法读取后台服务状态')
        if kind in ('result', 'error'):
            busy = False
            for button in controls:
                button.configure(state='normal')
    window.after(200, update)


frame = tk.Frame(window, bg='#101215', padx=30, pady=25)
frame.pack(fill='both', expand=True)
tk.Label(frame, text='UMEKO  /  REMOTE CONNECTOR', fg='#e7a66d', bg='#101215', font=('Sans', 10, 'bold')).pack(anchor='w')
tk.Label(frame, text='把这台电脑，带在身边。', fg='#f1f0ec', bg='#101215', font=('Sans', 22), pady=18).pack(anchor='w')
tk.Label(frame, textvariable=state, fg='#9ad4b1', bg='#101215', font=('Sans', 14, 'bold')).pack(anchor='w')
tk.Label(frame, textvariable=detail, fg='#a3a8ae', bg='#101215', font=('Sans', 10), pady=8, wraplength=510, justify='left').pack(anchor='w')
buttons = tk.Frame(frame, bg='#101215', pady=12)
buttons.pack(fill='x')
controls = []
for label, command, bg, fg in [('连接', lambda: operation(controller.start), '#e7a66d', '#231a13'), ('断开', lambda: operation(controller.stop), '#30343a', '#f1f0ec'), ('打开工作台 ↗', open_site, '#30343a', '#f1f0ec')]:
    button = tk.Button(buttons, text=label, command=command, bg=bg, fg=fg, activebackground=bg, activeforeground=fg, relief='flat', padx=17, pady=9)
    button.pack(side='left', padx=(0, 10))
    controls.append(button)
startup = tk.Frame(frame, bg='#191e22', padx=13, pady=10)
startup.pack(fill='x', pady=(0, 14))
tk.Label(startup, textvariable=autostart_text, bg='#191e22', fg='#b2b9bf', font=('Sans', 9)).pack(anchor='w')
button = tk.Button(startup, textvariable=autostart_button_text, command=toggle_autostart, bg='#30343a', fg='#e7a66d', activebackground='#383d44', activeforeground='#e7a66d', relief='flat', padx=13, pady=8)
button.pack(anchor='w', pady=(8, 0))
controls.append(button)
output = tk.Text(frame, height=4, bg='#181c20', fg='#94999f', font=('Monospace', 9), relief='flat', padx=12, pady=10, state='disabled', wrap='word')
output.pack(fill='both', expand=True)
tk.Label(frame, textvariable=footnote, fg='#838a91', bg='#101215', font=('Sans', 9), wraplength=510, justify='left', pady=12).pack(anchor='w')
stop_poll = threading.Event()
window.protocol('WM_DELETE_WINDOW', close)
signal.signal(signal.SIGTERM, lambda *_: window.after(0, close))
signal.signal(signal.SIGINT, lambda *_: window.after(0, close))
threading.Thread(target=poll_service, daemon=True).start()
window.after(200, update)
window.after(500, lambda: operation(controller.start))
window.mainloop()
