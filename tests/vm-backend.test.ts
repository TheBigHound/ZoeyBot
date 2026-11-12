import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XAI_|COMPOSIO_|ORGO_|HQ_|SESSION_SECRET)/.test(k)));
function probe(code: string, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), env: { ...cleanEnv(), ...extra }, encoding: 'utf8', timeout: 15000,
  });
}
test('VM mode starts without cloud credentials and uses a local logical computer', () => {
  const r = probe(`const {env}=await import('./server/src/env.ts'); console.log(JSON.stringify(env));`, { HQ_VM: '1', SESSION_SECRET: 'test-only' });
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(r.stdout);
  assert.equal(e.vmBox, true);
  assert.equal(e.orgoComputerId, 'utm-local');
  assert.equal(e.xaiKey, '');
  assert.equal(e.composioKey, '');
  assert.equal(e.orgoKey, '');
  assert.equal(e.hostname, '127.0.0.1');
  assert.equal(e.devLogin, true);
});
test('VM transport isolates shell environment, validates displays and fixes tunnel ports', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {sshArgs, remoteCommand, vncUrlFor, displayNumber}=await import('./server/src/vm.ts');
    assert.equal(displayNumber('default'),99);
    assert.equal(displayNumber('screen-100'),100);
    assert.throws(()=>displayNumber('screen-100;touch /tmp/oops'));
    assert.equal(vncUrlFor('screen-100'),'ws://127.0.0.1:6100');
    const args=sshArgs();
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.some(a => a.startsWith('UserKnownHostsFile=') && !a.includes('/.ssh/known_hosts')));
    assert.ok(args.includes('bot@127.0.0.1'));
    assert.match(remoteCommand('screen-100'),/sudo -n env -i/);
    assert.match(remoteCommand('screen-100'),/DISPLAY=:100/);
    assert.ok(!remoteCommand('default').includes('SESSION_SECRET'));
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only' });
  assert.equal(r.status, 0, r.stderr);
});
test('VM backend dispatches desktop operations over SSH and rejects failed commands', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {createVmBackend}=await import('./server/src/vm-desktop.ts');
    const calls=[];
    const vm=createVmBackend(async (command,timeout,screen)=>{calls.push({command,timeout,screen}); return {exit_code:0,output:JSON.stringify({id:'utm-local',status:'running'})};});
    assert.equal((await vm.getComputer('utm-local')).status,'running');
    await vm.type('utm-local','screen-100',"hello '世界'");
    assert.equal(calls.length,2);
    assert.equal(calls[1].screen,'screen-100');
    assert.ok(calls[1].command.startsWith('python3 -c '));
    await assert.rejects(()=>vm.suspend('utm-local'),/never suspends/);
    const bad=createVmBackend(async ()=>({exit_code:255,output:'connection refused'}));
    await assert.rejects(()=>bad.getComputer('utm-local'),/connection refused/);
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only' });
  assert.equal(r.status, 0, r.stderr);
});
test('box and Orgo compatibility facade route VM bash into SSH, never cloud HTTP', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-test-'));
    const fixture = '#!/bin/bash\\nlast="\${!#}"\\nexec /bin/bash -c "\${last#sudo -n }"\\n';
    fs.writeFileSync(path.join(dir,'ssh'),fixture,{mode:0o755});
    process.env.PATH=dir+':'+process.env.PATH;
    globalThis.fetch=()=>{throw new Error('cloud access forbidden')};
    try {
      const {box}=await import('./server/src/box.ts');
      const {orgo}=await import('./server/src/orgo.ts');
      const r=await box.bash('printf "%s:%s" "$DISPLAY" "\${SESSION_SECRET-unset}"',10,'screen-100');
      assert.equal(r.exit_code,0); assert.equal(r.output,':100:unset');
      const s=await orgo.bash('utm-local','default','printf "%s" "$DISPLAY"',10);
      assert.equal(s.output,':99'); assert.equal(s.success,true);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only' });
  assert.equal(r.status, 0, r.stderr);
});
test('VM relay connects to loopback websockify without Orgo credentials', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {vncTarget}=await import('./server/src/vnc.ts');
    assert.deepEqual(await vncTarget('utm-local','default'),{url:'ws://127.0.0.1:6099',password:''});
    assert.deepEqual(await vncTarget('utm-local','screen-101'),{url:'ws://127.0.0.1:6101',password:''});
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only', DB_PATH: ':memory:' });
  assert.equal(r.status, 0, r.stderr);
});
test('missing Composio key is import-safe but operations explicitly unavailable', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {catalog,sessionFor}=await import('./server/src/composio.ts');
    globalThis.fetch=()=>{throw new Error('network forbidden')};
    await assert.rejects(()=>catalog(),e=>{assert.equal(e.status,503);assert.match(e.message,/COMPOSIO_API_KEY.*unavailable/);return true});
    await assert.rejects(()=>sessionFor('test'),/COMPOSIO_API_KEY.*unavailable/);
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only', DB_PATH: ':memory:' });
  assert.equal(r.status, 0, r.stderr);
});
test('remote file errors are not silently decoded or ignored', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {box}=await import('./server/src/box.ts');
    box.bash=async()=>({exit_code:255,output:'ssh connection failed'});
    await assert.rejects(()=>box.readFile('/root/a'),/ssh connection failed/);
    await assert.rejects(()=>box.writeFile('/root/a','test','0644; touch hacked'),/mode/);
    let n=0;
    box.bash=async()=> ++n===1?{exit_code:0,output:'ok'}:{exit_code:1,output:'disk full'};
    await assert.rejects(()=>box.writeFile('/root/a','test'),/disk full/);
    assert.equal(n,2);
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only' });
  assert.equal(r.status, 0, r.stderr);
});
test('VM Library downloads are confined, bounded, and preserve empty files', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import {spawnSync} from 'node:child_process';
    const {box}=await import('./server/src/box.ts');
    box.bash=async(command)=>{const r=spawnSync('bash',['-c',command],{encoding:'utf8'});return {exit_code:r.status,output:r.stdout+r.stderr}};
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"hq-library-'"));
    try {
      const root=path.join(dir,'library'); fs.mkdirSync(root);
      fs.writeFileSync(path.join(root,'hello.txt'),'hello 世界');
      fs.writeFileSync(path.join(root,'empty'),'');
      fs.writeFileSync(path.join(dir,'outside'),'private');
      fs.symlinkSync(path.join(dir,'outside'),path.join(root,'link'));
      assert.equal((await box.readConfinedFile(root,'hello.txt')).toString(),'hello 世界');
      assert.equal((await box.readConfinedFile(root,'empty')).length,0);
      assert.equal(await box.readConfinedFile(root,'link'),null);
      assert.equal(await box.readConfinedFile(root,'../outside'),null);
      assert.equal(await box.readConfinedFile(root,'missing'),null);
      await assert.rejects(()=>box.readConfinedFile(root,'hello.txt',2),/too large/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only' });
  assert.equal(r.status, 0, r.stderr);
});
test('VM local request guard rejects foreign origins and DNS rebinding hosts', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {isLocalRequest}=await import('./server/src/vm.ts');
    assert.equal(isLocalRequest('127.0.0.1:8787','http://localhost:5173'),true);
    assert.equal(isLocalRequest('localhost:8787',undefined),true);
    assert.equal(isLocalRequest('evil.example:8787',undefined),false);
    assert.equal(isLocalRequest('127.0.0.1:8787','https://evil.example'),false);
    assert.equal(isLocalRequest('localhost:8787','null'),false);
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only' });
  assert.equal(r.status, 0, r.stderr);
});
test('simultaneous VM screen leases never assign the same existing screen', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {db}=await import('./server/src/db.ts');
    const {orgo}=await import('./server/src/orgo.ts');
    const {screenFor}=await import('./server/src/computer.ts');
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','test@localhost','Test',0);
    for (const b of ['a','b']) db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(b,'u',b,'managed',0,0);
    orgo.getComputer=async()=>({id:'utm-local',name:'test',status:'running'});
    orgo.listScreens=async()=>[{id:'default',display:':99',default:true,width:1440,height:900},{id:'screen-100',display:':100',default:false,width:1440,height:900}];
    orgo.createScreen=async()=>({id:'screen-101',display:':101',default:false,width:1440,height:900});
    const [a,b]=await Promise.all([screenFor('u','a'),screenFor('u','b')]);
    assert.notEqual(a.screenId,b.screenId);
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only', DB_PATH: ':memory:' });
  assert.equal(r.status, 0, r.stderr);
});
test('VM work preparation checks the tunneled Chrome CDP endpoint', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    const {db}=await import('./server/src/db.ts');
    const {orgo}=await import('./server/src/orgo.ts');
    const {box}=await import('./server/src/box.ts');
    const {screenForWork}=await import('./server/src/computer.ts');
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','test@localhost','Test',0);
    db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('a','u','Test','primary',0,0);
    orgo.getComputer=async()=>({id:'utm-local',name:'test',status:'running'});
    orgo.listScreens=async()=>[{id:'default',display:':99',default:true,width:1440,height:900}];
    box.bash=async()=>({exit_code:0,output:'HQ_OK'});
    let checked=''; globalThis.fetch=async(url)=>{checked=url;return {ok:true}};
    await screenForWork('u','a');
    assert.equal(checked,'http://127.0.0.1:9299/json/version');
  `, { HQ_VM: '1', SESSION_SECRET: 'test-only', DB_PATH: ':memory:' });
  assert.equal(r.status, 0, r.stderr);
});
test('cloud mode preserves Orgo API and authenticated VNC URLs', () => {
  const r = probe(`
    import assert from 'node:assert/strict';
    let seen;
    globalThis.fetch=async(url,options)=>{seen={url,options}; return {ok:true,text:async()=>JSON.stringify({password:'test-password'})}};
    const {orgo}=await import('./server/src/orgo.ts');
    const {vncTarget}=await import('./server/src/vnc.ts');
    await orgo.click('cloud-id','screen-100',{x:1,y:2});
    assert.equal(seen.url,'https://www.orgo.ai/api/computers/cloud-id/click?screen=screen-100');
    assert.equal(seen.options.headers.Authorization,'Bearer test-orgo');
    assert.equal(seen.options.body,JSON.stringify({x:1,y:2}));
    const target=await vncTarget('cloud-id','screen-100');
    assert.equal(target.url,'wss://www.orgo.ai/desktops/cloud-id/ws/websockify?token=test-password&screen=screen-100');
  `, { XAI_API_KEY:'test-xai', COMPOSIO_API_KEY:'test-composio', ORGO_API_KEY:'test-orgo', SESSION_SECRET:'test-only', DB_PATH: ':memory:' });
  assert.equal(r.status, 0, r.stderr);
});
test('cloud mode still requires credentials', () => {
  const r = probe(`await import('./server/src/env.ts');`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Missing env XAI_API_KEY/);
});
