#!/usr/bin/env python3
"""Offline launcher regressions (host mode); never bootstraps jobs or touches real services."""
import importlib.util
from pathlib import Path
import plistlib
import tempfile
import json
import os
import unittest
from unittest.mock import Mock, patch, call

SCRATCH = Path.home() / '.hermes/cache/scratch'
SCRATCH.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(SCRATCH)

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('local_services', ROOT / 'scripts/local-services.py')
assert SPEC is not None and SPEC.loader is not None


class LauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SPEC.origin or not Path(SPEC.origin).is_file():
            raise AssertionError('launcher implementation is missing')
        cls.m = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(cls.m)

    def config(self):
        return self.m.make_config(ROOT, Path('/Users/test'), '/opt/node/bin/node', '/usr/local/bin/ollama', '/opt/voice/bin/ffmpeg', '/opt/voice/bin/hermes')

    def test_private_plists_use_clean_environments_and_no_login_registration(self):
        config = self.config()
        jobs = self.m.make_jobs(config)
        self.assertEqual(set(jobs), {'engine', 'web', 'ollama'})
        self.assertEqual(self.m.SERVICES, ('ollama', 'web', 'engine'))
        for name, job in jobs.items():
            self.assertEqual(job['Label'], 'com.thehound.bothq.' + name)
            self.assertEqual(job['ProgramArguments'][:2], ['/usr/bin/env', '-i'])
            self.assertTrue(job['RunAtLoad'])
            self.assertTrue(job['KeepAlive'])
            self.assertEqual(job['Umask'], 0o077)
            self.assertEqual(plistlib.loads(plistlib.dumps(job)), job)
            self.assertIn('/data/logs/', job['StandardErrorPath'])
            self.assertNotIn('SESSION_SECRET', str(job))
            self.assertNotIn('COMPOSIO_API_KEY', str(job))
        self.assertIn('HERMES_HOME=' + str(ROOT / 'data/primary-hermes'), jobs['engine']['ProgramArguments'])
        self.assertEqual(jobs['engine']['ProgramArguments'][-3:], ['gateway', 'run', '--no-supervise'])
        self.assertEqual(jobs['web']['WorkingDirectory'], str(ROOT / 'server'))
        self.assertEqual(jobs['web']['ProgramArguments'][-4:], ['/opt/node/bin/node', '--env-file=../.env', '--env-file-if-exists=../.env.local', 'dist/index.js'])
        web = jobs['web']['ProgramArguments']
        self.assertIn('HQ_HOST=1', web)
        for forbidden in ('HQ_VM=1', 'HQ_VM_KEY=', 'HQ_VM_KNOWN_HOSTS=', 'HQ_LOCAL=1'):
            self.assertFalse(any(arg.startswith(forbidden) for arg in web), forbidden)
        for expected in ('HERMES_HOME_PRIMARY=' + str(ROOT / 'data/primary-hermes'), 'HERMES_BIN=' + str(ROOT / 'data/primary-hermes/runtime-hermes'),
                         'HERMES_URL=http://127.0.0.1:8642', 'PORT=8787', 'APP_URL=http://127.0.0.1:8787', 'SERVER_URL=http://127.0.0.1:8787'):
            self.assertIn(expected, web)
        for legacy in ('vm_uuid', 'utmctl', 'key', 'known_hosts'):
            self.assertNotIn(legacy, config)
        self.assertEqual(config['state'], str(ROOT / 'data/launchd'))
        self.assertNotIn('Library/LaunchAgents', str(config))

    def test_clean_web_job_pins_local_voice_executables(self):
        config = self.config()
        config.update(ffmpeg='/opt/voice/bin/ffmpeg', stt_hermes='/opt/voice/bin/hermes')
        args = self.m.make_jobs(config)['web']['ProgramArguments']
        self.assertIn('LOCAL_FFMPEG_BIN=/opt/voice/bin/ffmpeg', args)
        self.assertIn('LOCAL_STT_HERMES_BIN=/opt/voice/bin/hermes', args)
        self.assertIn('LOCAL_TTS_BIN=/usr/local/bin/ollama', args)

    def test_conflicts_are_rejected_even_if_the_endpoint_claims_health(self):
        config = self.config()
        owner = {'pid': 7, 'command': '/usr/bin/python3 unrelated.py', 'cwd': str(ROOT)}
        with self.assertRaisesRegex(self.m.ServiceError, 'unrecognized.*8642'):
            self.m.service_action('engine', {8642: [owner]}, False, True, config)
        self.assertEqual(self.m.service_action('engine', {}, False, False, config), 'start')
        self.assertEqual(self.m.service_action('engine', {}, True, False, config), 'wait')
        self.assertEqual(self.m.service_action('engine', {}, True, True, config), 'wait')

    def test_known_healthy_external_components_are_reused_not_adopted(self):
        config = self.config()
        private = str(ROOT / 'data/primary-hermes')
        owner = {'pid': 17, 'command': "python -I -c os.environ.pop('BOT_HQ_HERMES_HOME') gateway run --no-supervise", 'cwd': private}
        self.assertEqual(self.m.service_action('engine', {8642: [owner]}, False, True, config), 'reuse')
        self.assertEqual(self.m.service_action('engine', {8642: [owner]}, True, True, config), 'keep')
        with self.assertRaisesRegex(self.m.ServiceError, 'unhealthy.*external'):
            self.m.service_action('engine', {8642: [owner]}, False, False, config)
        owner['cwd'] = '/Users/test/.hermes'
        with self.assertRaises(self.m.ServiceError):
            self.m.service_action('engine', {8642: [owner]}, False, True, config)

    def test_tunnels_are_gone(self):
        with self.assertRaises(KeyError):
            self.m.service_ports('tunnels')
        self.assertFalse(self.m.recognized_owner('tunnels', dict(pid=13, cwd='/', command='/usr/bin/ssh -NT -p 2222'), self.config()))
        with self.assertRaisesRegex(self.m.ServiceError, 'not an owned'):
            self.m.LocalBackend(self.config(), runner=Mock()).target('tunnels')
        for gone in ('ensure_vm', 'ensure_ssh', 'vm_status', 'request_vm_shutdown'):
            self.assertFalse(hasattr(self.m.LocalBackend, gone), gone)
        self.assertFalse(hasattr(self.m, 'vnc_ready'))

    def test_install_writes_only_private_project_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'repo'
            c = self.m.make_config(root, Path('/Users/test'), '/opt/node/bin/node', '/usr/local/bin/ollama', '/opt/voice/bin/ffmpeg', '/opt/voice/bin/hermes')
            self.m.install_files(c)
            state = root / 'data/launchd'
            self.assertEqual((state.stat().st_mode & 0o777), 0o700)
            self.assertEqual(((root / 'data/logs').stat().st_mode & 0o777), 0o700)
            for name in ('config.json',) + tuple('com.thehound.bothq.' + name + '.plist' for name in ('engine', 'web', 'ollama')):
                self.assertEqual(((state / name).stat().st_mode & 0o777), 0o600)
            self.assertFalse((state / 'com.thehound.bothq.tunnels.plist').exists())
            for name in ('start.command', 'stop.command'):
                script = state / name
                self.assertEqual(script.stat().st_mode & 0o777, 0o700)
                self.assertIn('/usr/bin/env -i', script.read_text())
                self.assertIn('/usr/bin/python3', script.read_text())
            self.assertFalse((root / 'Library').exists())
            self.assertEqual(self.m.load_config(root), c)
            self.m.install_files(c)  # idempotent

    def test_vm_era_config_still_loads_so_install_can_be_rerun(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'repo'
            c = self.m.make_config(root, Path('/Users/test'), '/opt/node/bin/node', '/usr/local/bin/ollama', '/opt/voice/bin/ffmpeg', '/opt/voice/bin/hermes')
            old = dict(c, vm_uuid='A1CE5F16-4C0F-42F6-BD61-742708F09212', utmctl='/Users/test/Applications/UTM.app/Contents/MacOS/utmctl',
                       key='/Users/test/.ssh/bot-hq-utm', known_hosts='/Users/test/VirtualMachines/BotHQ/ssh_known_hosts')
            self.m.private_write(root / 'data/launchd/config.json', json.dumps(old))
            self.assertEqual(self.m.load_config(root), c)
            self.m.install_files(c)
            self.assertEqual(json.loads((root / 'data/launchd/config.json').read_text()), c)
            self.m.private_write(root / 'data/launchd/config.json', json.dumps(dict(c, root='/somewhere/else')))
            with self.assertRaisesRegex(self.m.ServiceError, 'root does not match'):
                self.m.load_config(root)

    def test_start_order_reuses_components_and_rolls_back_only_new_jobs(self):
        backend = Mock()
        backend.inspect.side_effect = lambda name: dict(action='reuse' if name == 'ollama' else 'start')
        self.m.start_services(backend, open_browser=True)
        self.assertEqual(backend.method_calls, [
            call.preflight(),
            *[call.inspect(n) for n in ('ollama', 'web', 'engine')],
            call.wait_ready('ollama'),
            *[event for n in ('web', 'engine') for event in (call.bootstrap(n), call.wait_ready(n))],
            call.open_browser(),
        ])
        backend = Mock()
        backend.inspect.side_effect = lambda name: dict(action='reuse' if name == 'ollama' else 'start')
        backend.wait_ready.side_effect = lambda name: (_ for _ in ()).throw(self.m.ServiceError('not ready')) if name == 'engine' else None
        with self.assertRaisesRegex(self.m.ServiceError, 'not ready'):
            self.m.start_services(backend)
        self.assertEqual(backend.bootout.call_args_list, [call('engine'), call('web')])
        backend.open_browser.assert_not_called()

    def test_unknown_conflict_aborts_before_launchd_writes(self):
        backend = Mock()
        backend.inspect.side_effect = self.m.ServiceError('unrecognized listener')
        with self.assertRaises(self.m.ServiceError):
            self.m.start_services(backend)
        backend.bootstrap.assert_not_called()

    def test_stop_uses_only_owned_labels_in_reverse_start_order(self):
        backend = Mock()
        self.m.stop_services(backend)
        self.assertEqual(backend.bootout.call_args_list, [call(n) for n in ('engine', 'web', 'ollama')])

    def test_backend_bootstrap_checks_ports_again_and_verifies_loaded_job(self):
        b = self.m.LocalBackend(self.config(), runner=Mock())
        b.inspect = Mock(return_value={'action': 'reuse'})
        b.bootstrap('engine')
        b.runner.assert_not_called()
        b.inspect = Mock(return_value={'action': 'start'})
        b.loaded = Mock(return_value=True)
        b.bootstrap('engine')
        args = b.runner.call_args.args[0]
        self.assertEqual(args[:2], ['/bin/launchctl', 'bootstrap'])
        self.assertEqual(args[2], 'gui/' + str(os.getuid()))
        self.assertTrue(args[3].endswith('/data/launchd/com.thehound.bothq.engine.plist'))
        b.loaded.assert_called_once_with('engine')

    def test_backend_stop_does_not_signal_external_port_owners(self):
        b = self.m.LocalBackend(self.config(), runner=Mock())
        b.loaded = Mock(return_value=False)
        b.bootout('engine')
        b.runner.assert_not_called()
        b.loaded = Mock(side_effect=[True, False])
        b.runner.return_value.returncode = 0
        b.bootout('engine')
        self.assertEqual(b.runner.call_args.args[0], ['/bin/launchctl', 'bootout', 'gui/%d/com.thehound.bothq.engine' % os.getuid()])
        self.assertEqual(b.loaded.call_count, 2)

    def test_http_health_requires_component_identity_not_just_http_200(self):
        b = self.m.LocalBackend(self.config(), runner=Mock())
        with patch.object(self.m, 'get_json', return_value={'ok': True, 'engine': 'hermes'}), patch.object(self.m, 'get_text', return_value='<html><script src="/assets/app.js"></script></html>'):
            self.assertTrue(b.healthy('web'))
            self.assertFalse(b.healthy('engine'))
        with patch.object(self.m, 'get_json', return_value={'status': 'ok', 'platform': 'hermes-agent'}):
            self.assertTrue(b.healthy('engine'))
            self.assertFalse(b.healthy('ollama'))
        with patch.object(self.m, 'get_json', return_value={'models': []}):
            self.assertTrue(b.healthy('ollama'))

    def test_preflight_needs_no_vm_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'repo'
            tools = Path(directory) / 'tools'
            tools.mkdir()
            for name in ('node', 'ollama', 'ffmpeg', 'hermes'):
                (tools / name).touch()
            c = self.m.make_config(root, Path(directory) / 'home', tools / 'node', tools / 'ollama', tools / 'ffmpeg', tools / 'hermes')
            self.m.install_files(c)
            for rel in ('.env', 'data/primary-hermes/runtime-hermes', 'data/primary-hermes/.env', 'server/dist/index.js', 'web/dist/index.html'):
                path = root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch(mode=0o600)
            runner = Mock()
            runner.return_value.returncode = 0
            b = self.m.LocalBackend(c, runner=runner)
            b.preflight()  # no UTM, ssh key, known-hosts or tunnel script required
            self.assertEqual(runner.call_args.args[0], ['/bin/launchctl', 'print', 'gui/%d' % os.getuid()])
            (root / 'server/dist/index.js').unlink()
            with self.assertRaisesRegex(self.m.ServiceError, 'missing prerequisite'):
                b.preflight()

    def test_listener_parser_rejects_non_loopback_binds_and_dedupes(self):
        self.assertEqual(self.m.parse_listeners('p12\nn127.0.0.1:8787\nn127.0.0.1:8787\np13\nn[::1]:8642\n'), {8787: [12], 8642: [13]})
        with self.assertRaisesRegex(self.m.ServiceError, 'loopback'):
            self.m.parse_listeners('p12\nn*:8787\n')

    def test_bundle_metadata_points_to_current_install_and_has_no_login_hooks(self):
        info = self.m.bundle_info(self.config())
        self.assertEqual(info['CFBundleIdentifier'], 'com.thehound.bothq.launcher')
        self.assertEqual(info['CFBundleExecutable'], 'BotHQLauncher')
        self.assertEqual(info['BHLauncherPath'], str(ROOT / 'scripts/local-services.py'))
        self.assertEqual(info['BHRoot'], str(ROOT))
        self.assertTrue(info['LSUIElement'])
        self.assertNotIn('NSAppleEventsUsageDescription', info, 'host mode drives no VM and needs no Automation permission')
        self.assertNotIn('SMPrivilegedExecutables', info)
        self.assertNotIn('LSBackgroundOnly', info)

    def test_lifecycle_lock_is_exclusive_and_then_released(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.m.lifecycle_lock(Path(directory)):
                with self.assertRaisesRegex(self.m.ServiceError, 'already in progress'):
                    with self.m.lifecycle_lock(Path(directory)):
                        self.fail('concurrent lifecycle operation was admitted')
            with self.m.lifecycle_lock(Path(directory)):
                pass

    def test_ollama_symlink_target_is_recognized_but_other_binary_is_not(self):
        with tempfile.TemporaryDirectory() as directory:
            real = Path(directory) / 'Ollama.app/Contents/Resources/ollama'
            real.parent.mkdir(parents=True)
            real.touch()
            link = Path(directory) / 'ollama'
            link.symlink_to(real)
            c = dict(self.config(), ollama=str(link))
            owner = dict(pid=7, command=str(real) + ' serve', cwd='/')
            self.assertTrue(self.m.recognized_owner('ollama', owner, c))
            owner['command'] = '/opt/unrelated/ollama serve'
            self.assertFalse(self.m.recognized_owner('ollama', owner, c))

    def test_status_distinguishes_healthy_external_from_managed_and_cli_enforces_it(self):
        backend = Mock()
        backend.config = self.config()
        backend.inspect.return_value = dict(healthy=True, loaded=False)
        report = self.m.status_report(backend)
        self.assertEqual(report['mode'], 'host')
        self.assertEqual(set(report['services']), {'ollama', 'web', 'engine'})
        self.assertNotIn('vm_state', report)
        self.assertTrue(report['ready'])
        self.assertFalse(report['managed'])
        backend.inspect.return_value = dict(healthy=True, loaded=True)
        self.assertTrue(self.m.status_report(backend)['managed'])
        with patch.object(self.m, 'load_config', return_value=self.config()), patch.object(self.m, 'LocalBackend', return_value=backend), patch.object(self.m, 'status_report', return_value=report), patch('builtins.print'):
            self.assertEqual(self.m.main(['status', '--check', '--require-managed']), 1)

    def test_cli_stop_has_no_vm_flag_and_only_unloads_owned_jobs(self):
        backend = Mock()
        backend.config = self.config()
        with patch.object(self.m, 'load_config', return_value=self.config()), patch.object(self.m, 'LocalBackend', return_value=backend), \
                patch.object(self.m, 'lifecycle_lock'), patch('builtins.print'):
            self.assertEqual(self.m.main(['stop']), 0)
            self.assertEqual(backend.bootout.call_args_list, [call(n) for n in ('engine', 'web', 'ollama')])
            with self.assertRaises(SystemExit):
                self.m.main(['stop', '--shutdown-vm'])


if __name__ == '__main__':
    unittest.main()
