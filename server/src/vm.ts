import { execFile } from 'node:child_process';
import { env } from './env.js';

const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
/** Reject cross-site control and DNS rebinding against the local-only app. */
export function isLocalRequest(host: string | undefined, origin: string | undefined): boolean {
  try {
    if (!host || !loopback(new URL(`http://${host}`).hostname)) return false;
    if (!origin) return true; // native/CLI clients
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && loopback(url.hostname);
  } catch { return false; }
}

/** Commands run as root inside the dedicated guest, never on the Mac. */
export function displayNumber(screen?: string | null): number {
  if (!screen || screen === 'default') return 99;
  if (!/^screen-(100|101|102)$/.test(screen)) throw new Error(`Unknown VM screen: ${screen}`);
  return Number(screen.slice(7));
}
export const vncUrlFor = (screen?: string | null) => `ws://127.0.0.1:${6000 + displayNumber(screen)}`;
export function sshArgs(): string[] {
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.vmHost)) throw new Error('HQ_VM_HOST must be loopback');
  if (!/^[a-z_][a-z0-9_-]*$/i.test(env.vmUser)) throw new Error('Invalid HQ_VM_USER');
  if (!Number.isInteger(env.vmPort) || env.vmPort < 1 || env.vmPort > 65535) throw new Error('Invalid HQ_VM_PORT');
  return ['-T', '-p', String(env.vmPort), '-i', env.vmKey, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=8', '-o', `UserKnownHostsFile=${env.vmKnownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', `${env.vmUser}@${env.vmHost}`];
}
export function remoteCommand(screen?: string | null): string {
  return `sudo -n env -i HOME=/root USER=root LANG=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DISPLAY=:${displayNumber(screen)} bash --noprofile --norc -s`;
}
export function vmBash(command: string, timeoutSec = 60, screen?: string | null): Promise<{ output: string; exit_code: number }> {
  const args = [...sshArgs(), remoteCommand(screen)];
  return new Promise((resolve) => {
    const child = execFile('ssh', args, { timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' } }, (err, stdout, stderr) => {
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0 });
    });
    child.stdin?.on('error', () => {}); // SSH can fail before consuming stdin.
    child.stdin?.end(command + '\n');
  });
}
