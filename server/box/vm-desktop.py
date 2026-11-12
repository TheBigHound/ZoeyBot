#!/usr/bin/env python3
"""Loopback-only X11 desktops for the dedicated Bot HQ guest. Invoked via SSH.
No HTTP daemon, credentials or exposed control API. Standard library only.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

ROOT = Path('/run/bot-hq')
WIDTH, HEIGHT = 1440, 900


def number(screen=None):
    if screen in (None, '', 'default'):
        return 99
    if screen not in ('screen-100', 'screen-101', 'screen-102'):
        raise ValueError('Unknown VM screen: %s' % screen)
    return int(screen[7:])


def descriptor(n):
    return dict(id='default' if n == 99 else 'screen-%s' % n,
                display=':%s' % n, width=WIDTH, height=HEIGHT, default=n == 99)


def run(args, n=99, data=None):
    # xclip forks a long-lived clipboard owner: it must not inherit communicate()'s
    # capture pipes, otherwise the parent waits for EOF until the 30s timeout.
    sink = subprocess.DEVNULL if args[0] == 'xclip' else subprocess.PIPE
    r = subprocess.run(args, input=data, stdout=sink, stderr=sink,
                       env=dict(os.environ, DISPLAY=':%s' % n), timeout=30)
    if r.returncode:
        raise RuntimeError((r.stderr or b'').decode(errors='replace').strip() or '%s failed' % args[0])
    return r.stdout or b''


def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), .2):
            return True
    except OSError:
        return False


def launch(n, name, args):
    log = open(ROOT / ('%s-%s.log' % (n, name)), 'ab')
    p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         env=dict(os.environ, DISPLAY=':%s' % n), start_new_session=True)
    log.close()
    (ROOT / ('%s-%s.pid' % (n, name))).write_text(str(p.pid))
    return p


def wait_for(predicate, message):
    for _ in range(80):
        if predicate():
            return
        time.sleep(.1)
    raise RuntimeError(message)


def ensure(n):
    display = ':%s' % n
    if not Path('/tmp/.X11-unix/X%s' % n).exists():
        launch(n, 'xvfb', ['Xvfb', display, '-screen', '0', '%sx%sx24' % (WIDTH, HEIGHT), '-nolisten', 'tcp', '-ac'])
        wait_for(lambda: Path('/tmp/.X11-unix/X%s' % n).exists(), 'Xvfb did not start; see /run/bot-hq logs')
    # Verify the display actually answers, not just a stale socket.
    run(['xdpyinfo', '-display', display], n)
    wm = ROOT / ('%s-openbox.pid' % n)
    alive = False
    if wm.exists():
        try:
            os.kill(int(wm.read_text()), 0)
            alive = True
        except (ValueError, OSError):
            pass
    if not alive:
        launch(n, 'openbox', ['openbox', '--sm-disable'])
    if not port_open(5900 + n):
        launch(n, 'vnc', ['x11vnc', '-display', display, '-rfbport', str(5900 + n), '-localhost',
                          '-forever', '-shared', '-nopw', '-xkb', '-noxdamage'])
        wait_for(lambda: port_open(5900 + n), 'x11vnc did not start; see /run/bot-hq logs')
    if not port_open(6000 + n):
        launch(n, 'websockify', ['websockify', '127.0.0.1:%s' % (6000 + n), '127.0.0.1:%s' % (5900 + n)])
        wait_for(lambda: port_open(6000 + n), 'websockify did not start; see /run/bot-hq logs')
    (ROOT / ('%s.screen' % n)).touch()
    return descriptor(n)


def key_name(key):
    aliases = {'CTRL': 'ctrl', 'CONTROL': 'ctrl', 'CMD': 'Super', 'META': 'Super', 'ALT': 'alt',
               'SHIFT': 'shift', 'ENTER': 'Return', 'RETURN': 'Return', 'ESC': 'Escape',
               'ESCAPE': 'Escape', 'SPACE': 'space', 'BACKSPACE': 'BackSpace', 'DELETE': 'Delete',
               'TAB': 'Tab', 'UP': 'Up', 'DOWN': 'Down', 'LEFT': 'Left', 'RIGHT': 'Right',
               'PAGEUP': 'Prior', 'PAGEDOWN': 'Next', 'HOME': 'Home', 'END': 'End'}
    # Chord spelling is case-insensitive; Shift must be explicit, not inferred
    # from a model's conventional CTRL+A capitalization.
    return '+'.join(aliases.get(k.upper(), k.lower() if len(k) == 1 else k) for k in key.split('+'))


def action(req):
    op, n = req['op'], number(req.get('screen'))
    if op not in ('computer', 'list', 'create', 'delete', 'screen', 'screenshot', 'move', 'click', 'drag', 'type', 'key', 'scroll'):
        raise ValueError('Unknown desktop operation: %s' % op)
    b = req.get('body') or {}
    if op == 'computer':
        ensure(99)
        return dict(id='utm-local', name='Local UTM VM', status='running', resolution='%sx%s' % (WIDTH, HEIGHT))
    if op == 'list':
        ensure(99)
        return [ensure(i) for i in range(99, 103) if (ROOT / ('%s.screen' % i)).exists()]
    if op == 'create':
        ensure(99)
        for i in range(100, 103):
            if not (ROOT / ('%s.screen' % i)).exists():
                return ensure(i)
        raise RuntimeError('Every screen on the VM is in use (4 at most)')
    if op == 'delete':
        if n == 99:
            raise ValueError('Cannot delete the default screen')
        for name in ('websockify', 'vnc', 'openbox', 'xvfb'):
            pid = ROOT / ('%s-%s.pid' % (n, name))
            if pid.exists():
                try:
                    p = int(pid.read_text())
                    # Do not kill a PID reused by another process after a restart.
                    cmd = Path('/proc/%s/cmdline' % p).read_bytes()
                    expected = {'vnc': b'x11vnc', 'xvfb': b'Xvfb'}.get(name, name.encode())
                    if expected in cmd:
                        os.killpg(p, signal.SIGTERM)
                except (OSError, ValueError):
                    pass
                pid.unlink(missing_ok=True)
        (ROOT / ('%s.screen' % n)).unlink(missing_ok=True)
        return None
    ensure(n)
    if op == 'screen':
        return descriptor(n)
    if op == 'screenshot':
        image = run(['import', '-display', ':%s' % n, '-window', 'root', '-quality', '75', 'jpeg:-'], n)
        return dict(image=base64.b64encode(image).decode(), mime_type='image/jpeg', width=WIDTH, height=HEIGHT)
    def xy(x, y):
        x, y = int(x), int(y)
        if not (0 <= x < WIDTH and 0 <= y < HEIGHT):
            raise ValueError('Coordinates outside the desktop')
        return [str(x), str(y)]
    if op in ('move', 'click', 'scroll'):
        run(['xdotool', 'mousemove', '--sync'] + xy(b['x'], b['y']), n)
    if op == 'click':
        button = {'left': '1', 'middle': '2', 'right': '3'}.get(b.get('button', 'left'))
        if button is None:
            raise ValueError('Unknown mouse button')
        run(['xdotool', 'click', '--repeat', '2' if b.get('double') else '1', '--delay', '100', button], n)
    elif op == 'drag':
        run(['xdotool', 'mousemove', '--sync'] + xy(b['start_x'], b['start_y']) + ['mousedown', '1', 'mousemove', '--sync'] + xy(b['end_x'], b['end_y']) + ['mouseup', '1'], n)
    elif op == 'type':
        run(['xclip', '-selection', 'clipboard'], n, str(b['text']).encode())
        run(['xdotool', 'key', '--clearmodifiers', 'ctrl+v'], n)
    elif op == 'key':
        run(['xdotool', 'key', '--clearmodifiers', '--', key_name(b['key'])], n)
    elif op == 'scroll':
        if b['direction'] not in ('up', 'down'):
            raise ValueError('Unknown scroll direction')
        amount = max(1, min(100, int(b['amount'])))
        run(['xdotool', 'click', '--repeat', str(amount), '--delay', '20', '4' if b['direction'] == 'up' else '5'], n)
    elif op != 'move' and op != 'click':
        raise ValueError('Unknown desktop operation: %s' % op)
    return {'success': True}


if __name__ == '__main__':
    ROOT.mkdir(parents=True, exist_ok=True)
    with open(ROOT / 'lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        print(json.dumps(action(json.loads(base64.b64decode(sys.argv[1])))))
