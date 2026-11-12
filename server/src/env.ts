import os from 'node:os';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const hermesHome = process.env.HERMES_HOME_PRIMARY ?? path.join(os.homedir(), '.hermes');

/**
 * Host mode (HQ_HOST=1): every bot's Hermes gateway runs on this macOS host, one home per bot. It is
 * the only supported way to run the product; `scripts/local-services.py` sets the flag. The server
 * binds to loopback and the email-only sign-in is implied.
 */
const hostMode = process.env.HQ_HOST === '1';

export const env = {
  hostMode,
  hostname: hostMode ? '127.0.0.1' : (process.env.HOST ?? '0.0.0.0'),
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  /** Optional: the x_search tool and xAI voice only work when it is set. */
  xaiKey: process.env.XAI_API_KEY ?? '',
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  /** Optional: connected apps (Composio) are off without it. */
  composioKey: process.env.COMPOSIO_API_KEY ?? '',
  sessionSecret: req('SESSION_SECRET'),
  devLogin: hostMode || process.env.DEV_LOGIN === '1',
  dbPath: process.env.DB_PATH ?? new URL('../../data/zoeybot.db', import.meta.url).pathname,

  // ---- Hermes engine ----
  /** The `hermes` CLI used to start a gateway for each extra bot. */
  hermesBin: process.env.HERMES_BIN ?? 'hermes',
  /** The primary bot's Hermes home and API server (an agent that already runs; never restarted by us). */
  hermesHome,
  hermesUrl: (process.env.HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/+$/, ''),
  hermesKey: process.env.HERMES_KEY ?? '',
  /** Where each extra bot's own Hermes home lives. Must be outside ~/.hermes so it is a separate tenant. */
  enginesDir: process.env.ENGINES_DIR ?? new URL('../../data/engines', import.meta.url).pathname,
  enginePortBase: Number(process.env.ENGINE_PORT_BASE ?? 8650),
  /** URL the Hermes gateways use to reach this server's MCP endpoint. */
  mcpBaseUrl: (process.env.MCP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/+$/, ''),
  /** Extra MCP servers every managed bot gets, as a JSON object of Hermes `mcp_servers` entries (e.g. X's XMCP). */
  extraMcpServers: process.env.EXTRA_MCP_SERVERS ?? '',
  primaryBotName: process.env.PRIMARY_BOT_NAME ?? 'Doug',
  primaryBotLabel: process.env.PRIMARY_BOT_LABEL ?? 'Chief of Staff',

  /** Comma-separated emails allowed to sign in; empty = anyone who can reach the app. */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};
