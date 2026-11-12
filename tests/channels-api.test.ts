import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChannelsStatus, telegramUsernameFetcher } from '../server/src/channels-status.ts';

// The /api/channels status is built from env + a getMe lookup; these tests inject both so nothing touches the network.

test('channels status: nothing configured', async () => {
  const s = await buildChannelsStatus({}, { getMe: async () => { throw new Error('must not be called'); }, slackConnected: async () => false });
  assert.deepEqual(s, {
    web: { connected: true },
    telegram: { configured: false, chatAllowlisted: false, allowlistedCount: 0, notifications: true, polling: false },
    slack: { connected: false },
  });
});

test('channels status: telegram configured, username from getMe, allowlist + notifications from env', async () => {
  let seen = '';
  const s = await buildChannelsStatus(
    { TELEGRAM_BOT_TOKEN: '123:secret', TELEGRAM_ALLOWED_CHAT_IDS: '1, 2', TELEGRAM_NOTIFICATIONS: '0' },
    { getMe: async (t) => { seen = t; return 'zoey_hq_bot'; }, slackConnected: async () => true, polling: () => true },
  );
  assert.equal(seen, '123:secret');
  assert.deepEqual(s.telegram, { configured: true, username: 'zoey_hq_bot', chatAllowlisted: true, allowlistedCount: 2, notifications: false, polling: true });
  assert.equal(s.slack.connected, true);
  assert.ok(!JSON.stringify(s).includes('secret'), 'token must never appear in the response');
});

test('channels status: getMe failure leaves username out; slack failure reads as not connected', async () => {
  const s = await buildChannelsStatus(
    { TELEGRAM_BOT_TOKEN: 'abc', TELEGRAM_ALLOWED_CHAT_IDS: '' },
    { getMe: async () => { throw new Error('timeout'); }, slackConnected: async () => { throw new Error('composio down'); } },
  );
  assert.deepEqual(s.telegram, { configured: true, chatAllowlisted: false, allowlistedCount: 0, notifications: true, polling: false });
  assert.equal(s.slack.connected, false);
});

test('telegram getMe fetcher caches per token for the ttl and never logs the token', async () => {
  let calls = 0; let now = 0;
  const fetchImpl = (async (url: string | URL) => {
    calls++;
    assert.match(String(url), /\/bottok-1\/getMe$/);
    return { ok: true, json: async () => ({ ok: true, result: { username: 'zoey_bot' } }) };
  }) as unknown as typeof fetch;
  const getMe = telegramUsernameFetcher({ fetchImpl, ttlMs: 1000, now: () => now });
  assert.equal(await getMe('tok-1'), 'zoey_bot');
  assert.equal(await getMe('tok-1'), 'zoey_bot');
  assert.equal(calls, 1, 'second call within ttl is served from cache');
  now = 1500;
  assert.equal(await getMe('tok-1'), 'zoey_bot');
  assert.equal(calls, 2, 'refetches after ttl');
});

test('telegram getMe fetcher: bad responses resolve to undefined (no throw to the route)', async () => {
  const bad = (async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) })) as unknown as typeof fetch;
  const getMe = telegramUsernameFetcher({ fetchImpl: bad, ttlMs: 1000 });
  assert.equal(await getMe('x'), undefined);
});
