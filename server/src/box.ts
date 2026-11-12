import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import { orgo } from './orgo.js';
import { vmBash, displayNumber } from './vm.js';

/**
 * The box: the one Orgo computer every bot works on. When this server runs on that computer
 * (HQ_LOCAL=1) commands and files go straight to the local shell and disk; otherwise they go
 * through Orgo's API to ORGO_COMPUTER_ID.
 */

export interface BashResult { output: string; exit_code: number }

/** Orgo screen id -> X display. The default screen is :99, "screen-100" is :100. */
export const displayFor = (screenId?: string | null) => env.vmBox ? `:${displayNumber(screenId)}` : (!screenId || screenId === 'default' ? ':99' : `:${screenId.replace('screen-', '')}`);

/** Only what a desktop command needs; none of this server's secrets. */
function shellEnv(screenId?: string | null): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    USER: process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    DISPLAY: displayFor(screenId),
  };
}

function localBash(command: string, timeoutSec: number, screenId?: string | null): Promise<BashResult> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env: shellEnv(screenId) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: code });
    });
  });
}

/** A path safe to put inside single quotes in a shell command. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const box = {
  local: env.localBox,

  /** Run a bash command on the box. `screenId` picks which screen's DISPLAY it sees. */
  async bash(command: string, timeoutSec = 60, screenId?: string | null): Promise<BashResult> {
    if (env.vmBox) return vmBash(command, timeoutSec, screenId);
    if (env.localBox) return localBash(command, timeoutSec, screenId);
    if (!env.orgoComputerId) throw new Error('ORGO_COMPUTER_ID is not set');
    const cmd = `export DISPLAY=${displayFor(screenId)}; ${command}`;
    const r = await orgo.bash(env.orgoComputerId, screenId ?? undefined, cmd, timeoutSec);
    return { output: r.output ?? '', exit_code: r.exit_code ?? (r.success ? 0 : 1) };
  },

  async writeFile(file: string, content: string | Buffer, mode = '0644'): Promise<void> {
    if (!/^0?[0-7]{3}$/.test(mode)) throw new Error('Invalid file mode');
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (env.localBox) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, buf);
      await fs.chmod(file, parseInt(mode, 8));
      return;
    }
    // Orgo drops very long commands, so the file goes over in base64 pieces.
    const b64 = buf.toString('base64');
    const tmp = `${file}.b64`;
    const first = await box.bash(`mkdir -p ${q(path.dirname(file))} && : > ${q(tmp)} && echo ok`, 30);
    if (first.exit_code !== 0 || !first.output.includes('ok')) throw new Error(`could not write ${file}: ${first.output.slice(0, 200)}`);
    for (let i = 0; i < b64.length; i += 60000) {
      const part = await box.bash(`printf '%s' '${b64.slice(i, i + 60000)}' >> ${q(tmp)}`, 30);
      if (part.exit_code !== 0) throw new Error(`could not write ${file}: ${part.output.slice(0, 200)}`);
    }
    const done = await box.bash(`base64 -d ${q(tmp)} > ${q(file)} && rm -f ${q(tmp)} && chmod ${mode} ${q(file)} && echo ok`, 30);
    if (done.exit_code !== 0 || !done.output.includes('ok')) throw new Error(`could not write ${file}: ${done.output.slice(0, 200)}`);
  },

  /** Read a file from the box, or null if it isn't there. Meant for small files (under ~4 MB). */
  async readFile(file: string): Promise<Buffer | null> {
    if (env.localBox) {
      try { return await fs.readFile(file); } catch { return null; }
    }
    const r = await box.bash(`[ -f ${q(file)} ] && base64 -w0 ${q(file)} || echo __missing__`, 60);
    if (r.exit_code !== 0) throw new Error(`could not read ${file}: ${r.output.slice(0, 300)}`);
    const out = r.output.trim();
    if (!out || out.endsWith('__missing__')) return null;
    return Buffer.from(out, 'base64');
  },

  /** Confined Library download, checked on the guest (never against the Mac filesystem). */
  async readConfinedFile(root: string, relative: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer | null> {
    const code = [
      'import os, sys, base64',
      `root = os.path.realpath(${JSON.stringify(root)})`,
      `file = os.path.realpath(os.path.join(root, ${JSON.stringify(relative)}))`,
      "if not file.startswith(root + os.sep) or not os.path.isfile(file):",
      "    print('__missing__'); sys.exit(0)",
      "with open(file, 'rb') as f:",
      `    data = f.read(${Math.floor(maxBytes) + 1})`,
      `if len(data) > ${Math.floor(maxBytes)}: raise RuntimeError('file too large for local download')`,
      "print(base64.b64encode(data).decode())",
    ].join('\n');
    const r = await box.bash(`python3 -c ${q(code)}`, 60);
    if (r.exit_code !== 0) throw new Error(r.output.trim().slice(-300));
    if (r.output.trim() === '__missing__') return null;
    return Buffer.from(r.output.trim(), 'base64');
  },

  quote: q,
};
