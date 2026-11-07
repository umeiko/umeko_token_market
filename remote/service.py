#!/usr/bin/env python3
"""Manage the headless connector with the user's systemd manager (no GUI imports)."""
import argparse
import getpass
import json
import os
from pathlib import Path
import shutil
import subprocess

UNIT = 'umeko-remote-agent.service'
ROOT = Path(__file__).resolve().parent


def systemd_quote(value):
    value = str(value)
    if '\n' in value or '\r' in value or '\0' in value:
        raise ValueError('路径中不能包含换行或空字符')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def service_text(node, agent, config):
    return f'''[Unit]
Description=Umeko headless remote connector
StartLimitIntervalSec=0

[Service]
Type=exec
ExecStart={systemd_quote(node)} {systemd_quote(agent)} {systemd_quote(config)}
Restart=always
RestartSec=5
TimeoutStopSec=10
UMask=0077
RuntimeDirectory=umeko-remote-agent
RuntimeDirectoryMode=0700
Environment=UMEKO_REMOTE_STATUS_FILE=%t/umeko-remote-agent/status.json
UnsetEnvironment=DISPLAY WAYLAND_DISPLAY XAUTHORITY SESSION_MANAGER
NoNewPrivileges=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=default.target
'''


class ServiceController:
    def __init__(self, config=None, home=None):
        self.home = Path(home) if home else Path.home()
        self.config = Path(config).expanduser().resolve() if config else self.home / '.config/umeko-remote/agent.json'
        self.install_dir = self.home / '.local/share/umeko-remote'
        self.unit_path = self.home / '.config/systemd/user' / UNIT
        self.environment = os.environ.copy()
        self.environment.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
        self.environment.setdefault('DBUS_SESSION_BUS_ADDRESS', f"unix:path={self.environment['XDG_RUNTIME_DIR']}/bus")
        self.status_path = Path(self.environment['XDG_RUNTIME_DIR']) / 'umeko-remote-agent/status.json'

    def run(self, arguments, check=True):
        result = subprocess.run(arguments, env=self.environment, capture_output=True, text=True, timeout=30)
        if check and result.returncode:
            raise RuntimeError((result.stderr or result.stdout or '后台服务操作失败').strip())
        return result

    def systemctl(self, *arguments, check=True):
        return self.run(['systemctl', '--user', *arguments], check=check)

    def install(self):
        if not self.config.is_file():
            raise RuntimeError(f'缺少连接配置：{self.config}')
        node = shutil.which('node')
        if not node:
            raise RuntimeError('请安装 Node.js 22 或更新版本')
        runtime = self.install_dir / 'remote'
        runtime.mkdir(parents=True, exist_ok=True)
        for name in ['agent.js', 'auth.js', 'desktop.py', 'service.py']:
            source, destination = ROOT / name, runtime / name
            if source.resolve() != destination.resolve():
                shutil.copyfile(source, destination)
        source_ws = ROOT.parent / 'node_modules/ws'
        destination_ws = self.install_dir / 'node_modules/ws'
        if source_ws.resolve() != destination_ws.resolve():
            if not source_ws.is_dir():
                raise RuntimeError('缺少 ws 依赖，请先在项目中运行 npm ci --no-bin-links')
            shutil.copytree(source_ws, destination_ws, dirs_exist_ok=True)
        if not (destination_ws / 'package.json').is_file():
            raise RuntimeError('缺少连接器的 ws 依赖')
        (self.install_dir / 'package.json').write_text('{"private":true,"type":"module"}\n')
        content = service_text(node, runtime / 'agent.js', self.config)
        self.unit_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.unit_path.exists() or self.unit_path.read_text() != content:
            temporary = self.unit_path.with_suffix('.tmp')
            temporary.write_text(content)
            temporary.chmod(0o600)
            temporary.replace(self.unit_path)
            self.systemctl('daemon-reload')

    def start(self):
        self.install()
        self.systemctl('start', UNIT)

    def stop(self):
        self.systemctl('stop', UNIT)

    def enabled(self):
        return self.systemctl('is-enabled', UNIT, check=False).stdout.strip() == 'enabled'

    def linger_enabled(self):
        result = self.run(['loginctl', 'show-user', str(os.getuid()), '-p', 'Linger', '--value'], check=False)
        return result.returncode == 0 and result.stdout.strip() == 'yes'

    def set_autostart(self, enabled):
        if enabled:
            self.install()
            if not self.linger_enabled():
                self.run(['loginctl', 'enable-linger', getpass.getuser()])
            if not self.linger_enabled():
                raise RuntimeError('系统尚未允许未登录启动，请启用当前用户的 linger')
            self.systemctl('enable', UNIT)
        else:
            self.systemctl('disable', UNIT)
            # Keep linger: unrelated services may also need to run after logout.

    def status(self):
        result = self.systemctl('show', UNIT, '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', '-p', 'MainPID', check=False)
        properties = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        active = properties.get('ActiveState') == 'active'
        status = {'state': 'connecting' if active else 'stopped', 'message': '正在读取后台连接状态' if active else '远程访问已断开'}
        if active:
            try:
                latest = json.loads(self.status_path.read_text())
                if latest.get('pid') == int(properties.get('MainPID', '0')):
                    status = latest
            except (OSError, ValueError, TypeError):
                pass
        return {**status, 'active': active, 'substate': properties.get('SubState', ''),
                'enabled': properties.get('UnitFileState') == 'enabled'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'start', 'stop', 'status', 'enable', 'disable'])
    parser.add_argument('--config')
    args = parser.parse_args()
    controller = ServiceController(args.config)
    if args.action == 'enable':
        controller.set_autostart(True)
        controller.start()
    elif args.action == 'disable':
        controller.set_autostart(False)
    elif args.action != 'status':
        getattr(controller, args.action)()
    print(json.dumps(controller.status(), ensure_ascii=False))


if __name__ == '__main__':
    main()
