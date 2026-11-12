import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function probe(code: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, TMPDIR: '/Users/thehound/.hermes/cache/scratch', HQ_HOST: '1', SESSION_SECRET: 'engine-test', DB_PATH: ':memory:' },
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
      const r=await configApi.request('/bots/b/engine',{method:'PATCH',headers:{cookie:'zoeybot_session=test-session','content-type':'application/json'},body:JSON.stringify(choice)});
      assert.equal(r.status,200,await r.text());
      const row=db.prepare('SELECT provider,model FROM bots WHERE id=?').get('b'); assert.deepEqual(row,choice);
    }
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
