import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * ask_bot end to end against a temp DB and a fake engine: global fetch answers /v1/responses with
 * an SSE stream whose `response.output_item.done` message item carries a known reply, so the loop
 * runs the target's turn exactly as it would with Hermes, minus the model.
 */

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XAI_|COMPOSIO_|ORGO_|HQ_|SESSION_SECRET|DB_PATH)/.test(k)));

function probe(code: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-ask-'));
  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', SETUP + code], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000,
      env: { ...cleanEnv(), SESSION_SECRET: 'test-only', DB_PATH: path.join(dir, 'test.db'), HQ_VM: '0', HQ_LOCAL: '0', XAI_API_KEY: 'test', COMPOSIO_API_KEY: 'test', ORGO_API_KEY: 'test' },
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r.stdout;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Two bots, a fake engine, and helpers to read what each conversation holds.
const SETUP = `
  import assert from 'node:assert/strict';
  const { db } = await import('./server/src/db.ts');
  const { initSubagents } = await import('./server/src/agent/subagents.ts');
  const { initRooms } = await import('./server/src/agent/rooms.ts');
  initSubagents(); initRooms();
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','test@localhost','Test',0);
  for (const [id, name] of [['alice','Alice'],['bob','Bob']]) db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,'u',name,'managed',0,0);
  const loop = await import('./server/src/agent/loop.ts');
  const { toolMap } = await import('./server/src/agent/tools.ts');
  loop.loopDeps.engineFor = async () => ({ kind: 'managed', url: 'http://engine.test', key: 'k', home: '/nowhere' });
  loop.loopDeps.screenForWork = async () => {};
  const posted = [];
  const sse = (events) => events.map((e) => 'event: ' + e.type + '\\ndata: ' + JSON.stringify(e) + '\\n\\n').join('') + 'data: [DONE]\\n\\n';
  // The fake engine: each bot answers with replyFor(botId, input); a reply of null means the stream fails.
  let replyFor = () => 'ok';
  let engineDelayMs = 20;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const botId = /^hq-(.+)-g\\d+$/.exec(body.conversation)[1];
    posted.push({ botId, input: body.input, url: String(url) });
    await new Promise((r) => setTimeout(r, engineDelayMs));
    const reply = replyFor(botId, body.input);
    const events = reply === null
      ? [{ type: 'response.failed', response: { error: { message: 'engine exploded' } } }]
      : [
          { type: 'response.output_item.added', item: { type: 'message', id: 'm1' } },
          { type: 'response.output_item.done', item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: reply }] } },
          { type: 'response.completed', response: {} },
        ];
    return new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const rows = (botId) => db.prepare('SELECT kind, body FROM rows WHERE bot_id=? ORDER BY seq').all(botId).map((r) => ({ kind: r.kind, ...JSON.parse(r.body) }));
  const messages = (botId) => rows(botId).filter((r) => r.kind === 'message');
  const ctx = (botId, depth = loop.turnDepth(botId)) => ({ userId: 'u', botId, depth, askBot: (to, request, wait, d) => loop.askBot(botId, to, request, wait, d) });
  const askBot = toolMap.get('ask_bot');
  const settle = async (pred, ms = 5000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); } };
`;

test('send_to_bot is gone and ask_bot is served with the agreed shape', () => {
  probe(`
    assert.equal(toolMap.has('send_to_bot'), false);
    assert.ok(askBot);
    assert.deepEqual(askBot.parameters.required, ['bot_name', 'request']);
    assert.deepEqual(Object.keys(askBot.parameters.properties).sort(), ['bot_name', 'request', 'wait']);
    assert.equal(askBot.activity, 'messaging_named');
    assert.equal(askBot.label, 'Asking a Bot');
    const { activityFor } = await import('./server/src/agent/tools.ts');
    assert.deepEqual(activityFor('mcp_hq_ask_bot', { bot_name: 'Bob' }), { kind: 'messaging_named', label: 'Asking a Bot', detail: 'Bob' });
    process.exit(0);
  `);
});

test('ask_bot wait=true returns the reply and both sides see the exchange', () => {
  probe(`
    replyFor = (botId, input) => botId === 'bob' ? 'Paris, 2.1 million people.' : 'unexpected';
    const r = await askBot.impl({ bot_name: 'bob', request: 'What is the capital of France and its population?' }, ctx('alice'));
    assert.equal(r.output, 'Paris, 2.1 million people.');
    assert.equal(r.summary, 'Bob answered');
    // Bob ran exactly one turn, told who asked and that his reply goes back by itself.
    assert.equal(posted.length, 1);
    assert.equal(posted[0].botId, 'bob');
    assert.match(posted[0].input, /^\\[Alice, another Bot on the team, is asking you this\\./);
    assert.match(posted[0].input, /delivered to Alice automatically/);
    assert.match(posted[0].input, /Do not call ask_bot to answer them/);
    assert.match(posted[0].input, /do not call stay_silent/);
    assert.match(posted[0].input, /What is the capital of France/);
    // Bob's conversation: the question as a message from Alice, then his answer.
    const bob = messages('bob');
    assert.equal(bob.length, 2);
    assert.deepEqual(bob[0].from, { kind: 'bot', id: 'alice', name: 'Alice' });
    assert.equal(bob[0].role, 'user');
    assert.equal(bob[0].text, 'What is the capital of France and its population?');
    assert.equal(bob[1].role, 'assistant');
    assert.equal(bob[1].text, 'Paris, 2.1 million people.');
    // Nothing was posted into Alice's chat and no task was made: the answer is the tool result.
    assert.equal(messages('alice').length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
    assert.equal(loop.isBotBusy('bob'), false);
    process.exit(0);
  `);
});

test('ask_bot wait=true reports a failed target turn instead of hanging', () => {
  probe(`
    replyFor = () => null;
    const r = await askBot.impl({ bot_name: 'Bob', request: 'Do the thing', wait: true }, ctx('alice'));
    assert.match(r.output, /^Bob could not answer: engine exploded/);
    assert.equal(r.summary, 'Bob did not answer');
    assert.ok(rows('bob').some((x) => x.kind === 'notice' && /engine exploded/.test(x.text)));
    process.exit(0);
  `);
});

test('ask_bot wait=false tracks a task, posts the reply into the caller chat and wakes the caller', () => {
  probe(`
    replyFor = (botId, input) => botId === 'bob' ? 'Done: the report is in your Library.' : 'Thanks Bob, I will tell the user.';
    const r = await askBot.impl({ bot_name: 'bob', request: 'Write the quarterly report. It should cover revenue, churn and hiring.', wait: false }, ctx('alice'));
    assert.equal(r.summary, 'Asked Bob (task)');
    const out = JSON.parse(r.output);
    assert.match(out.task_id, /^task/);
    assert.match(out.message, /Bob will post the result into this chat/);
    // The task exists on Bob right away, before his turn finished.
    const task = () => db.prepare('SELECT * FROM tasks WHERE id=?').get(out.task_id);
    assert.equal(task().bot_id, 'bob');
    assert.equal(task().state, 'working');
    assert.equal(task().title, 'Write the quarterly report. It should cover revenue, churn and hiring.');
    // Bob's turn runs in the background, then Alice gets his reply and a turn of her own.
    await settle(() => posted.length === 2 && !loop.isBotBusy('alice') && !loop.isBotBusy('bob'));
    assert.equal(posted[0].botId, 'bob');
    assert.equal(posted[1].botId, 'alice');
    assert.match(posted[1].input, /^\\[Message from Bob, another Bot on the team\\./);
    assert.match(posted[1].input, /Done: the report is in your Library\\./);
    const alice = messages('alice');
    assert.equal(alice.length, 2);
    assert.equal(alice[0].role, 'assistant');
    assert.deepEqual(alice[0].from, { kind: 'bot', id: 'bob', name: 'Bob' });
    assert.equal(alice[0].text, 'Done: the report is in your Library.');
    assert.equal(alice[1].text, 'Thanks Bob, I will tell the user.');
    assert.equal(task().state, 'done');
    assert.equal(task().note, 'Done: the report is in your Library.');
    assert.ok(db.prepare('SELECT unread FROM bots WHERE id=?').get('alice').unread >= 1);
    const bob = messages('bob');
    assert.equal(bob.length, 2);
    assert.deepEqual(bob[0].from, { kind: 'bot', id: 'alice', name: 'Alice' });
    assert.equal(bob[1].text, 'Done: the report is in your Library.');
    process.exit(0);
  `);
});

test('ask_bot refuses too many hops, yourself, unknown bots and group chats', () => {
  probe(`
    const deep = await askBot.impl({ bot_name: 'bob', request: 'hi' }, { ...ctx('alice'), depth: 3 });
    assert.match(deep.output, /Too many hops/);
    const self = await askBot.impl({ bot_name: 'Alice', request: 'hi' }, ctx('alice'));
    assert.match(self.output, /That is you/);
    const nobody = await askBot.impl({ bot_name: 'Carol', request: 'hi' }, ctx('alice'));
    assert.match(nobody.output, /No bot named "Carol"\\. Team: Alice, Bob/);
    db.prepare("INSERT INTO bots(id,user_id,name,kind,members,created_at,updated_at) VALUES ('room1','u','Planning','room','[\\"alice\\",\\"bob\\"]',0,0)").run();
    const room = await askBot.impl({ bot_name: 'Planning', request: 'hi' }, ctx('alice'));
    assert.match(room.output, /group chat; use post_to_group/);
    assert.equal(posted.length, 0, 'no turn may start for a refused ask');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rows').get().n, 0);
    process.exit(0);
  `);
});

test('turn depth carries through an ask so the chain stops at 3', () => {
  probe(`
    // Alice at hop 2 asks Bob: his turn runs at 3, and from there ask_bot is refused.
    db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('carol','u','Carol','managed',0,0);
    const depths = {};
    replyFor = (botId) => { depths[botId] = loop.turnDepth(botId); return 'fine'; };
    await askBot.impl({ bot_name: 'bob', request: 'q' }, ctx('alice', 2));
    assert.equal(depths.bob, 3);
    const refused = await askBot.impl({ bot_name: 'carol', request: 'q' }, ctx('bob', 3));
    assert.match(refused.output, /Too many hops/);
    // A wait=false reply wakes the caller at the hop the target ran at, so the chain still ends.
    replyFor = (botId) => { depths[botId] = loop.turnDepth(botId); return 'later'; };
    await askBot.impl({ bot_name: 'carol', request: 'q', wait: false }, ctx('alice', 1));
    await settle(() => depths.carol !== undefined && depths.alice !== undefined && !loop.isBotBusy('alice'));
    assert.equal(depths.carol, 2);
    assert.equal(depths.alice, 2);
    process.exit(0);
  `);
});

test('a wait=true ask that outlasts the wait turns into a task and is delivered later', () => {
  probe(`
    loop.askSettings.waitMs = 150;
    engineDelayMs = 600;
    replyFor = (botId) => botId === 'bob' ? 'Finally done.' : 'Got it.';
    const t0 = Date.now();
    const r = await askBot.impl({ bot_name: 'bob', request: 'Slow job' }, ctx('alice'));
    assert.ok(Date.now() - t0 < 500, 'the tool call must return at the wait limit');
    assert.equal(r.summary, 'Asked Bob (task)');
    const out = JSON.parse(r.output);
    assert.match(out.message, /Bob has not finished after 1 minutes?\\. Bob will post the result into this chat/);
    const task = () => db.prepare('SELECT * FROM tasks WHERE id=?').get(out.task_id);
    assert.equal(task().state, 'working');
    assert.equal(task().bot_id, 'bob');
    await settle(() => task().state === 'done' && !loop.isBotBusy('alice'));
    assert.equal(task().note, 'Finally done.');
    const alice = messages('alice');
    assert.deepEqual(alice[0].from, { kind: 'bot', id: 'bob', name: 'Bob' });
    assert.equal(alice[0].text, 'Finally done.');
    assert.equal(posted.filter((p) => p.botId === 'alice').length, 1, 'the caller got exactly one follow-up turn');
    process.exit(0);
  `);
});

test('asking back a bot that is waiting on you is queued instead of deadlocking', () => {
  probe(`
    // Alice asks Bob and waits; while Bob's turn runs, Bob asks Alice back with wait=true.
    let bobAskedBack;
    replyFor = (botId) => {
      if (botId === 'bob' && !bobAskedBack) bobAskedBack = askBot.impl({ bot_name: 'alice', request: 'Which year?' }, ctx('bob'));
      return botId === 'bob' ? 'Asked you something.' : '2024.';
    };
    const r = await askBot.impl({ bot_name: 'bob', request: 'Summarise the plan' }, ctx('alice'));
    assert.equal(r.output, 'Asked you something.');
    const back = await bobAskedBack;
    assert.equal(back.summary, 'Asked Alice (task)');
    assert.match(JSON.parse(back.output).message, /Alice is waiting on you right now, so this request was queued instead/);
    await settle(() => !loop.isBotBusy('alice') && !loop.isBotBusy('bob') && posted.filter((p) => p.botId === 'bob').length === 2);
    // Alice answered Bob's question in a turn of her own, and the answer reached Bob.
    assert.ok(messages('bob').some((m) => m.text === '2024.' && m.from?.id === 'alice'));
    process.exit(0);
  `);
});
