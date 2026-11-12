import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function probe(code: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, TMPDIR: '/Users/thehound/.hermes/cache/scratch', HQ_VM: '1', SESSION_SECRET: 'engine-test', DB_PATH: ':memory:', HQ_VM_KNOWN_HOSTS: '/private/pinned-hosts' },
  });
}
test('Primary engine discovers its key when the private gateway is configured after dashboard startup', () => {
  const r = probe(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-late-key-'));
    try {
      process.env.HERMES_HOME_PRIMARY=dir;process.env.HERMES_KEY='';
      const {db}=await import('./server/src/db.ts');
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','u@local','User',0);
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine) VALUES (?,?,?,?,?,?)').run('b','u','Bot',0,0,'primary');
      globalThis.fetch=async (url,options)=> url.endsWith('/health')?Response.json({status:'ok'}):options.headers.Authorization==='Bearer later-key'?Response.json({model:'qwen3.5:35b',provider:'ollama',providers:[]}):new Response('',{status:401});
      const {engineInfo}=await import('./server/src/engine.ts');
      assert.equal((await engineInfo('b')).model,null);
      fs.writeFileSync(path.join(dir,'.env'),'API_SERVER_KEY=later-key\\n');
      assert.equal((await engineInfo('b')).model,'qwen3.5:35b');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `);
  assert.equal(r.status, 0, r.stderr);
});
test('Ollama picker uses model capabilities to omit embedding and speech models', () => {
  const r = probe(`
    import assert from 'node:assert/strict'; import {createServer} from 'node:http';
    const {ollamaChatModels}=await import('./server/src/engine-runtime.ts');
    const {toProviders}=await import('./server/src/engine.ts');
    const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{const {model}=JSON.parse(body); res.setHeader('content-type','application/json');res.end(JSON.stringify({capabilities:model==='qwen3.5:35b'?['completion','tools']:model==='phonon:latest'?['audio']:['embedding']}));});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const models=['phonon:latest','nomic-embed-text:latest','qwen3.5:35b'];
      const chat_models=await ollamaChatModels('http://127.0.0.1:'+server.address().port+'/v1',models);
      assert.deepEqual(chat_models,['qwen3.5:35b']);
      assert.deepEqual(toProviders({providers:[{slug:'ollama',authenticated:true,models,chat_models}]}).find(p=>p.id==='ollama').models,['qwen3.5:35b']);
      assert.equal(await ollamaChatModels('https://not-local.invalid/v1',models),null);
    } finally {server.close();}
  `);
  assert.equal(r.status, 0, r.stderr);
});
test('Engine settings API persists per-bot model/provider choices and reset', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {db}=await import('./server/src/db.ts');
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','u@local','User',0);
    db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('test-session','u',0,Date.now()+60000);
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine) VALUES (?,?,?,?,?,?)').run('b','u','Bot',0,0,'primary');
    globalThis.fetch=async ()=>new Response('{}',{status:200,headers:{'content-type':'application/json'}});
    const {configApi}=await import('./server/src/routes-config.ts');
    for(const choice of [{provider:'ollama',model:'qwen3.5:35b'},{provider:'openai-api',model:'later-model'},{provider:null,model:null}]) {
      const r=await configApi.request('/bots/b/engine',{method:'PATCH',headers:{cookie:'grokbot_session=test-session','content-type':'application/json'},body:JSON.stringify(choice)});
      assert.equal(r.status,200,await r.text());
      const row=db.prepare('SELECT provider,model FROM bots WHERE id=?').get('b'); assert.deepEqual(row,choice);
    }
  `);
  assert.equal(r.status, 0, r.stderr);
});
test('VM primary refuses unsafe host-side engine configuration', () => {
  const r = probe(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-primary-'));
    try {
      fs.writeFileSync(path.join(dir,'config.yaml'),'terminal: {backend: local}\\n');
      process.env.HERMES_HOME_PRIMARY=dir;
      const {db}=await import('./server/src/db.ts');
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','u@local','User',0);
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine) VALUES (?,?,?,?,?,?)').run('b','u','Bot',0,0,'primary');
      const {engineFor}=await import('./server/src/engine.ts');
      await assert.rejects(()=>engineFor('b'),/VM engine.*SSH/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `);
  assert.equal(r.status, 0, r.stderr);
});
test('Managed VM homes are configured through CLI without inheriting host credentials', () => {
  const r = probe(`
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-engine-'));
    try {
      const primary=path.join(dir,'primary'); fs.mkdirSync(primary);
      fs.writeFileSync(path.join(primary,'config.yaml'),'model: {default: "qwen3.5:35b", provider: ollama}\\n');
      const cli=path.join(dir,'hermes');
      fs.writeFileSync(cli,'#!/usr/bin/env node\\nrequire("node:fs").appendFileSync(process.env.HERMES_HOME+"/calls.jsonl",JSON.stringify(process.argv.slice(2))+"\\\\n");\\n',{mode:0o700});
      process.env.HERMES_BIN=cli; process.env.HERMES_HOME_PRIMARY=primary; process.env.ENGINES_DIR=path.join(dir,'engines');
      process.env.OPENAI_API_KEY='must-not-leak';
      const {db}=await import('./server/src/db.ts');
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','u@local','User',0);
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine,engine_port) VALUES (?,?,?,?,?,?,?)').run('b','u','Bot',0,0,'managed',8650);
      const {writeHome}=await import('./server/src/engine.ts');
      const {home}=await writeHome('b');
      const calls=fs.readFileSync(path.join(home,'calls.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);
      if(calls.some(c=>c[2]!=='--force')) throw Error('Refreshing existing config sections needs explicit --force');
      const terminal=calls.find(c=>c[3]==='terminal');
      if(!terminal||JSON.parse(terminal[4]).backend!=='ssh') throw Error('CLI did not set SSH');
      const text=fs.readFileSync(path.join(home,'.env'),'utf8');
      if(text.includes('must-not-leak')||text.includes('API_SERVER_PORT=')) throw Error('wrong env');
      if(!fs.readFileSync(path.join(home,'bin/ssh'),'utf8').includes('StrictHostKeyChecking=yes')) throw Error('missing wrapper');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `);
  assert.equal(r.status, 0, r.stderr);
});
test('VM engine policy uses SSH only, removes host tools and pins SSH wrappers', () => {
  const r = probe(`
    const {vmEngineSettings,sshWrapper}=await import('./server/src/engine-runtime.ts');
    const c=vmEngineSettings({terminal:{backend:'local'},browser:{use_real_profile:true},platform_toolsets:{api_server:['hermes-api-server','computer_use']},fallback_providers:['openai']}, {host:'127.0.0.1',port:2222,user:'bot',key:'/key'});
    if(c.terminal.backend!=='ssh'||c.terminal.ssh_user!=='bot') throw Error('host terminal');
    if(c.platform_toolsets.api_server.includes('browser')||c.platform_toolsets.api_server.includes('hermes-api-server')||c.platform_toolsets.api_server.includes('computer_use')) throw Error('host tools');
    if(c.browser.use_real_profile!==false) throw Error('host browser profile');
    const s=sshWrapper('ssh','/private/pinned-hosts');
    if(!s.includes('UserKnownHostsFile=')||!s.includes('StrictHostKeyChecking=yes')||!s.includes('/usr/bin/ssh')) throw Error(s);
    if(!s.includes('ControlPath=none')) throw Error('macOS SSH sockets overflow with private-home paths');
  `);
  assert.equal(r.status, 0, r.stderr);
});
test('Engine model picker retains credential-free local Ollama', () => {
  const r = probe(`
    const {toProviders}=await import('./server/src/engine.ts');
    const providers=toProviders({providers:[{slug:'ollama',name:'Ollama (local)',authenticated:false,models:['qwen3.5:35b']}]});
    if (!providers.some(p=>p.id==='ollama' && p.models.includes('qwen3.5:35b'))) throw Error(JSON.stringify(providers));
  `);
  assert.equal(r.status, 0, r.stderr);
});
test('VM SSH transport uses a dedicated pinned known-hosts file', () => {
  const r = probe(`
    const {sshArgs}=await import('./server/src/vm.ts');
    const args=sshArgs();
    if (!args.includes('UserKnownHostsFile=/private/pinned-hosts') || !args.includes('StrictHostKeyChecking=yes')) throw Error(JSON.stringify(args));
  `);
  assert.equal(r.status, 0, r.stderr);
});
