export interface VmEngineTarget { host: string; port: number; user: string; key: string }

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
