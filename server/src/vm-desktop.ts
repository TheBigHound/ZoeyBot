import fs from 'node:fs';
import { vmBash, displayNumber } from './vm.js';
import type { OrgoComputer, OrgoScreen } from './orgo.js';

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
type Runner = typeof vmBash;
/** Keep the Orgo-shaped interface so all existing computer/MCP/UI callers select the same backend. */
export function createVmBackend(run: Runner = vmBash) {
  async function action<T = any>(op: string, screen?: string, body?: unknown): Promise<T> {
    displayNumber(screen);
    const source = fs.readFileSync(new URL('../box/vm-desktop.py', import.meta.url), 'utf8');
    const request = Buffer.from(JSON.stringify({ op, screen, body })).toString('base64');
    const r = await run(`python3 -c ${quote(source)} ${quote(request)}`, 60, screen);
    if (r.exit_code !== 0) throw new Error(`Local VM ${op} failed: ${r.output.trim().slice(-1000)}`);
    try { return JSON.parse(r.output); } catch { throw new Error(`Local VM ${op} returned invalid JSON: ${r.output.slice(-300)}`); }
  }
  return {
    workspaces: async () => { throw new Error('Orgo workspaces are unavailable in local VM mode'); },
    getComputer: (_id: string) => action<OrgoComputer>('computer'),
    start: (_id: string) => action('computer'),
    resume: (_id: string) => action('computer'),
    suspend: async (_id: string) => { throw new Error('ZoeyBot never suspends the local VM; manage it in UTM'); },
    vncPassword: async (_id: string) => ({ password: '', desktop_api_token: '' }), // loopback guest VNC uses RFB None security
    listScreens: (_id: string) => action<OrgoScreen[]>('list'),
    createScreen: (_id: string) => action<OrgoScreen>('create'),
    getScreen: (_id: string, screen: string) => action<OrgoScreen>('screen', screen),
    deleteScreen: (_id: string, screen: string) => action<void>('delete', screen),
    screenshot: (_id: string, screen?: string) => action<{ image: string; mime_type?: string; width: number; height: number }>('screenshot', screen),
    click: (_id: string, screen: string | undefined, body: { x: number; y: number; button?: string; double?: boolean }) => action('click', screen, body),
    move: (_id: string, screen: string | undefined, body: { x: number; y: number }) => action('move', screen, body),
    drag: (_id: string, screen: string | undefined, body: { start_x: number; start_y: number; end_x: number; end_y: number }) => action('drag', screen, body),
    type: (_id: string, screen: string | undefined, text: string) => action('type', screen, { text }),
    key: (_id: string, screen: string | undefined, key: string) => action('key', screen, { key }),
    scroll: (_id: string, screen: string | undefined, body: { x: number; y: number; direction: 'up' | 'down'; amount: number }) => action('scroll', screen, body),
    bash: async (_id: string, screen: string | undefined, command: string, timeout = 120) => {
      const r = await run(command, timeout, screen);
      return { ...r, success: r.exit_code === 0 };
    },
    exportFile: async (_id: string, _path: string): Promise<{ url?: string }> => { throw new Error('Cloud file exports are unavailable in local VM mode; download from the Library'); },
  };
}
export const vmDesktop = createVmBackend();
