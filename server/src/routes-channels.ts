import { Hono } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { connectedToolkits } from './composio.js';
import { buildChannelsStatus, telegramUsernameFetcher, type ChannelsEnv } from './channels-status.js';

export { buildChannelsStatus, telegramUsernameFetcher } from './channels-status.js';

/**
 * /api/channels: where the person can reach their bots (web, Telegram, Slack) and whether each is set up.
 * Telegram is configured by env; its @username comes from the Bot API's getMe, cached for 10 minutes so
 * the panel can refetch freely. The token is never logged and never part of the response.
 */
const getMe = telegramUsernameFetcher();

export const channelsApi = new Hono<AuthVars>();
channelsApi.use('*', requireUser);

channelsApi.get('/', async (c) => {
  const userId = c.get('user').id;
  const status = await buildChannelsStatus(process.env as ChannelsEnv, {
    getMe,
    // Same per-user Composio check the Apps page uses; one list call, cached nowhere so it reflects a fresh connect.
    slackConnected: async () => (await connectedToolkits(userId)).has('slack'),
  });
  return c.json(status);
});
