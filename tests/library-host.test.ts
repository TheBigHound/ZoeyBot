import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The Library in host mode: save_file writes into <bot's Hermes home>/library, the listing and raw
// download routes read from there, and nothing can reach outside that folder.

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XAI_|COMPOSIO_|HQ_|HERMES_|ENGINES_DIR|DB_PATH|SESSION_SECRET)/.test(k)));
function probe(code: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
    env: { ...cleanEnv(), TMPDIR: '/Users/thehound/.hermes/cache/scratch', HQ_HOST: '1', SESSION_SECRET: 'library-test', DB_PATH: ':memory:' },
  });
}

const SETUP = `
  import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-library-'));
  const primary=path.join(dir,'primary'); fs.mkdirSync(primary);
  process.env.HERMES_HOME_PRIMARY=primary; process.env.ENGINES_DIR=path.join(dir,'engines');
  const {db}=await import('./server/src/db.ts');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','u@local','User',0);
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('s','u',0,Date.now()+60000);
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine) VALUES (?,?,?,?,?,?)').run('p','u','Zoey',0,0,'primary');
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine,engine_port) VALUES (?,?,?,?,?,?,?)').run('m','u','Coder',0,0,'managed',8650);
  const {toolMap,libraryDir,libraryPath}=await import('./server/src/agent/tools.ts');
  const save=(botId,filename,content)=>toolMap.get('save_file').impl({filename,content},{userId:'u',botId,depth:0,askBot:async()=>({output:'',summary:''})});
`;

test('save_file writes under the bot\'s own Hermes home /library (primary and managed)', () => {
  const r = probe(SETUP + `
    try {
      assert.equal(libraryDir('p'), path.join(primary,'library'));
      assert.equal(libraryDir('m'), path.join(process.env.ENGINES_DIR,'m','library'));
      assert.equal(libraryDir('nobody'), null);

      const a=await save('p','briefing 2026-11-12.md','# hi');
      const out=JSON.parse(a.output);
      assert.equal(out.ok,true);
      assert.equal(out.path, path.join(fs.realpathSync(primary),'library','briefing_2026-11-12.md'));
      assert.equal(fs.readFileSync(out.path,'utf8'),'# hi');
      assert.equal(a.summary,'Saved briefing_2026-11-12.md');

      const b=await save('m','notes.txt','managed');
      assert.equal(fs.readFileSync(path.join(process.env.ENGINES_DIR,'m','library','notes.txt'),'utf8'),'managed');

      // Filenames are flattened: no directories, no dot-prefix escapes, never outside the folder.
      const c=await save('p','../../escape.txt','nope');
      assert.equal(JSON.parse(c.output).path, path.join(fs.realpathSync(primary),'library','escape.txt'));
      assert.ok(!fs.existsSync(path.join(dir,'escape.txt')));
      assert.ok(!fs.existsSync(path.join(primary,'escape.txt')));

      const d=await save('nobody','x.txt','x');
      assert.match(d.output,/no Library/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `);
  assert.equal(r.status, 0, r.stderr);
});

test('libraryPath confines paths: .., absolute paths and symlinks out of the folder are rejected', () => {
  const r = probe(SETUP + `
    try {
      const root=libraryPath('p','');
      assert.equal(root, fs.realpathSync(libraryDir('p')), 'resolving the empty path creates the folder and returns its real path');
      fs.mkdirSync(path.join(root,'sub'));
      fs.writeFileSync(path.join(root,'sub','ok.txt'),'ok');
      fs.writeFileSync(path.join(dir,'secret.txt'),'secret');
      fs.symlinkSync(path.join(dir,'secret.txt'), path.join(root,'leak.txt'));
      fs.symlinkSync(dir, path.join(root,'leakdir'));
      assert.equal(libraryPath('p',''), root);
      assert.equal(libraryPath('p','sub/ok.txt'), path.join(root,'sub','ok.txt'));
      assert.equal(libraryPath('p','new/file.txt'), path.join(root,'new','file.txt'), 'missing parts are allowed (for new files)');
      assert.equal(libraryPath('p','../secret.txt'), null);
      assert.equal(libraryPath('p','sub/../../secret.txt'), null);
      assert.equal(libraryPath('p','/etc/passwd'), path.join(root,'etc','passwd'), 'an absolute path is taken relative to the library, never the filesystem root');
      assert.equal(libraryPath('p','leak.txt'), null, 'symlink to a file outside');
      assert.equal(libraryPath('p','leakdir/secret.txt'), null, 'symlink to a directory outside');
      assert.equal(libraryPath('p','a\\u0000b'), null);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `);
  assert.equal(r.status, 0, r.stderr);
});

test('library routes list and download from the host folder and refuse traversal', () => {
  const r = probe(SETUP + `
    try {
      const {configApi}=await import('./server/src/routes-config.ts');
      const H={cookie:'zoeybot_session=s'};
      const get=(u)=>configApi.request(u,{headers:H});

      let res=await get('/bots/p/files'); assert.equal(res.status,200);
      let j=await res.json(); assert.equal(j.status,'ok'); assert.deepEqual(j.files,[]);
      assert.ok(fs.statSync(path.join(primary,'library')).isDirectory(),'listing creates the folder');

      await save('p','report.md','# report');
      fs.mkdirSync(path.join(primary,'library','drafts')); fs.writeFileSync(path.join(primary,'library','drafts','d1.txt'),'draft');
      fs.writeFileSync(path.join(dir,'outside.txt'),'outside');
      fs.symlinkSync(path.join(dir,'outside.txt'), path.join(primary,'library','link.txt'));

      j=await (await get('/bots/p/files')).json();
      assert.deepEqual(j.files.map(f=>f.name),['drafts','report.md'],'folders first; symlinks are not listed');
      assert.ok(j.files.find(f=>f.name==='drafts').isDir);
      assert.equal(j.files.find(f=>f.name==='report.md').size,8);
      j=await (await get('/bots/p/files?path=drafts')).json();
      assert.deepEqual(j.files.map(f=>f.name),['d1.txt']);
      res=await get('/bots/p/files?path=../'); assert.equal(res.status,400);
      res=await get('/bots/p/files?path=a/../b'); assert.equal(res.status,400);
      j=await (await get('/bots/p/files?path=/drafts/')).json(); // leading/trailing slashes are trimmed, still inside the library
      assert.deepEqual(j.files.map(f=>f.name),['d1.txt']);
      j=await (await get('/bots/p/files?path=nope')).json(); assert.equal(j.status,'error');

      res=await configApi.request('/bots/p/files/download',{method:'POST',headers:{...H,'content-type':'application/json'},body:JSON.stringify({path:'drafts/d1.txt'})});
      assert.equal(res.status,200); const {url}=await res.json();
      assert.equal(url,'/api/bots/p/files/raw?path=drafts%2Fd1.txt');

      res=await get('/bots/p/files/raw?path=drafts/d1.txt'); assert.equal(res.status,200);
      assert.equal(await res.text(),'draft');
      assert.match(res.headers.get('content-disposition'),/d1\\.txt/);
      res=await get('/bots/p/files/raw?path=link.txt'); assert.equal(res.status,404,'symlink out of the library');
      res=await get('/bots/p/files/raw?path=../outside.txt'); assert.equal(res.status,400);
      res=await get('/bots/p/files/raw?path=drafts'); assert.equal(res.status,404,'directories are not files');
      res=await get('/bots/p/files/raw?path=missing.txt'); assert.equal(res.status,404);
      res=await configApi.request('/bots/p/files/raw?path=report.md'); assert.equal(res.status,401,'needs a session');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `);
  assert.equal(r.status, 0, r.stderr);
});
