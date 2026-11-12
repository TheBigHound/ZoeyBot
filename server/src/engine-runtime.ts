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
