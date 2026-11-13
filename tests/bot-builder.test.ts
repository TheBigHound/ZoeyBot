import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The bot builder's tools (create_bot, configure_bot_engine, seed_bot_skill, describe_bots) at the
 * app's MCP endpoint, which is where the gate lives. A fake engine runs real turns through the agent
 * loop, and during each turn the "model" calls the MCP endpoint, so the turn's origin (user, ask,
 * routine) is the real one. Nothing here starts a gateway: builderDeps is swapped for fakes.
 */

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XAI_|COMPOSIO_|HQ_|SESSION_SECRET|DB_PATH)/.test(k)));

function probe(code: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-builder-'));
  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', SETUP + code], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 90000,
      env: { ...cleanEnv(), SESSION_SECRET: 'test-only', DB_PATH: path.join(dir, 'test.db'), HQ_HOST: '1', XAI_API_KEY: 'test', COMPOSIO_API_KEY: 'test', BUILDER_TMP: dir },
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r.stdout;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const SETUP = `
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  const TMP = process.env.BUILDER_TMP;
  const { db } = await import('./server/src/db.ts');
  const { initSubagents } = await import('./server/src/agent/subagents.ts');
  const { initRooms } = await import('./server/src/agent/rooms.ts');
  initSubagents(); initRooms();
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','test@localhost','Test',0);
  const mk = (id, name, engine, extra = {}) => {
    db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,'u',name,engine,0,0);
    for (const [k, v] of Object.entries(extra)) db.prepare('UPDATE bots SET ' + k + '=? WHERE id=?').run(v, id);
  };
  mk('zoey', 'Zoey', 'primary', { is_primary: 1 });
  mk('father', 'The BotFather', 'managed', { builder: 1 });
  mk('coder', 'Coder', 'managed', { model: 'claude-sonnet-5', provider: 'anthropic', toolsets: JSON.stringify(['terminal','file']) });
  const loop = await import('./server/src/agent/loop.ts');
  const { mcpApi, mcpDeps } = await import('./server/src/mcp.ts');
  const { mcpToken } = await import('./server/src/engine.ts');
  const { builderDeps } = await import('./server/src/agent/builder.ts');
  mcpDeps.composioTools = async () => [];
  loop.loopDeps.engineFor = async () => ({ kind: 'managed', url: 'http://engine.test', key: 'k', home: '/nowhere' });

  // Fakes for everything that would start a gateway or touch a real Hermes home.
  const created = [];
  const restarted = [];
  builderDeps.createBot = (userId, b, setup) => {
    const id = 'new' + (created.length + 1);
    db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,engine,engine_port,provider,model,toolsets,cwd,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, userId, b.name, b.label, b.description, b.instructions, 'managed', 8700 + created.length, setup.provider, setup.model, JSON.stringify(setup.toolsets), setup.cwd, setup.createdBy, Date.now(), Date.now());
    created.push({ id, b, setup });
    return { id, name: b.name };
  };
  builderDeps.engineInfo = async (botId) => ({ status: 'ready', error: null, providers: [
    { id: 'anthropic', name: 'Claude', kind: 'api_key', connected: true, models: ['claude-sonnet-5', 'claude-fable-5-2'] },
    { id: 'openrouter', name: 'OpenRouter', kind: 'api_key', connected: false, models: [] },
  ] });
  builderDeps.updateEngineSettings = async (botId, patch) => {
    restarted.push({ botId, patch });
    if (patch.toolsets) db.prepare('UPDATE bots SET toolsets=? WHERE id=?').run(JSON.stringify(patch.toolsets), botId);
    if (patch.cwd) db.prepare('UPDATE bots SET cwd=? WHERE id=?').run(patch.cwd, botId);
    return { note: null };
  };
  builderDeps.syncPersona = () => {};
  builderDeps.engineHome = (botId) => path.join(TMP, 'homes', botId);
  builderDeps.skillRoots = () => [path.join(TMP, 'skills')];
  builderDeps.pollMs = 5;

  const call = async (slug, name, args) => {
    const r = await mcpApi.request('/' + slug, { method: 'POST', headers: { authorization: 'Bearer ' + mcpToken(slug), 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json();
    return { text: j.result.content[0].text, isError: !!j.result.isError };
  };
  const names = async (slug) => (await (await mcpApi.request('/' + slug, { method: 'POST', headers: { authorization: 'Bearer ' + mcpToken(slug), 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json()).result.tools.map((t) => t.name);

  // The fake engine: while a bot's turn runs, onTurn(botId) plays the model and may call tools.
  let onTurn = async () => {};
  const sse = (events) => events.map((e) => 'event: ' + e.type + '\\ndata: ' + JSON.stringify(e) + '\\n\\n').join('') + 'data: [DONE]\\n\\n';
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const botId = /^hq-(.+)-g\\d+$/.exec(body.conversation)[1];
    await onTurn(botId, body.input);
    return new Response(sse([
      { type: 'response.output_item.added', item: { type: 'message', id: 'm1' } },
      { type: 'response.output_item.done', item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'done' }] } },
      { type: 'response.completed', response: {} },
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  /** Run one turn of \`botId\` started by \`trigger\`; \`model\` is what the bot does during it. */
  const turn = async (botId, trigger, model) => {
    let out;
    onTurn = async (id) => { if (id === botId) out = await model(); };
    await loop.enqueueAndWait(botId, trigger);
    onTurn = async () => {};
    return out;
  };
  /** Answer the next approval card that shows up for a bot. Resolves with the card. */
  const answerNext = (botId, decision) => new Promise((resolve) => {
    const t = setInterval(() => {
      const ap = db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending'").get(botId);
      if (!ap) return;
      clearInterval(t);
      const card = JSON.parse(db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(botId, ap.row_seq).body);
      loop.resolveApproval('u', ap.id, decision);
      resolve(card);
    }, 10);
  });
  const approvals = () => db.prepare('SELECT COUNT(*) n FROM approvals').get().n;
  const SPEC = { name: 'Scout', label: 'Deal scout', description: 'Finds deals.', instructions: 'Every price needs a URL.', provider: 'anthropic', model: 'claude-sonnet-5', toolsets: ['web', 'file'] };
  const bot = (id) => db.prepare('SELECT * FROM bots WHERE id=?').get(id);
`;

test('only the builder bot sees the builder tools, and another bot calling one is refused', () => {
  probe(`
    const father = await names('father');
    for (const n of ['create_bot', 'configure_bot_engine', 'seed_bot_skill', 'describe_bots']) assert.ok(father.includes(n), 'builder sees ' + n);
    const coder = await names('coder');
    for (const n of ['create_bot', 'configure_bot_engine', 'seed_bot_skill', 'describe_bots']) assert.ok(!coder.includes(n), 'coder must not see ' + n);
    assert.ok(coder.includes('ask_bot'));
    // Even inside a turn the owner started, a non-builder bot is refused.
    const r = await turn('coder', { type: 'user', text: 'make a bot' }, () => call('coder', 'create_bot', SPEC));
    assert.ok(r.isError && /not available to you/.test(r.text), r.text);
    const d = await turn('coder', { type: 'user', text: 'x' }, () => call('coder', 'describe_bots', {}));
    assert.ok(d.isError);
    assert.equal(created.length, 0);
    assert.equal(approvals(), 0, 'no approval card was shown');
  `);
});

test('the builder cannot build or change bots outside a turn the owner started', () => {
  probe(`
    // No turn at all (a stray call with the builder's token).
    let r = await call('father', 'create_bot', SPEC);
    assert.ok(r.isError && /owner started/.test(r.text), r.text);
    // Another bot asked it (ask_bot): refused for all three write tools.
    for (const [name, args] of [['create_bot', SPEC], ['configure_bot_engine', { bot_name: 'Coder', model: 'claude-fable-5-2' }], ['seed_bot_skill', { bot_name: 'Coder', skill: 'demo' }]]) {
      r = await turn('father', { type: 'ask', askId: 'a1', fromBotId: 'coder', fromName: 'Coder', text: 'build me a helper', depth: 1, wait: true }, () => call('father', name, args));
      assert.ok(r.isError && /started by: ask/.test(r.text), name + ': ' + r.text);
    }
    // A routine: refused.
    r = await turn('father', { type: 'routine', routineId: 'rt1', name: 'nightly', prompt: 'make a bot' }, () => call('father', 'create_bot', SPEC));
    assert.ok(r.isError && /started by: routine/.test(r.text), r.text);
    // Reading is fine when another bot asks.
    r = await turn('father', { type: 'ask', askId: 'a2', fromBotId: 'coder', fromName: 'Coder', text: 'what model am I on?', depth: 1, wait: true }, () => call('father', 'describe_bots', { bot_name: 'Coder' }));
    assert.ok(!r.isError && JSON.parse(r.text).model === 'claude-sonnet-5', r.text);
    assert.equal(created.length, 0);
    assert.equal(approvals(), 0);
    assert.equal(bot('coder').model, 'claude-sonnet-5');
  `);
});

test('create_bot waits on an approval card; declined means nothing is created, allowed creates with the spec', () => {
  probe(`
    let card;
    let r = await turn('father', { type: 'user', text: 'build it' }, async () => { const c = answerNext('father', 'deny'); const out = await call('father', 'create_bot', SPEC); card = await c; return out; });
    assert.match(card.title, /Allow The BotFather to create the bot "Scout"\\?/);
    assert.match(card.detail, /anthropic \\/ claude-sonnet-5/);
    assert.match(r.text, /declined/);
    assert.equal(created.length, 0, 'declined: nothing created');

    r = await turn('father', { type: 'user', text: 'ok build it' }, async () => { answerNext('father', 'allow'); return call('father', 'create_bot', { ...SPEC, voice: 'Hugh', effort: 'high' }); });
    const out = JSON.parse(r.text);
    assert.equal(out.ok, true);
    assert.equal(out.engine_status, 'ready');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].setup, { provider: 'anthropic', model: 'claude-sonnet-5', toolsets: ['web', 'file'], cwd: null, voice: 'Hugh', effort: 'high', createdBy: 'father' });
    assert.equal(created[0].b.instructions, 'Every price needs a URL.');

    // Validation happens before any card is shown.
    const before = approvals();
    const bad = async (patch, re) => {
      const x = await turn('father', { type: 'user', text: 'x' }, () => call('father', 'create_bot', { ...SPEC, name: 'Other', ...patch }));
      assert.match(x.text, re, JSON.stringify(patch));
    };
    await bad({ name: 'Scout' }, /already a bot named/);
    await bad({ model: 'Claude Sonnet 5' }, /display name/);
    await bad({ provider: 'nope' }, /Unknown provider/);
    await bad({ provider: 'openrouter' }, /not signed in/);
    await bad({ toolsets: ['web', 'teleport'] }, /Unknown toolset/);
    await bad({ cwd: '/definitely/not/here' }, /No such directory/);
    await bad({ instructions: '' }, /required/);
    assert.equal(approvals(), before, 'invalid specs never reach the owner');
    assert.equal(created.length, 1);
  `);
});

test('configure_bot_engine: main bot and self are off-limits, older bots need an approved diff, a fresh build does not', () => {
  probe(`
    const cfg = (args, decision) => turn('father', { type: 'user', text: 'x' }, async () => { const c = decision ? answerNext('father', decision) : null; const out = await call('father', 'configure_bot_engine', args); return { out, card: c ? await c : null }; });
    let r = await cfg({ bot_name: 'Zoey', model: 'claude-sonnet-5' });
    assert.match(r.out.text, /main bot/);
    r = await cfg({ bot_name: 'The BotFather', instructions: 'anything goes' });
    assert.match(r.out.text, /your own setup/);
    assert.equal(approvals(), 0);

    // An existing bot: declined leaves it alone.
    r = await cfg({ bot_name: 'Coder', model: 'claude-fable-5-2', toolsets: ['terminal', 'file', 'web'] }, 'deny');
    assert.match(r.card.title, /change Coder's setup \\(restarts it\\)/);
    assert.match(r.card.detail, /model: claude-sonnet-5 -> claude-fable-5-2/);
    assert.match(r.card.detail, /tools: terminal, file -> terminal, file, web/);
    assert.match(r.out.text, /declined/);
    assert.equal(bot('coder').model, 'claude-sonnet-5');
    assert.equal(restarted.length, 0);

    // Allowed: applied, and the toolset change went through the engine restart path.
    r = await cfg({ bot_name: 'Coder', model: 'claude-fable-5-2', toolsets: ['terminal', 'file', 'web'] }, 'allow');
    assert.equal(JSON.parse(r.out.text).ok, true);
    assert.equal(bot('coder').model, 'claude-fable-5-2');
    assert.deepEqual(restarted, [{ botId: 'coder', patch: { toolsets: ['terminal', 'file', 'web'] } }]);

    // Same values again: nothing to do, no card.
    const n = approvals();
    r = await cfg({ bot_name: 'Coder', model: 'claude-fable-5-2' });
    assert.deepEqual(JSON.parse(r.out.text).changed, []);
    assert.equal(approvals(), n);

    // A bot the builder created a moment ago is finished without a second card...
    mk('fresh', 'Fresh', 'managed', { created_by: 'father', created_at: Date.now() });
    r = await cfg({ bot_name: 'Fresh', instructions: 'Be brief.' });
    assert.equal(bot('fresh').instructions, 'Be brief.');
    assert.equal(approvals(), n, 'fresh build: covered by the create approval');
    // ...but not once it is older than the window.
    db.prepare('UPDATE bots SET created_at=? WHERE id=?').run(Date.now() - 3 * 60 * 60_000, 'fresh');
    r = await cfg({ bot_name: 'Fresh', instructions: 'Be long.' }, 'deny');
    assert.equal(bot('fresh').instructions, 'Be brief.');
    assert.equal(approvals(), n + 1);
  `);
});

test('seed_bot_skill copies a skill directory into the target home and replaces rather than nests', () => {
  probe(`
    fs.mkdirSync(path.join(TMP, 'skills', 'productivity', 'demo', 'references'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'skills', 'productivity', 'demo', 'SKILL.md'), 'v1');
    fs.writeFileSync(path.join(TMP, 'skills', 'productivity', 'demo', 'references', 'a.md'), 'a');
    mk('fresh', 'Fresh', 'managed', { created_by: 'father', created_at: Date.now() });
    const seed = (args, decision) => turn('father', { type: 'user', text: 'x' }, async () => { if (decision) answerNext('father', decision); return call('father', 'seed_bot_skill', args); });

    let r = await seed({ bot_name: 'Fresh', skill: '../etc' });
    assert.match(r.text, /skill directory name/);
    r = await seed({ bot_name: 'Fresh', skill: 'missing' });
    assert.match(r.text, /No skill directory/);
    r = await seed({ bot_name: 'Zoey', skill: 'demo' });
    assert.match(r.text, /off-limits/);

    r = await seed({ bot_name: 'Fresh', skill: 'demo' });
    const dest = path.join(TMP, 'homes', 'fresh', 'skills', 'demo');
    assert.equal(JSON.parse(r.text).files, 2);
    assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'v1');
    assert.equal(approvals(), 0, 'fresh build: no card');

    // A second copy is a no-op unless overwrite is set; overwrite replaces, it does not nest demo/demo.
    fs.writeFileSync(path.join(TMP, 'skills', 'productivity', 'demo', 'SKILL.md'), 'v2');
    r = await seed({ bot_name: 'Fresh', skill: 'demo' });
    assert.equal(JSON.parse(r.text).already_there, true);
    assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'v1');
    r = await seed({ bot_name: 'Fresh', skill: 'demo', overwrite: true });
    assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'v2');
    assert.ok(!fs.existsSync(path.join(dest, 'demo')), 'no nested duplicate');

    // An older bot needs the owner's yes.
    r = await seed({ bot_name: 'Coder', skill: 'demo' }, 'deny');
    assert.match(r.text, /declined/);
    assert.ok(!fs.existsSync(path.join(TMP, 'homes', 'coder', 'skills', 'demo')));
    r = await seed({ bot_name: 'Coder', skill: 'demo' }, 'allow');
    assert.ok(fs.existsSync(path.join(TMP, 'homes', 'coder', 'skills', 'demo', 'SKILL.md')));
  `);
});
