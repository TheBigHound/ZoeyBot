"""Guest desktop unit regressions; no X server or provisioning required."""
import base64
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vm_desktop', Path(__file__).resolve().parents[1] / 'server/box/vm-desktop.py')
assert spec is not None and spec.loader is not None
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)


class DesktopTests(unittest.TestCase):
    def test_unknown_operation_cannot_launch_desktops(self):
        with patch.object(vm, 'ensure') as ensure:
            with self.assertRaisesRegex(ValueError, 'Unknown desktop operation'):
                vm.action({'op': 'not-an-operation'})
            ensure.assert_not_called()

    def test_screen_names_are_strict(self):
        self.assertEqual(vm.number('default'), 99)
        self.assertEqual(vm.number('screen-102'), 102)
        for bad in ('screen-99', 'screen-103', 'screen-100;evil', ':100'):
            with self.assertRaises(ValueError):
                vm.number(bad)

    def test_clipboard_daemon_cannot_keep_capture_pipes_open(self):
        # xclip forks a selection owner; inherited PIPEs make communicate hang until timeout.
        with patch.object(vm.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = None
            result = vm.run(['xclip', '-selection', 'clipboard'], 99, b'hello')
            self.assertEqual(run.call_args.kwargs['stdout'], vm.subprocess.DEVNULL)
            self.assertEqual(run.call_args.kwargs['stderr'], vm.subprocess.DEVNULL)
            self.assertEqual(result, b'')

    def test_unicode_is_sent_to_clipboard_as_utf8(self):
        with patch.object(vm, 'ensure'), patch.object(vm, 'run', return_value=b'') as run:
            vm.action({'op': 'type', 'screen': 'screen-100', 'body': {'text': "hello '世界'"}})
            self.assertEqual(run.call_args_list[0].args, (['xclip', '-selection', 'clipboard'], 100, "hello '世界'".encode()))
            self.assertEqual(run.call_args_list[1].args[0][-1], 'ctrl+v')

    def test_uppercase_letter_chords_do_not_add_implicit_shift(self):
        # xdotool interprets literal uppercase A as Shift+a (Chrome Ctrl+Shift+A opens tab search).
        self.assertEqual(vm.key_name('CTRL+A'), 'ctrl+a')
        self.assertEqual(vm.key_name('CTRL+L'), 'ctrl+l')
        self.assertEqual(vm.key_name('CTRL+SHIFT+A'), 'ctrl+shift+a')
        self.assertEqual(vm.key_name('F5'), 'F5')

    def test_key_chords_are_arguments_not_shell_source(self):
        with patch.object(vm, 'ensure'), patch.object(vm, 'run', return_value=b'') as run:
            vm.action({'op': 'key', 'body': {'key': 'CTRL+SHIFT+ENTER'}})
            self.assertEqual(run.call_args.args[0], ['xdotool', 'key', '--clearmodifiers', '--', 'ctrl+shift+Return'])

    def test_screenshot_returns_real_command_bytes_not_placeholder(self):
        with patch.object(vm, 'ensure'), patch.object(vm, 'run', return_value=b'jpeg fixture') as run:
            result = vm.action({'op': 'screenshot'})
            self.assertEqual(base64.b64decode(result['image']), b'jpeg fixture')
            self.assertEqual(result['mime_type'], 'image/jpeg')
            self.assertEqual(run.call_args.args[0][0], 'import')

    def test_click_and_scroll_validate_inputs(self):
        with patch.object(vm, 'ensure'), patch.object(vm, 'run', return_value=b''):
            for body in ({'x': -1, 'y': 0}, {'x': 0, 'y': 900}, {'x': 0, 'y': 0, 'button': 'bad'}):
                with self.assertRaises(ValueError):
                    vm.action({'op': 'click', 'body': body})
            with self.assertRaises(ValueError):
                vm.action({'op': 'scroll', 'body': {'x': 0, 'y': 0, 'direction': 'sideways', 'amount': 1}})

    def test_default_display_cannot_be_deleted(self):
        with self.assertRaisesRegex(ValueError, 'Cannot delete the default'):
            vm.action({'op': 'delete', 'screen': 'default'})


if __name__ == '__main__':
    unittest.main()
