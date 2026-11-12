import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The Telegram channel against a temp DB and a fake Bot API: getMe, getUpdates and sendMessage are
 * answered by a fetch stub, enqueueAndWait is a stub that records the trigger, so nothing touches
 * the network or an engine. Every probe runs in its own process (telegram.ts holds module state).
 */

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XAI_|COMPOSIO_|ORGO_|HQ_|SESSION_SECRET|DB_PATH|TELEGRAM_)/.test(k)));

function probe(code: string, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-tg-'));
  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', SETUP + code], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000,
      env: {
        ...cleanEnv(), SESSION_SECRET: 'test-only', DB_PATH: path.join(dir, 'test.db'), HQ_VM: '0', HQ_LOCAL: '0',
        XAI_API_KEY: 'test', COMPOSIO_API_KEY: 'test', ORGO_API_KEY: 'test',
        TELEGRAM_BOT_TOKEN: '42:secret-token', TELEGRAM_ALLOWED_CHAT_IDS: '111, 222', ...env,
      },
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!(r.stdout + r.stderr).includes('secret-token'), 'the token must never be logged');
    return r.stdout + r.stderr;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A primary bot, a fake Bot API and a fake turn queue.
const SETUP = `
  import assert from 'node:assert/strict';
  const { db } = await import('./server/src/db.ts');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','test@localhost','Test',0);
  db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('zoey','u','Zoey','primary',0,0);
  db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('mw','u','Market Watch','managed',0,0);
  const tg = await import('./server/src/telegram.ts');
  const calls = [];            // every Bot API call: { method, body }
  const sent = [];             // sendMessage bodies
  let batches = [];            // getUpdates answers, consumed in order; afterwards the call waits for abort
  let getUpdatesCalls = 0;
  let sendStatus = 200;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  tg.telegramDeps.fetch = async (url, init) => {
    const u = String(url);
    assert.ok(u.startsWith('https://api.telegram.org/bot42:secret-token/'), 'calls go to the Bot API with the token');
    const method = u.split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    if (method === 'getMe') return json({ ok: true, result: { username: 'zoey_test_bot' } });
    if (method === 'sendMessage') { sent.push(body); return json({ ok: true, result: {} }, sendStatus); }
    if (method === 'getUpdates') {
      getUpdatesCalls++;
      if (batches.length) return json({ ok: true, result: batches.shift() });
      await new Promise((r) => init.signal.addEventListener('abort', r, { once: true }));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    throw new Error('unexpected method ' + method);
  };
  const triggers = [];
  let replyWith = async () => 'Hi from Zoey';
  tg.telegramDeps.enqueueAndWait = async (botId, trigger) => { triggers.push({ botId, trigger }); return replyWith(); };
  const rows = (botId) => db.prepare('SELECT kind, body FROM rows WHERE bot_id=? ORDER BY seq').all(botId).map((r) => ({ kind: r.kind, ...JSON.parse(r.body) }));
  const settle = async (pred, ms = 5000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } };
  const msg = (update_id, chatId, text) => ({ update_id, message: { message_id: update_id, text, chat: { id: chatId } } });
  tg.telegramDeps.backoffMinMs = 5; tg.telegramDeps.backoffMaxMs = 20; tg.telegramDeps.pollTimeoutSec = 1;
`;

test('inbound: an allowlisted chat message becomes a user row on Zoey, runs a user turn and gets the reply back', () => {
  const out = probe(`
    batches = [[msg(10, 111, 'What is on today?')]];
    const loop = tg.startTelegramPolling();
    assert.ok(loop, 'polling starts when a token is set');
    assert.equal(tg.isTelegramPolling(), true);
    await settle(() => sent.length >= 1);
    assert.deepEqual(rows('zoey'), [{ kind: 'message', type: 'message', role: 'user', text: 'What is on today?', via: 'telegram' }]);
    assert.deepEqual(triggers, [{ botId: 'zoey', trigger: { type: 'user', text: 'What is on today?' } }]);
    assert.deepEqual(sent, [{ chat_id: '111', text: 'Hi from Zoey', disable_web_page_preview: true }]);
    assert.equal(calls[0].method, 'getMe');
    const poll = calls.find((c) => c.method === 'getUpdates');
    assert.equal(poll.body.timeout, 1);
    assert.deepEqual(poll.body.allowed_updates, ['message']);
    await tg.stopTelegramPolling();
    assert.equal(tg.isTelegramPolling(), false);
    console.log('ok');
  `);
  assert.match(out, /ok/);
});

test('inbound: /start is answered with the connect line and runs no turn; a failing turn reports the error', () => {
  probe(`
    batches = [[msg(1, 222, '/start')], [msg(2, 222, 'boom')]];
    replyWith = async () => { throw new Error('engine exploded'); };
    tg.startTelegramPolling();
    await settle(() => sent.length >= 2);
    assert.equal(sent[0].text, 'Connected to ZoeyBot. Messages here go to Zoey.');
    assert.equal(sent[1].text, 'Zoey hit an error: engine exploded');
    assert.equal(triggers.length, 1);
    assert.equal(rows('zoey').length, 1, '/start writes no row; the failing message does');
    await tg.stopTelegramPolling();
  `);
});

test('inbound: a message from a chat outside the allowlist is ignored (no row, no send) but counted', () => {
  probe(`
    batches = [[msg(5, 999, 'let me in'), { update_id: 6, message: { message_id: 6, chat: { id: 111 }, sticker: {} } }]];
    tg.startTelegramPolling();
    // The second getUpdates call means the first batch was processed (messages run sequentially).
    await settle(() => getUpdatesCalls >= 2);
    assert.deepEqual(rows('zoey'), []);
    assert.deepEqual(sent, []);
    assert.deepEqual(triggers, []);
    assert.equal(tg.telegramStats.ignored, 1);
    assert.equal(tg.telegramStats.handled, 0);
    await tg.stopTelegramPolling();
  `);
});

test('inbound: the offset advances past the batch, is persisted in kv and is sent with the next getUpdates', () => {
  probe(`
    assert.equal(tg.readTelegramOffset(), null);
    batches = [[msg(100, 111, 'a'), msg(101, 111, 'b')]];
    tg.startTelegramPolling();
    await settle(() => getUpdatesCalls >= 2);
    assert.equal(tg.readTelegramOffset(), 102);
    assert.equal(db.prepare("SELECT value FROM kv WHERE key='telegram.offset'").get().value, '102');
    const polls = calls.filter((c) => c.method === 'getUpdates');
    assert.equal(polls[0].body.offset, undefined, 'a fresh install asks for everything pending');
    assert.equal(polls[1].body.offset, 102);
    assert.equal(triggers.length, 2);
    assert.deepEqual(triggers.map((t) => t.trigger.text), ['a', 'b']);
    await tg.stopTelegramPolling();
  `);
});

test('polling does not start without a token; with a token but no allowlist it logs the setup hint', () => {
  const out = probe(`
    assert.equal(tg.startTelegramPolling(), null);
    assert.equal(tg.isTelegramPolling(), false);
    process.env.TELEGRAM_BOT_TOKEN = '42:secret-token';
    tg.startTelegramPolling();
    await settle(() => getUpdatesCalls >= 1);
    await tg.stopTelegramPolling();
  `, { TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_CHAT_IDS: '' });
  assert.match(out, /\[telegram\] token set but no allowlisted chats; inbound ignored until TELEGRAM_ALLOWED_CHAT_IDS is set/);
});

test('isUrgent: first non-empty line must start with the word URGENT', () => {
  probe(`
    assert.equal(tg.isUrgent('URGENT: NVDA down 12% premarket'), true);
    assert.equal(tg.isUrgent('**URGENT** margin call risk'), true);
    assert.equal(tg.isUrgent('\\n urgent - x'), true);
    assert.equal(tg.isUrgent('Nothing urgent today'), false);
    assert.equal(tg.isUrgent('Digest\\nURGENT later'), false);
    assert.equal(tg.isUrgent('URGENTLY not'), false);
    assert.equal(tg.isUrgent(''), false);
  `);
});

test('notifyUrgent: forwards to every allowlisted chat only when urgent and notifications are on', () => {
  probe(`
    await tg.notifyUrgent('mw', 'Quotes', 'All quiet.');
    assert.deepEqual(sent, []);
    await tg.notifyUrgent('mw', 'Quotes', 'URGENT: NVDA -12%\\nSell signal fired.');
    assert.deepEqual(sent.map((s) => s.chat_id).sort(), ['111', '222']);
    for (const s of sent) assert.equal(s.text, '⚠️ Market Watch · Quotes\\nURGENT: NVDA -12%\\nSell signal fired.');
    sent.length = 0;
    process.env.TELEGRAM_NOTIFICATIONS = '0';
    await tg.notifyUrgent('mw', 'Quotes', 'URGENT: again');
    assert.deepEqual(sent, [], 'TELEGRAM_NOTIFICATIONS=0 silences alerts');
    process.env.TELEGRAM_NOTIFICATIONS = '1';
    // Over-long alerts are cut to one message with an ellipsis.
    await tg.notifyUrgent('mw', 'Quotes', 'URGENT ' + 'x'.repeat(6000));
    assert.equal(sent.length, 2);
    assert.ok(sent[0].text.length <= 4000 && sent[0].text.endsWith('…'));
  `);
});

test('the loop hook: a routine turn calls afterRoutine, which notifyUrgent is wired into by installTelegramHooks', () => {
  probe(`
    const loop = await import('./server/src/agent/loop.ts');
    tg.installTelegramHooks();
    assert.equal(typeof loop.turnHooks.afterRoutine, 'function');
    loop.turnHooks.afterRoutine('mw', 'Quotes', 'URGENT: test');
    await settle(() => sent.length >= 2);
    assert.equal(sent[0].text, '⚠️ Market Watch · Quotes\\nURGENT: test');
  `);
});

test('sendTelegram: long text is chunked at 4000 chars, failures are logged by status only', () => {
  const out = probe(`
    const ok = await tg.sendTelegram('111', 'line\\n'.repeat(1700));
    assert.equal(ok, true);
    assert.ok(sent.length >= 3, 'got ' + sent.length + ' chunks');
    for (const s of sent) { assert.ok(s.text.length <= 4000); assert.equal(s.chat_id, '111'); assert.equal(s.parse_mode, undefined); }
    assert.equal(sent.map((s) => s.text.replace(/\\n$/, '')).join('\\n').length, ('line\\n'.repeat(1700)).trimEnd().length);
    sent.length = 0; sendStatus = 403;
    assert.equal(await tg.sendTelegram('111', 'hello'), false);
  `);
  assert.match(out, /\[telegram\] send failed 403/);
});
