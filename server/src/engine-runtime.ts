export interface VmEngineTarget { host: string; port: number; user: string; key: string }

/** Hermes toolsets a bot's API server may be given (from hermes-agent's toolsets.py). `clarify` is useless over the API. */
export const KNOWN_TOOLSETS = [
  'terminal', 'file', 'web', 'browser', 'skills', 'todo', 'memory', 'vision',
  'code_execution', 'delegation', 'chat_history_lookup', 'cronjob', 'image_gen', 'x_search',
  // App-side pseudo toolset: the user's connected apps (Composio) served through the hq MCP server.
  // Not a Hermes toolset; stripped before the config is written, enforced by mcp.ts.
  'apps',
] as const;

/** Toolsets that are policy for this server's own MCP endpoint, not Hermes toolsets. */
export const APP_TOOLSETS = new Set<string>(['apps']);
export const hermesToolsets = (list: string[]) => list.filter((t) => !APP_TOOLSETS.has(t));

/** What a new bot gets on the host when nobody chose otherwise. */
export const DEFAULT_TOOLSETS: string[] = ['terminal', 'file', 'web', 'browser', 'skills', 'todo', 'memory', 'vision', 'apps'];

/** Known toolset names only, de-duplicated, in the given order; an empty result falls back to DEFAULT_TOOLSETS. */
export function validToolsets(list: unknown): string[] {
  const known = new Set<string>(KNOWN_TOOLSETS);
  const out: string[] = [];
  for (const v of Array.isArray(list) ? list : []) {
    if (typeof v !== 'string') continue;
    const name = v.trim();
    if (known.has(name) && !out.includes(name)) out.push(name);
  }
  return out.length ? out : [...DEFAULT_TOOLSETS];
}

/** Host mode: the gateway's tools run on this machine, in the bot's own directory, with the bot's own allowlist. */
export function hostEngineSettings(config: any, opts: { cwd: string; toolsets: string[] }): any {
  return {
    ...config,
    terminal: { ...(config.terminal ?? {}), backend: 'local', cwd: opts.cwd },
    platform_toolsets: { ...(config.platform_toolsets ?? {}), api_server: hermesToolsets(opts.toolsets) },
    // Each bot drives a browser of its own, never the person's signed-in Chrome profile.
    browser: { ...(config.browser ?? {}), use_real_profile: false },
  };
}

/** Ollama's tags endpoint includes speech/embedding models; only completion models belong in chat. */
export async function ollamaChatModels(baseUrl: string, models: string[]): Promise<string[] | null> {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    const supported = await Promise.all(models.map(async (model) => {
      const r = await fetch(`${url.origin}/api/show`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) throw new Error(`Ollama capabilities: ${r.status}`);
      const data = await r.json();
      return Array.isArray(data.capabilities) && data.capabilities.includes('completion') ? model : null;
    }));
    return supported.filter((m): m is string => m !== null);
  } catch { return null; }
}

/** A host-side gateway must not get host shell, browser Python, or desktop tools. */
export function vmEngineSettings(config: any, target: VmEngineTarget): any {
  return {
    ...config,
    terminal: {
      ...(config.terminal ?? {}), backend: 'ssh', cwd: `/home/${target.user}`,
      ssh_host: target.host, ssh_port: target.port, ssh_user: target.user, ssh_key: target.key,
    },
    browser: { ...(config.browser ?? {}), use_real_profile: false },
    // browser_exec executes arbitrary Python on the gateway host even with a remote CDP URL.
    // Until the engine itself moves into the guest, drive its browser through SSH instead.
    platform_toolsets: { ...(config.platform_toolsets ?? {}), api_server: ['terminal', 'file', 'todo'] },
  };
}

/** OpenSSH's first option wins, overriding Hermes' built-in accept-new without editing Hermes. */
export function sshWrapper(tool: 'ssh' | 'scp', knownHosts: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nexec /usr/bin/${tool} -F /dev/null -o ${quote(`UserKnownHostsFile=${knownHosts}`)} -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o ControlMaster=no -o ControlPath=none "$@"\n`;
}
