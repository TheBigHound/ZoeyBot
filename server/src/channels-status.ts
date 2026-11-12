import type { ChannelsStatus } from './types.js';

/**
 * Pure pieces behind /api/channels, kept free of server imports so they can be unit tested without env.
 * The Telegram bot token never leaves this module: it is not logged and not part of the response.
 */

export interface ChannelsEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  TELEGRAM_NOTIFICATIONS?: string;
}

export interface ChannelsDeps {
  /** Resolve the bot's @username for a token; may throw or resolve undefined. */
  getMe: (token: string) => Promise<string | undefined>;
  /** Whether this user has a Slack connection; may throw. */
  slackConnected: () => Promise<boolean>;
}

/** env + injected lookups → ChannelsStatus. Lookups fail soft. */
export async function buildChannelsStatus(env: ChannelsEnv, deps: ChannelsDeps): Promise<ChannelsStatus> {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const configured = token.length > 0;
  const allow = (env.TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const [username, slack] = await Promise.all([
    configured ? deps.getMe(token).catch(() => undefined) : Promise.resolve(undefined),
    deps.slackConnected().catch(() => false),
  ]);
  return {
    web: { connected: true },
    telegram: {
      configured,
      ...(username ? { username } : {}),
      chatAllowlisted: allow.length > 0,
      notifications: env.TELEGRAM_NOTIFICATIONS !== '0',
    },
    slack: { connected: slack },
  };
}

const GETME_TTL_MS = 10 * 60 * 1000;
const GETME_TIMEOUT_MS = 5000;

/** getMe with a per-token cache. Failures resolve to undefined and are retried on the next call after the ttl. */
export function telegramUsernameFetcher(opts: { fetchImpl?: typeof fetch; ttlMs?: number; timeoutMs?: number; now?: () => number } = {}) {
  const { fetchImpl = fetch, ttlMs = GETME_TTL_MS, timeoutMs = GETME_TIMEOUT_MS, now = Date.now } = opts;
  const cache = new Map<string, { at: number; username: string | undefined; pending?: Promise<string | undefined> }>();
  return async (token: string): Promise<string | undefined> => {
    const hit = cache.get(token);
    if (hit?.pending) return hit.pending;
    if (hit && now() - hit.at < ttlMs) return hit.username;
    const pending = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, { signal: ctrl.signal });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
        return body.ok && typeof body.result?.username === 'string' ? body.result.username : undefined;
      } catch {
        // Deliberately no logging: an error message could carry the request URL, which contains the token.
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    })();
    cache.set(token, { at: now(), username: hit?.username, pending });
    const username = await pending;
    // A failed lookup is cached too, so a down Bot API costs at most one request per ttl.
    cache.set(token, { at: now(), username });
    return username;
  };
}
