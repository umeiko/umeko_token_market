import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from service import ServiceController, UNIT, service_text, systemd_quote


class FakeController(ServiceController):
    def __init__(self, home):
        super().__init__(home=home)
        self.calls = []
        self.linger = False
        self.properties = 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=42\n'
        self.status_path = Path(home) / 'status.json'

    def install(self):
        self.calls.append(['install'])

    def run(self, arguments, check=True):
        self.calls.append(arguments)
        if arguments[:2] == ['loginctl', 'enable-linger']:
            self.linger = True
        return subprocess.CompletedProcess(arguments, 0, '', '')

    def linger_enabled(self):
        return self.linger

    def systemctl(self, *arguments, check=True):
        self.calls.append(['systemctl', *arguments])
        return subprocess.CompletedProcess(arguments, 0, self.properties if arguments[0] == 'show' else '', '')


class ServiceTests(unittest.TestCase):
    def test_enable_prepares_boot_without_graphical_session_and_disable_preserves_linger(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = FakeController(directory)
            controller.set_autostart(True)
            self.assertTrue(controller.linger)
            self.assertIn(['systemctl', 'enable', UNIT], controller.calls)
            self.assertLess(next(i for i, call in enumerate(controller.calls) if call[:2] == ['loginctl', 'enable-linger']), controller.calls.index(['systemctl', 'enable', UNIT]))
            controller.calls.clear()
            controller.set_autostart(False)
            self.assertEqual(controller.calls, [['systemctl', 'disable', UNIT]])
            self.assertTrue(controller.linger)

    def test_stale_state_from_previous_process_cannot_report_online(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = FakeController(directory)
            controller.status_path.write_text(json.dumps({'pid': 41, 'state': 'online'}))
            self.assertEqual(controller.status()['state'], 'connecting')
            controller.status_path.write_text(json.dumps({'pid': 42, 'state': 'online'}))
            self.assertEqual(controller.status()['state'], 'online')
            controller.properties = controller.properties.replace('ActiveState=active', 'ActiveState=inactive')
            self.assertEqual(controller.status()['state'], 'stopped')

    def test_unit_uses_headless_runtime_and_escapes_special_path_characters(self):
        content = service_text('/usr/local/bin/node', '/home/a b/agent.js', '/home/a%$"/config.json')
        self.assertIn('WantedBy=default.target', content)
        self.assertIn('UnsetEnvironment=DISPLAY WAYLAND_DISPLAY XAUTHORITY SESSION_MANAGER', content)
        self.assertNotIn('graphical-session.target', content)
        self.assertNotIn('desktop.py', content)
        self.assertIn('"/home/a b/agent.js"', content)
        self.assertIn('%%$$\\"', content)
        with self.assertRaises(ValueError):
            systemd_quote('/tmp/file\nExecStart=/bin/false')


if __name__ == '__main__':
    unittest.main()
