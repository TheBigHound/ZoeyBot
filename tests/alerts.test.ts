import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * URGENT alerts: the afterRoutine hook (installed by installAlertHooks) forwards an URGENT routine
 * reply to Telegram through a fake Bot API, records exactly one alert row, and the dashboard reads
 * and dismisses it over GET /api/alerts and POST /api/alerts/:id/dismiss. Runs in a child process
 * (env.ts reads its keys at import; telegram.ts holds module state) with an in-memory database.
 */

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XAI_|COMPOSIO_|ORGO_|HQ_|SESSION_SECRET|DB_PATH|TELEGRAM_|ZOEYBOT_)/.test(k)));

function probe(code: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', SETUP + code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000,
    env: {
      ...cleanEnv(), HQ_HOST: '1', SESSION_SECRET: 'test-only', DB_PATH: ':memory:', TMPDIR: process.env.TMPDIR ?? '/tmp',
      TELEGRAM_BOT_TOKEN: '42:secret-token', TELEGRAM_ALLOWED_CHAT_IDS: '111', ...env,
    },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!(r.stdout + r.stderr).includes('secret-token'), 'the token must never be logged');
  return r.stdout + r.stderr;
}

// Two users with a bot each, a fake Bot API, a signed-in request helper and an SSE spy on the hub.
const SETUP = `
  import assert from 'node:assert/strict';
  const { db } = await import('./server/src/db.ts');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','test@localhost','Test',0);
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('other','other@localhost','Other',0);
  db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('mw','u','Market Watch','managed',0,0);
  db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('ob','other','Other Bot','managed',0,0);
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('tok-u','u',0,Date.now()+3600000);
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('tok-o','other',0,Date.now()+3600000);
  const tg = await import('./server/src/telegram.ts');
  const sent = [];
  tg.telegramDeps.fetch = async (url, init) => {
    const u = String(url);
    assert.ok(u.startsWith('https://api.telegram.org/bot42:secret-token/'));
    const method = u.split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    if (method === 'sendMessage') { sent.push(body); return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    throw new Error('unexpected method ' + method);
  };
  const alerts = await import('./server/src/alerts.ts');
  const loop = await import('./server/src/agent/loop.ts');
  const { hub } = await import('./server/src/lib/hub.ts');
  const events = [];
  hub.subscribe('u', (ev) => events.push(ev));
  const { api } = await import('./server/src/routes.ts');
  const call = async (path, init = {}, token = 'tok-u') => {
    const res = await api.request(path, { ...init, headers: { cookie: 'zoeybot_session=' + token, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json() };
  };
  const settle = async (pred, ms = 5000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } };
`;

test('afterRoutine: only an URGENT reply becomes an alert, delivered to Telegram, listed, dismissed, served by the API', () => {
  const out = probe(`
    alerts.installAlertHooks();
    assert.equal(typeof loop.turnHooks.afterRoutine, 'function');
    loop.turnHooks.afterRoutine('mw', 'Quotes', 'All quiet today.');
    loop.turnHooks.afterRoutine('mw', 'Quotes', '**URGENT**: NVDA -12%\\nSell signal fired.');
    await settle(() => events.some((e) => e.type === 'alerts'));
    // Exactly one row, delivered to the one allowlisted chat, with the whole text.
    const rows = db.prepare('SELECT * FROM alerts').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bot_id, 'mw');
    assert.equal(rows[0].routine_name, 'Quotes');
    assert.equal(rows[0].delivered_to, 1);
    assert.equal(rows[0].dismissed_at, null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, '⚠️ Market Watch · Quotes\\n**URGENT**: NVDA -12%\\nSell signal fired.');
    assert.deepEqual(events.filter((e) => e.type === 'alerts').length, 1);
    // listAlerts is scoped to the user and carries the bot name.
    const list = alerts.listAlerts('u');
    assert.equal(list.length, 1);
    assert.equal(list[0].botName, 'Market Watch');
    assert.equal(list[0].deliveredTo, 1);
    assert.match(list[0].text, /^\\*\\*URGENT\\*\\*: NVDA -12%/);
    assert.deepEqual(alerts.listAlerts('other'), []);
    // The API: list, then dismiss, then the default list is empty while all=1 still shows it.
    const got = await call('/alerts');
    assert.equal(got.status, 200);
    assert.equal(got.body.alerts.length, 1);
    assert.equal(got.body.alerts[0].id, list[0].id);
    assert.equal(got.body.alerts[0].botName, 'Market Watch');
    // Another user cannot see or dismiss it.
    assert.deepEqual((await call('/alerts', {}, 'tok-o')).body, { alerts: [] });
    assert.equal((await call('/alerts/' + list[0].id + '/dismiss', { method: 'POST' }, 'tok-o')).status, 404);
    assert.equal((await call('/alerts/nope/dismiss', { method: 'POST' })).status, 404);
    const dis = await call('/alerts/' + list[0].id + '/dismiss', { method: 'POST' });
    assert.deepEqual(dis, { status: 200, body: { ok: true } });
    assert.deepEqual(alerts.listAlerts('u'), []);
    assert.deepEqual((await call('/alerts')).body, { alerts: [] });
    const all = alerts.listAlerts('u', { includeDismissed: true });
    assert.equal(all.length, 1);
    assert.equal(typeof all[0].dismissedAt, 'number');
    assert.equal(events.filter((e) => e.type === 'alerts').length, 2, 'dismissing also tells open dashboards');
    // Unauthenticated requests are refused.
    const anon = await api.request('/alerts');
    assert.equal(anon.status, 401);
    console.log('ok-alerts');
    process.exit(0);
  `);
  assert.match(out, /ok-alerts/);
  assert.match(out, /\[telegram\] urgent alert from Market Watch \(Quotes\): delivered to 1\/1 chat\(s\)/);
});

test('alerts are recorded with deliveredTo=0 when Telegram notifications are off; text is cut to 600 chars', () => {
  probe(`
    alerts.installAlertHooks();
    loop.turnHooks.afterRoutine('mw', 'Quotes', 'URGENT ' + 'x'.repeat(2000));
    await settle(() => events.some((e) => e.type === 'alerts'));
    assert.equal(sent.length, 0);
    const [a] = alerts.listAlerts('u');
    assert.equal(a.deliveredTo, 0);
    assert.equal(a.text.length, 600);
    process.exit(0);
  `, { TELEGRAM_NOTIFICATIONS: '0' });
});

test('installTelegramHooks stays a working alias of installAlertHooks', () => {
  probe(`
    tg.installTelegramHooks();
    assert.equal(typeof loop.turnHooks.afterRoutine, 'function');
    loop.turnHooks.afterRoutine('mw', 'Quotes', 'URGENT: alias');
    await settle(() => sent.length >= 1 && db.prepare('SELECT COUNT(*) n FROM alerts').get().n === 1);
    process.exit(0);
  `);
});
