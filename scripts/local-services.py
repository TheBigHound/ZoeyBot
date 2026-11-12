#!/usr/bin/python3
"""ZoeyBot's explicit, per-login launchd lifecycle (host mode: every agent runs on this Mac). No login auto-start."""
from pathlib import Path
import shlex
import json
import os
import plistlib
import tempfile
import subprocess
import time
import urllib.request
import urllib.error
import argparse
from contextlib import contextmanager
import fcntl
import shutil
import sys


class ServiceError(RuntimeError):
    pass


PREFIX = 'com.thehound.zoeybot.'
# Host mode: every Hermes gateway runs on this Mac. Start order matters: the web endpoint serves MCP to the engine.
SERVICES = ('ollama', 'web', 'engine')
# Keys an older (VM-era) config.json may still carry; they are ignored so `install` can be re-run over it.
LEGACY_CONFIG_KEYS = ('utmctl', 'vm_uuid', 'key', 'known_hosts')


def service_ports(name):
    return {'engine': (8642,), 'web': (8787,), 'ollama': (11434,)}[name]


def recognized_owner(name, owner, config):
    command, cwd = owner['command'], owner['cwd']
    try:
        args = shlex.split(command)
    except ValueError:
        return False
    root = Path(config['root'])
    if name == 'engine':
        return (cwd in (str(root), str(root / 'data/primary-hermes')) and
                'gateway run --no-supervise' in command and
                # The generated runtime-hermes adapter passes the private home through ZOEYBOT_HERMES_HOME;
                # adapters generated before the rename still use BOT_HQ_HERMES_HOME.
                (any(marker in command for marker in ('ZOEYBOT_HERMES_HOME', 'BOT_HQ_HERMES_HOME')) or
                 str(root / 'data/primary-hermes/runtime-hermes') in args))
    if name == 'web':
        return ((cwd == str(root) and 'server/src/index.ts' in args) or
                (cwd == str(root / 'server') and 'dist/index.js' in args)) and any('env-file=' in arg for arg in args)
    if name == 'ollama':
        return bool(args) and (args[0] == 'ollama' or Path(args[0]).resolve() == Path(config['ollama']).resolve()) and 'serve' in args
    return False


def service_action(name, owners, loaded, healthy, config):
    ports = service_ports(name)
    for port in ports:
        for owner in owners.get(port, []):
            if not recognized_owner(name, owner, config):
                raise ServiceError('unrecognized listener on %d (PID %d); nothing was killed' % (port, owner['pid']))
    occupied = [port for port in ports if owners.get(port)]
    if not occupied:
        return 'wait' if loaded else 'start'
    if len(occupied) != len(ports):
        if loaded:
            return 'wait'
        raise ServiceError('incomplete external ' + name + '; stop it explicitly before migration')
    if not healthy:
        if loaded:
            return 'wait'
        raise ServiceError('unhealthy external ' + name + '; inspect it explicitly before migration')
    return 'keep' if loaded else 'reuse'


def make_config(root, home, node, ollama, ffmpeg, stt_hermes):
    root, home = Path(root).resolve(), Path(home).resolve()
    return dict(root=str(root), home=str(home), node=str(node), ollama=str(ollama),
                ffmpeg=str(ffmpeg), stt_hermes=str(stt_hermes),
                state=str(root / 'data/launchd'), logs=str(root / 'data/logs'))


def make_jobs(config):
    c = config
    root = Path(c['root'])
    private = root / 'data/primary-hermes'
    env = ['HOME=' + c['home'], 'USER=' + Path(c['home']).name, 'LANG=en_US.UTF-8',
           'TMPDIR=' + str(root / 'data/launchd/tmp'),
           'PATH=' + ':'.join([str(private / 'bin'), str(Path(c['node']).parent),
                             '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])]
    commands = {
        'engine': ['HERMES_HOME=' + str(private), 'HERMES_GATEWAY_LOCK_DIR=' + str(private / 'locks'),
                   'BH_HOME=' + str(private / 'browser-harness'), str(private / 'runtime-hermes'),
                   'gateway', 'run', '--no-supervise'],
        'web': ['HQ_HOST=1',
                'HERMES_HOME_PRIMARY=' + str(private), 'HERMES_BIN=' + str(private / 'runtime-hermes'),
                'HERMES_URL=http://127.0.0.1:8642', 'PORT=8787', 'APP_URL=http://127.0.0.1:8787',
                'SERVER_URL=http://127.0.0.1:8787', 'LOCAL_TTS_BIN=' + c['ollama'],
                'LOCAL_FFMPEG_BIN=' + c['ffmpeg'], 'LOCAL_STT_HERMES_BIN=' + c['stt_hermes'],
                c['node'], '--env-file=../.env',
                '--env-file-if-exists=../.env.local', 'dist/index.js'],
        'ollama': ['OLLAMA_HOST=127.0.0.1:11434', c['ollama'], 'serve'],
    }
    return {name: dict(Label=PREFIX + name, ProgramArguments=['/usr/bin/env', '-i'] + env + command,
                       WorkingDirectory=str(root / 'server') if name == 'web' else str(root),
                       StandardOutPath=str(Path(c['logs']) / (name + '.out.log')),
                       StandardErrorPath=str(Path(c['logs']) / (name + '.err.log')),
                       RunAtLoad=True, KeepAlive=True, ThrottleInterval=15, ExitTimeOut=20, Umask=0o077,
                       ProcessType='Background') for name, command in commands.items()}


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise ServiceError('unsafe private directory: ' + str(path))
    path.chmod(0o700)


def private_write(path, content):
    path = Path(path)
    private_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content if isinstance(content, bytes) else content.encode())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install_files(config):
    state = Path(config['state'])
    for path in (state, state / 'tmp', Path(config['logs'])):
        private_directory(path)
    private_write(state / 'config.json', json.dumps(config, indent=2) + '\n')
    for name, job in make_jobs(config).items():
        private_write(state / (PREFIX + name + '.plist'), plistlib.dumps(job))
        for suffix in ('out', 'err'):
            log = Path(config['logs']) / (name + '.' + suffix + '.log')
            if log.is_symlink():
                raise ServiceError('refusing symlink log: ' + str(log))
            log.touch(mode=0o600, exist_ok=True)
            log.chmod(0o600)
    for command in ('start', 'stop'):
        arguments = ['/usr/bin/env', '-i', 'HOME=' + config['home'], 'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
                     'LANG=en_US.UTF-8', '/usr/bin/python3', str(Path(config['root']) / 'scripts/local-services.py'), command]
        if command == 'start':
            arguments.append('--open-browser')
        script = state / (command + '.command')
        private_write(script, '#!/bin/bash\nset -euo pipefail\nexec ' + shlex.join(arguments) + ' "$@"\n')
        script.chmod(0o700)


def load_config(root):
    path = Path(root) / 'data/launchd/config.json'
    if path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise ServiceError('launcher config must be owned by this user and private (0600)')
    config = json.loads(path.read_text())
    for key in LEGACY_CONFIG_KEYS:
        config.pop(key, None)
    if config.get('root') != str(Path(root).resolve()):
        raise ServiceError('config root does not match this installation')
    return config


def start_services(backend, open_browser=False):
    backend.preflight()
    # The gateway discovers HQ's MCP tools during boot; the web endpoint must already answer.
    names = SERVICES
    plans = {name: backend.inspect(name) for name in names}
    started = []
    try:
        for name in names:
            if plans[name]['action'] == 'start':
                backend.bootstrap(name)
                started.append(name)
            backend.wait_ready(name)
        if open_browser:
            backend.open_browser()
    except Exception:
        # Never unload jobs that were already running, nor terminate external processes.
        for name in reversed(started):
            try:
                backend.bootout(name)
            except Exception as error:
                print('Rollback could not unload %s: %s' % (name, error), flush=True)
        raise


def stop_services(backend):
    errors = []
    for name in reversed(SERVICES):
        try:
            backend.bootout(name)
        except Exception as error:
            errors.append('%s: %s' % (name, error))
    if errors:
        raise ServiceError('; '.join(errors))


def run_command(args, timeout=30, check=True):
    # No shell, no inherited Hermes/cloud/provider environment for probes.
    environment = dict(HOME=str(Path.home()), PATH='/usr/bin:/bin:/usr/sbin:/sbin', LANG='en_US.UTF-8')
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout, env=environment)
    if check and result.returncode:
        raise ServiceError('%s failed (%d): %s' % (Path(args[0]).name, result.returncode, result.stderr.strip()[-1000:]))
    return result


def get_text(url):
    # Loopback probes never use system proxy settings.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=4) as response:
        return response.read(2 * 1024 * 1024).decode('utf-8')


def get_json(url):
    return json.loads(get_text(url))


def parse_listeners(output):
    ports, pid = {}, None
    for line in output.splitlines():
        if line.startswith('p'):
            pid = int(line[1:])
        elif line.startswith('n') and pid is not None:
            address = line[1:]
            host, port = address.rsplit(':', 1)
            if host not in ('127.0.0.1', '[::1]'):
                raise ServiceError('listener is not loopback-only: ' + address)
            bucket = ports.setdefault(int(port), [])
            if pid not in bucket:
                bucket.append(pid)
    return ports


class LocalBackend:
    def __init__(self, config, runner=run_command):
        self.config = config
        self.runner = runner
        self.domain = 'gui/%d' % os.getuid()

    def target(self, name):
        if name not in make_jobs(self.config):
            raise ServiceError('not an owned ZoeyBot service: ' + name)
        return self.domain + '/' + PREFIX + name

    def job_path(self, name):
        self.target(name)
        return str(Path(self.config['state']) / (PREFIX + name + '.plist'))

    def loaded(self, name):
        result = self.runner(['/bin/launchctl', 'print', self.target(name)], check=False)
        if result.returncode == 0:
            text = result.stdout
            expected = make_jobs(self.config)[name]
            if self.config['root'] not in text or 'program = /usr/bin/env' not in text or expected['WorkingDirectory'] not in text:
                raise ServiceError('owned label has unexpected launch configuration: ' + self.target(name))
            return True
        if 'Could not find service' not in result.stderr and 'Bad request' not in result.stderr:
            raise ServiceError('cannot inspect launchd job: ' + result.stderr.strip())
        return False

    def owners(self, name):
        args = ['/usr/sbin/lsof', '-nP'] + ['-iTCP:%d' % port for port in service_ports(name)] + ['-sTCP:LISTEN', '-Fpn']
        result = self.runner(args, check=False)
        if result.returncode not in (0, 1) or (result.returncode == 1 and result.stderr.strip()):
            raise ServiceError('cannot inspect listeners: ' + result.stderr.strip())
        listeners = parse_listeners(result.stdout)
        details = {}
        for pid in {pid for owners in listeners.values() for pid in owners}:
            command = self.runner(['/bin/ps', '-p', str(pid), '-o', 'command='], check=False)
            cwd_result = self.runner(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], check=False)
            cwd = next((line[1:] for line in cwd_result.stdout.splitlines() if line.startswith('n')), '')
            details[pid] = dict(pid=pid, command=command.stdout.strip(), cwd=cwd)
        return {port: [details[pid] for pid in owners] for port, owners in listeners.items()}

    def healthy(self, name):
        try:
            if name == 'engine':
                data = get_json('http://127.0.0.1:8642/health')
                return data.get('status') == 'ok' and data.get('platform') == 'hermes-agent'
            if name == 'web':
                data = get_json('http://127.0.0.1:8787/api/health')
                html = get_text('http://127.0.0.1:8787/')
                return data.get('ok') is True and data.get('engine') == 'hermes' and '<html' in html.lower() and '<script' in html.lower()
            if name == 'ollama':
                return isinstance(get_json('http://127.0.0.1:11434/api/tags').get('models'), list)
        except (OSError, ValueError, AttributeError, urllib.error.URLError):
            return False
        return False

    def inspect(self, name):
        owners, loaded = self.owners(name), self.loaded(name)
        healthy = self.healthy(name) if owners else False
        action = service_action(name, owners, loaded, healthy, self.config)
        return dict(action=action, healthy=healthy, loaded=loaded, target=self.target(name),
                    listeners={str(port): [owner['pid'] for owner in entries] for port, entries in owners.items()})

    def preflight(self):
        root = Path(self.config['root'])
        required = [self.config['node'], self.config['ollama'], self.config['ffmpeg'], self.config['stt_hermes'],
                    root / '.env', root / 'data/primary-hermes/runtime-hermes', root / 'data/primary-hermes/.env',
                    root / 'server/dist/index.js', root / 'web/dist/index.html']
        missing = [str(path) for path in required if not Path(path).is_file()]
        if missing:
            raise ServiceError('missing prerequisite(s): ' + ', '.join(missing) + '; build both server and web before starting')
        for path in (root / '.env.local', root / 'data/primary-hermes/.env'):
            if path.exists() and path.stat().st_mode & 0o077:
                raise ServiceError('credential file must be private: ' + str(path))
        for name, expected in make_jobs(self.config).items():
            path = Path(self.job_path(name))
            if path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077 or plistlib.loads(path.read_bytes()) != expected:
                raise ServiceError('stale or unsafe job file; rerun install: ' + str(path))
        self.runner(['/bin/launchctl', 'print', self.domain])

    def bootstrap(self, name):
        if self.inspect(name)['action'] != 'start':
            return
        self.runner(['/bin/launchctl', 'bootstrap', self.domain, self.job_path(name)])
        if not self.loaded(name):
            raise ServiceError('bootstrap did not load ' + self.target(name))

    def wait_ready(self, name):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            state = self.inspect(name)
            if state['action'] in ('keep', 'reuse'):
                print('%s ready (%s), PIDs %s' % (name, state['action'], state['listeners']), flush=True)
                return
            time.sleep(2)
        raise ServiceError(name + ' readiness timed out; inspect ' + self.config['logs'] + '/' + name + '.err.log')

    def bootout(self, name):
        if not self.loaded(name):
            return
        result = self.runner(['/bin/launchctl', 'bootout', self.target(name)], check=False, timeout=40)
        if result.returncode and self.loaded(name):
            raise ServiceError('bootout failed for ' + self.target(name) + ': ' + result.stderr.strip())
        deadline = time.monotonic() + 30
        while self.loaded(name):
            if time.monotonic() >= deadline:
                raise ServiceError('bootout did not remove ' + self.target(name))
            time.sleep(0.5)
        print('Unloaded ' + self.target(name), flush=True)

    def open_browser(self):
        self.runner(['/usr/bin/open', 'http://127.0.0.1:8787'])


@contextmanager
def lifecycle_lock(state):
    private_directory(state)
    path = Path(state) / 'lifecycle.lock'
    if path.is_symlink():
        raise ServiceError('refusing symlink lifecycle lock')
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ServiceError('ZoeyBot start/stop/install is already in progress; wait for it to finish')
        yield
    finally:
        os.close(descriptor)


def bundle_info(config):
    return dict(CFBundleIdentifier='com.thehound.zoeybot.launcher', CFBundleName='ZoeyBot',
                CFBundleDisplayName='ZoeyBot', CFBundleExecutable='ZoeyBotLauncher',
                CFBundlePackageType='APPL', CFBundleShortVersionString='1.0', CFBundleVersion='1',
                LSMinimumSystemVersion='13.0', LSUIElement=True, NSHighResolutionCapable=True,
                BHLauncherPath=str(Path(config['root']) / 'scripts/local-services.py'), BHRoot=config['root'])


def build_app(config, destination):
    destination = Path(destination).expanduser().absolute()
    if destination.suffix != '.app' or destination.is_symlink():
        raise ServiceError('destination must be a non-symlink .app path')
    info = bundle_info(config)
    if destination.exists():
        existing = destination / 'Contents/Info.plist'
        if not existing.is_file() or plistlib.loads(existing.read_bytes()).get('CFBundleIdentifier') != info['CFBundleIdentifier']:
            raise ServiceError('refusing to replace an unrelated existing application')
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.ZoeyBot-build-', dir=str(destination.parent)))
    app = stage / destination.name
    backup = stage / 'previous.app'
    try:
        contents = app / 'Contents'
        (contents / 'MacOS').mkdir(parents=True)
        (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
        (contents / 'PkgInfo').write_bytes(b'APPL????')
        cache = Path(config['state']) / 'build/module-cache'
        private_directory(cache)
        run_command(['/usr/bin/swiftc', '-O', '-module-cache-path', str(cache),
                     str(Path(config['root']) / 'scripts/ZoeyBotLauncher.swift'), '-o', str(contents / 'MacOS/ZoeyBotLauncher')], timeout=180)
        run_command(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', str(app)])
        run_command(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])
        if destination.exists():
            destination.rename(backup)
        try:
            app.rename(destination)
        except Exception:
            if backup.exists():
                backup.rename(destination)
            raise
        run_command(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(destination)])
        result = run_command([str(destination / 'Contents/MacOS/ZoeyBotLauncher'), '--self-test'])
        if json.loads(result.stdout) != {'launcher': info['BHLauncherPath'], 'root': info['BHRoot'], 'action': 'start --open-browser'}:
            raise ServiceError('installed app self-test did not match this installation')
    finally:
        shutil.rmtree(stage)


def status_report(backend):
    report = {'mode': 'host', 'services': {}}
    for name in SERVICES:
        try:
            report['services'][name] = backend.inspect(name)
        except ServiceError as error:
            report['services'][name] = {'healthy': False, 'error': str(error)}
    report['ready'] = all(value.get('healthy') for value in report['services'].values())
    report['managed'] = all(report['services'][name].get('loaded') for name in ('engine', 'web'))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    install = sub.add_parser('install', help='generate private jobs and compile/sign app; never loads jobs')
    install.add_argument('--app', default=str(Path.home() / 'Applications/ZoeyBot.app'))
    start = sub.add_parser('start', help='start the required per-login services on this Mac')
    start.add_argument('--open-browser', action='store_true')
    sub.add_parser('stop', help='unload only ZoeyBot-owned jobs; leave external services alone')
    status = sub.add_parser('status', help='read-only listener ownership and HTTP health')
    status.add_argument('--check', action='store_true', help='exit nonzero unless every component is healthy')
    status.add_argument('--require-managed', action='store_true', help='also require engine and web to be loaded under owned jobs')
    sub.add_parser('preflight', help='read-only prerequisite and plist checks')
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    os.umask(0o077)
    if args.command == 'install':
        node, ollama = shutil.which('node'), shutil.which('ollama')
        ffmpeg, stt_hermes = shutil.which('ffmpeg'), shutil.which('hermes')
        if not all((node, ollama, ffmpeg, stt_hermes)):
            raise ServiceError('installed node, ollama, ffmpeg and hermes executables must be on PATH during installation')
        config = make_config(root, Path.home(), node, ollama, ffmpeg, stt_hermes)
        with lifecycle_lock(Path(config['state'])):
            install_files(config)
            build_app(config, args.app)
        print('Installed ' + args.app + '; generated private launchd files only. No jobs were loaded.')
        return 0
    config = load_config(root)
    backend = LocalBackend(config)
    if args.command == 'status':
        report = status_report(backend)
        print(json.dumps(report, indent=2))
        return 1 if (args.check and not report['ready']) or (args.require_managed and not report['managed']) else 0
    if args.command == 'preflight':
        backend.preflight()
        print('Prerequisites and private job files verified; no services changed.')
        return 0
    with lifecycle_lock(Path(config['state'])):
        if args.command == 'start':
            start_services(backend, open_browser=args.open_browser)
            print('ZoeyBot ready at http://127.0.0.1:8787')
        else:
            stop_services(backend)
            print('Owned jobs unloaded. External services untouched.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ServiceError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print('ZoeyBot: ' + str(error), file=sys.stderr)
        sys.exit(1)

