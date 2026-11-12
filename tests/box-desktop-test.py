"""Desktop dressing regressions. GTK checks also run on the actual guest display."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

BOX = Path(__file__).resolve().parents[1] / 'server/box'
if not BOX.is_dir():
    BOX = Path('/opt/hq')
sys.path.insert(0, str(BOX))
import hqlib


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, BOX / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


screen = load('hq_screen', 'hq-screen.py')


class PolicyTests(unittest.TestCase):
    def test_snap_policy_written_even_when_etc_directory_is_absent(self):
        with tempfile.TemporaryDirectory() as root:
            dirs = tuple(root + '/' + name + '/policies/managed'
                         for name in ('chrome', 'chromium', 'chromium-browser'))
            real_isdir = os.path.isdir
            with patch.object(screen, 'POLICY_DIRS', dirs), patch.object(
                    os.path, 'isdir', side_effect=lambda p: p == '/snap/chromium/current' or real_isdir(p)):
                warnings = []
                written = screen.write_policy('a' * 32, warnings)
            self.assertIn(dirs[2] + '/hq.json', written)
            policy = json.loads(Path(dirs[2] + '/hq.json').read_text())
            self.assertEqual(policy['ExtensionInstallForcelist'], ['%s;%s/ext/updates.xml' % ('a' * 32, hqlib.HOME_URL)])
            self.assertEqual(warnings, [])


class BrowserTests(unittest.TestCase):
    def test_existing_browser_refreshes_stale_new_tab_after_extension_install(self):
        with patch.object(hqlib, 'chrome_bin', return_value='/usr/bin/chromium-browser'), \
                patch.object(hqlib, 'our_browser', return_value=[(123, 99)]), \
                patch.object(hqlib, 'browser_procs', return_value=[]), \
                patch.object(hqlib, 'cdp', return_value={}), \
                patch.object(hqlib, 'browser_windows', return_value=[]), \
                patch.object(hqlib, 'extension_id', return_value='a' * 32), \
                patch.object(os.path, 'isdir', return_value=True), \
                patch.object(hqlib, '_show_home') as show, \
                patch.object(hqlib.time, 'sleep'):
            result = hqlib.start_browser(99, 'bot-test')
        self.assertFalse(result['started'])
        show.assert_called_once()


    def test_working_tabs_are_not_replaced_by_home(self):
        with patch.object(hqlib, 'extension_id', return_value='a' * 32), \
                patch.object(os.path, 'isdir', return_value=True), \
                patch.object(hqlib, 'cdp', return_value=[{'type': 'page', 'url': 'https://example.org/work', 'title': 'Work'}]) as cdp, \
                patch.object(hqlib.urllib.request, 'urlopen') as urlopen, \
                patch.object(hqlib.time, 'sleep'):
            warnings = []
            hqlib._show_home(99, 'bot-test', warnings, lambda *_: None)
        self.assertEqual(warnings, [])
        cdp.assert_called_once_with(99, '/json/list')
        urlopen.assert_not_called()


try:
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk, Gdk
    HAS_GTK = bool(os.environ.get('DISPLAY'))
except ImportError:
    HAS_GTK = False


@unittest.skipUnless(HAS_GTK, 'requires GTK and an X display; run on guest')
class DockTests(unittest.TestCase):
    def test_opt_in_dock_stays_above_maximized_browser(self):
        self.check_layer({'dockAboveWindows': True}, True)

    def test_default_dock_keeps_original_below_window_behavior(self):
        self.check_layer({}, False)

    def check_layer(self, options, above):
        with patch.object(sys, 'argv', ['hq-shell.py', '99']):
            shell_module = load('hq_shell', 'hq-shell.py')
        shell = shell_module.Shell.__new__(shell_module.Shell)
        shell.screen = Gdk.Screen.get_default()
        shell.size = (1440, 900)
        shell.dock = shell.wall_win = None
        shell.wall = None
        shell.look = {}
        shell.icons = []
        shell.hover = shell.pressed = -1
        with patch.object(hqlib, 'read_json', return_value=options):
            shell.rebuild_dock()
        desired = Gdk.WindowState.ABOVE if above else Gdk.WindowState.BELOW
        undesired = Gdk.WindowState.BELOW if above else Gdk.WindowState.ABOVE
        try:
            deadline = time.time() + 2
            while time.time() < deadline:
                while Gtk.events_pending():
                    Gtk.main_iteration_do(False)
                if shell.dock.get_window().get_state() & desired:
                    break
                time.sleep(0.02)
            state = shell.dock.get_window().get_state()
            self.assertTrue(state & desired, 'dock is in the wrong stacking layer')
            self.assertFalse(state & undesired)
        finally:
            shell.dock.destroy()


if __name__ == '__main__':
    unittest.main()
