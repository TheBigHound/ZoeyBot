import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XAI_|COMPOSIO_|ORGO_|HQ_|HERMES_|ENGINES_DIR|DB_PATH|SESSION_SECRET)/.test(k)));
function probe(code: string, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 20000,
    env: { ...cleanEnv(), TMPDIR: '/Users/thehound/.hermes/cache/scratch', HQ_HOST: '1', SESSION_SECRET: 'host-test', DB_PATH: ':memory:', ...extra },
  });
}

/** A temp dir with a primary home, a fake `hermes` that records argv, and the env vars pointing at them. */
const SETUP = `
  import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-host-'));
  const primary=path.join(dir,'primary'); fs.mkdirSync(primary);
  fs.writeFileSync(path.join(primary,'config.yaml'),'model: {default: "qwen3.5:35b", provider: ollama}\\n');
  fs.writeFileSync(path.join(primary,'.env'),'ANTHROPIC_API_KEY=shared-anthropic\\nTELEGRAM_BOT_TOKEN=never-shared\\n');
  fs.writeFileSync(path.join(primary,'auth.json'),'{"anthropic":"oauth-blob"}');
  const cli=path.join(dir,'hermes');
  fs.writeFileSync(cli,'#!/usr/bin/env node\\nrequire("node:fs").appendFileSync(process.env.HERMES_HOME+"/calls.jsonl",JSON.stringify(process.argv.slice(2))+"\\\\n");\\n',{mode:0o700});
  process.env.HERMES_BIN=cli; process.env.HERMES_HOME_PRIMARY=primary; process.env.ENGINES_DIR=path.join(dir,'engines');
  const {db}=await import('./server/src/db.ts');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','u@local','User',0);
  const calls=(home)=>fs.readFileSync(path.join(home,'calls.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);
  const section=(home,k)=>{const c=calls(home).filter(c=>c[3]===k).pop(); return c?JSON.parse(c[4]):undefined;};
`;

test('host mode env: no VM, no screens, no cloud credentials required', () => {
  const r = probe(`const {env}=await import('./server/src/env.ts'); console.log(JSON.stringify(env));`);
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(r.stdout);
  assert.equal(e.hostMode, true);
  assert.equal(e.vmBox, false);
  assert.equal(e.localBox, false);
  assert.equal(e.orgoComputerId, '');
  assert.equal(e.hostname, '127.0.0.1');
  assert.equal(e.devLogin, true);
  assert.equal(e.xaiKey, '');
  assert.equal(e.composioKey, '');
  assert.equal(e.orgoKey, '');
});

test('HQ_HOST and HQ_VM are mutually exclusive', () => {
  const r = probe(`await import('./server/src/env.ts');`, { HQ_VM: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HQ_HOST and HQ_VM/);
});

test('toolset validation: known names only, defaults when empty', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {validToolsets,DEFAULT_TOOLSETS,hostEngineSettings}=await import('./server/src/engine-runtime.ts');
    assert.deepEqual(validToolsets(['terminal','bogus','web','terminal']),['terminal','web']);
    assert.deepEqual(validToolsets([]),DEFAULT_TOOLSETS);
    assert.deepEqual(validToolsets(undefined),DEFAULT_TOOLSETS);
    assert.deepEqual(validToolsets(['clarify','nope']),DEFAULT_TOOLSETS);
    const c=hostEngineSettings({terminal:{backend:'ssh',ssh_host:'x'},browser:{use_real_profile:true},platform_toolsets:{api_server:['hermes-api-server']},model:{default:'m'}},{cwd:'/tmp/w',toolsets:['terminal','file']});
    assert.equal(c.terminal.backend,'local'); assert.equal(c.terminal.cwd,'/tmp/w');
    assert.deepEqual(c.platform_toolsets.api_server,['terminal','file']);
    assert.equal(c.browser.use_real_profile,false);
    assert.equal(c.model.default,'m');
  `);
  assert.equal(r.status, 0, r.stderr);
});

test('managed home in host mode: local terminal in the bot cwd, bot toolsets, shared keys, no ssh wrappers', () => {
  const r = probe(SETUP + `
    try {
      const {DEFAULT_TOOLSETS}=await import('./server/src/engine-runtime.ts');
      const {writeHome,engineInfo,mcpToken}=await import('./server/src/engine.ts');
      const work=path.join(dir,'work'); fs.mkdirSync(work);
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine,engine_port,cwd,toolsets) VALUES (?,?,?,?,?,?,?,?,?)').run('a','u','Alpha',0,0,'managed',8650,work,JSON.stringify(['terminal','file','web']));
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine,engine_port) VALUES (?,?,?,?,?,?,?)').run('b','u','Beta',0,0,'managed',8651);

      const a=await writeHome('a');
      assert.ok(calls(a.home).every(c=>c[0]==='config'&&c[1]==='set'&&c[2]==='--force'));
      const term=section(a.home,'terminal');
      assert.equal(term.backend,'local'); assert.equal(term.cwd,work);
      assert.equal(term.ssh_host,undefined);
      assert.deepEqual(section(a.home,'platform_toolsets').api_server,['terminal','file','web']);
      assert.equal(section(a.home,'browser').use_real_profile,false);
      assert.ok(section(a.home,'mcp_servers').hq.url.endsWith('/mcp/a'));
      assert.equal(section(a.home,'platforms').api_server.extra.port,8650);
      assert.equal(section(a.home,'model').default,'qwen3.5:35b');
      assert.ok(!fs.existsSync(path.join(a.home,'bin','ssh')));
      assert.ok(!fs.existsSync(path.join(a.home,'bin','scp')));
      const envText=fs.readFileSync(path.join(a.home,'.env'),'utf8');
      assert.match(envText,/^API_SERVER_KEY=[0-9a-f]{48}$/m);
      assert.ok(envText.includes('HQ_MCP_TOKEN='+mcpToken('a')));
      assert.ok(envText.includes('ANTHROPIC_API_KEY=shared-anthropic'),'host bots share model credentials');
      assert.ok(!envText.includes('never-shared'),'messaging tokens are never shared');
      assert.ok(!envText.includes('API_SERVER_PORT='));
      assert.equal(fs.readFileSync(path.join(a.home,'auth.json'),'utf8'),'{"anthropic":"oauth-blob"}');

      const b=await writeHome('b');
      const bt=section(b.home,'terminal');
      assert.equal(bt.backend,'local'); assert.equal(bt.cwd,path.join(b.home,'workspace'));
      assert.ok(fs.statSync(path.join(b.home,'workspace')).isDirectory());
      assert.deepEqual(section(b.home,'platform_toolsets').api_server,DEFAULT_TOOLSETS);

      globalThis.fetch=async()=>{throw new Error('offline')};
      const info=await engineInfo('a');
      assert.equal(info.execution,'host'); assert.equal(info.home,a.home); assert.equal(info.cwd,work);
      assert.deepEqual(info.toolsets,['terminal','file','web']);
      const infoB=await engineInfo('b');
      assert.equal(infoB.cwd,path.join(b.home,'workspace')); assert.deepEqual(infoB.toolsets,DEFAULT_TOOLSETS);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `);
  assert.equal(r.status, 0, r.stderr);
});

test('updateEngineSettings validates cwd and toolsets; primary bot only stores them', () => {
  const r = probe(SETUP + `
    try {
      const {updateEngineSettings,engineFor,engineInfo}=await import('./server/src/engine.ts');
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine) VALUES (?,?,?,?,?,?)').run('p','u','Primary',0,0,'primary');
      await assert.rejects(()=>updateEngineSettings('p',{cwd:'relative/dir'}),/absolute/);
      await assert.rejects(()=>updateEngineSettings('p',{cwd:path.join(dir,'does-not-exist')}),/No such directory/);
      await assert.rejects(()=>updateEngineSettings('p',{toolsets:['terminal','hack_the_planet']}),/Unknown toolset.*hack_the_planet/);
      await assert.rejects(()=>updateEngineSettings('p',{toolsets:['clarify']}),/Unknown toolset/);
      assert.equal(db.prepare('SELECT cwd,toolsets FROM bots WHERE id=?').get('p').cwd,null,'nothing stored on rejection');
      const work=path.join(dir,'pw'); fs.mkdirSync(work);
      const res=await updateEngineSettings('p',{cwd:work,toolsets:['web','terminal']});
      assert.match(res.note,/own agent/);
      const row=db.prepare('SELECT cwd,toolsets FROM bots WHERE id=?').get('p');
      assert.equal(row.cwd,work); assert.deepEqual(JSON.parse(row.toolsets),['web','terminal']);
      assert.ok(!fs.existsSync(path.join(primary,'calls.jsonl')),'the primary home is never rewritten');
      // Clearing goes back to defaults.
      await updateEngineSettings('p',{toolsets:[]});
      assert.equal(db.prepare('SELECT toolsets FROM bots WHERE id=?').get('p').toolsets,null);

      // engineFor on the primary bot does not throw in host mode, even with a plain local config.
      fs.writeFileSync(path.join(primary,'config.yaml'),'terminal: {backend: local}\\n');
      fs.writeFileSync(path.join(primary,'.env'),'API_SERVER_KEY=primary-key\\n');
      const e=await engineFor('p');
      assert.equal(e.kind,'primary'); assert.equal(e.home,primary); assert.equal(e.key,'primary-key');
      globalThis.fetch=async()=>{throw new Error('offline')};
      const info=await engineInfo('p');
      assert.equal(info.execution,'host'); assert.equal(info.home,primary); assert.equal(info.cwd,work);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `);
  assert.equal(r.status, 0, r.stderr);
});

test('engine settings API accepts cwd and toolsets and rejects bad values with 400', () => {
  const r = probe(SETUP + `
    try {
      db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('s','u',0,Date.now()+60000);
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine) VALUES (?,?,?,?,?,?)').run('p','u','Primary',0,0,'primary');
      globalThis.fetch=async()=>new Response('{}',{status:200,headers:{'content-type':'application/json'}});
      const {configApi}=await import('./server/src/routes-config.ts');
      const send=(body)=>configApi.request('/bots/p/engine',{method:'PATCH',headers:{cookie:'grokbot_session=s','content-type':'application/json'},body:JSON.stringify(body)});
      let r=await send({toolsets:['terminal','nope']}); assert.equal(r.status,400); assert.match((await r.json()).error,/Unknown toolset/);
      r=await send({cwd:'not/absolute'}); assert.equal(r.status,400);
      const work=path.join(dir,'api-work'); fs.mkdirSync(work);
      r=await send({cwd:work,toolsets:['terminal','file'],model:'m1',provider:'ollama'}); const text=await r.text(); assert.equal(r.status,200,text);
      const j=JSON.parse(text);
      assert.equal(j.engine.cwd,work); assert.deepEqual(j.engine.toolsets,['terminal','file']); assert.equal(j.engine.execution,'host');
      assert.match(j.note,/own agent/);
      const row=db.prepare('SELECT cwd,toolsets,model,provider FROM bots WHERE id=?').get('p');
      assert.deepEqual(row,{cwd:work,toolsets:JSON.stringify(['terminal','file']),model:'m1',provider:'ollama'});
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `);
  assert.equal(r.status, 0, r.stderr);
});

test('screenForWork is a no-op in host mode', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {db}=await import('./server/src/db.ts');
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','test@localhost','Test',0);
    db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('a','u','Test','primary',0,0);
    globalThis.fetch=async()=>{throw new Error('must not touch any screen or CDP')};
    const {screenForWork}=await import('./server/src/computer.ts');
    await screenForWork('u','a');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM screens').get().n,0);
  `);
  assert.equal(r.status, 0, r.stderr);
});
