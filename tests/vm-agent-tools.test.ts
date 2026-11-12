import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XAI_|COMPOSIO_|ORGO_|HQ_|SESSION_SECRET)/.test(k)));
function probe(code: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), env: { ...cleanEnv(), HQ_VM: '1', SESSION_SECRET: 'test-only', DB_PATH: ':memory:', ...extra }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
}

test('MCP authenticates bot-scoped VM tools and preserves image blocks and tool errors', () => {
  probe(`
    import assert from 'node:assert/strict';
    const {db}=await import('./server/src/db.ts');
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','test@localhost','Test',0);
    for (const [id,engine] of [['mine','primary'],['other','managed']]) db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,'u',id,engine,0,0);
    const {mcpApi}=await import('./server/src/mcp.ts');
    const {mcpToken}=await import('./server/src/engine.ts');
    const {vmAgentTools}=await import('./server/src/vm-agent-tools.ts');
    const seen=[];vmAgentTools.call=async(name,args,ctx)=>{seen.push({name,args,ctx});if(args.fail)throw Error('guest refused');return {content:[{type:'image',data:'/9j/2Q==',mimeType:'image/jpeg'}]}};
    globalThis.fetch=()=>{throw Error('external request forbidden')};
    const request=async(slug,token,method,params)=>mcpApi.request('/'+slug,{method:'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    assert.equal((await request('mine',mcpToken('other'),'tools/list')).status,401);
    const listed=await(await request('primary',mcpToken('primary'),'tools/list')).json();
    assert.ok(listed.result.tools.some(t=>t.name==='vm_browser'));
    assert.ok(listed.result.tools.some(t=>t.name==='vm_computer'));
    for(const t of listed.result.tools.filter(t=>t.name.startsWith('vm_'))) assert.equal(t.inputSchema.type,'object','MCP requires an object inputSchema root');
    const tooMany=await mcpApi.request('/mine',{method:'POST',headers:{authorization:'Bearer '+mcpToken('mine'),'Content-Type':'application/json'},body:JSON.stringify(Array.from({length:17},(_,id)=>({jsonrpc:'2.0',id,method:'ping'})))});
    assert.equal(tooMany.status,400);
    const shot=await(await request('primary',mcpToken('primary'),'tools/call',{name:'VM_COMPUTER',arguments:{action:'screenshot'}})).json();
    assert.equal(shot.result.content[0].type,'image');
    assert.equal(seen[0].ctx.botId,'mine');assert.equal(seen[0].ctx.userId,'u');
    assert.equal(seen[0].name,'vm_computer');
    const failed=await(await request('other',mcpToken('other'),'tools/call',{name:'vm_browser',arguments:{fail:true}})).json();
    assert.equal(failed.result.isError,true);assert.match(failed.result.content[0].text,/guest refused/);
    assert.equal(seen[1].ctx.botId,'other');
    const oversized=await mcpApi.request('/mine',{method:'POST',headers:{authorization:'Bearer '+mcpToken('mine'),'Content-Type':'application/json'},body:' '.repeat(1048577)});
    assert.equal(oversized.status,413);
    process.exit(0);
  `);
});

test('cloud MCP tool list stays unchanged and never advertises VM control', () => {
  probe(`
    import assert from 'node:assert/strict';
    const {mcpApi}=await import('./server/src/mcp.ts');
    const {mcpToken}=await import('./server/src/engine.ts');
    const r=await mcpApi.request('/primary',{method:'POST',headers:{authorization:'Bearer '+mcpToken('primary'),'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    const j=await r.json();assert.equal(r.status,200);assert.ok(!j.result.tools.some(t=>t.name.startsWith('vm_')));process.exit(0);
  `,{HQ_VM:'0',XAI_API_KEY:'test',COMPOSIO_API_KEY:'test',ORGO_API_KEY:'test'});
});

test('browser requests are typed, bounded, guest-only and cannot override screen/CDP address', () => {
  probe(`
    import assert from 'node:assert/strict';
    const {createVmAgentTools}=await import('./server/src/vm-agent-tools.ts');
    const calls=[];let leases=0;
    const tools=createVmAgentTools({ready:async()=>{leases++;return {computerId:'utm-local',screenId:'screen-102'}},run:async(command,timeout,screen)=>{calls.push({command,timeout,screen});return {exit_code:0,output:JSON.stringify({title:'Guest page',text:'hello'})}}});
    const ctx={userId:'u',botId:'mine'};
    const r=await tools.call('vm_browser',{action:'navigate',url:'http://127.0.0.1:9888/'},ctx);
    assert.match(r.content[0].text,/Guest page/);
    assert.equal(calls[0].screen,'screen-102');
    assert.equal(calls[0].timeout,25);
    assert.ok(calls[0].command.startsWith('python3 -c '));
    assert.match(calls[0].command,/websocket/);
    for(const a of [{action:'navigate',url:'file:///etc/passwd'},{action:'navigate',url:'javascript:alert(1)'},{action:'read',cdp_url:'http://host:9222'},{action:'read',screen:'default'},{action:'read',botId:'other'},{action:'evaluate',expression:'process.env'},{action:'fill',selector:'#x',text:'x'.repeat(16001)},{action:'click',selector:'x'.repeat(1001)},{action:'read',tab_id:'../browser/target'}]) await assert.rejects(()=>tools.call('vm_browser',a,ctx));
    assert.equal(calls.length,1);assert.equal(leases,1);
    const failed=createVmAgentTools({ready:async()=>({computerId:'utm-local',screenId:'default'}),run:async()=>({exit_code:1,output:'CDP refused'})});
    await assert.rejects(()=>failed.call('vm_browser',{action:'read'},ctx),/CDP refused/);
  `);
});

test('computer actions validate before leasing and dispatch only bounded guest operations', () => {
  probe(`
    import assert from 'node:assert/strict';
    const {createVmAgentTools}=await import('./server/src/vm-agent-tools.ts');
    const calls=[];let leases=0;
    const desktop=Object.fromEntries(['click','move','drag','type','key','scroll'].map(op=>[op,async(...args)=>{calls.push([op,...args]);return {success:true}}]));
    const tools=createVmAgentTools({ready:async()=>{leases++;return {computerId:'utm-local',screenId:'screen-100',width:1440,height:900}},desktop});
    const ctx={userId:'u',botId:'b'};
    for(const a of [{action:'click',x:10,y:20,button:'right'},{action:'move',x:1,y:2},{action:'type',text:"hi '世界'"},{action:'key',key:'CTRL+L'},{action:'scroll',x:1,y:2,direction:'down',amount:2},{action:'drag',start_x:1,start_y:2,end_x:3,end_y:4}]) await tools.call('vm_computer',a,ctx);
    assert.equal(calls.length,6);
    assert.ok(calls.every(c=>c[1]==='utm-local'&&c[2]==='screen-100'));
    for(const a of [{action:'click',x:-1,y:2},{action:'click',x:1440,y:2},{action:'type',text:'x'.repeat(16001)},{action:'scroll',x:1,y:2,direction:'up',amount:101},{action:'key',key:'--window 123'},{action:'bash',command:'pwd'},{action:'move',x:1,y:2,screen:'default'}]) await assert.rejects(()=>tools.call('vm_computer',a,ctx));
    assert.equal(calls.length,6);
    assert.equal(leases,6);
  `);
});

test('computer MCP bridge scopes every action to authenticated bot and returns real image content', () => {
  probe(`
    import assert from 'node:assert/strict';
    const {createVmAgentTools, VM_AGENT_TOOLS}=await import('./server/src/vm-agent-tools.ts');
    const seen=[];
    const tools=createVmAgentTools({
      ready:async(ctx)=>{seen.push(ctx);return {computerId:'utm-local',screenId:'screen-101',width:1440,height:900}},
      desktop:{screenshot:async(...args)=>{seen.push(args);return {image:'/9j/2Q==',mime_type:'image/jpeg',width:1440,height:900}}},
    });
    assert.deepEqual(VM_AGENT_TOOLS.map(t=>t.name),['vm_browser','vm_computer']);
    const result=await tools.call('vm_computer',{action:'screenshot'},{userId:'u',botId:'mine'});
    assert.deepEqual(seen,[{userId:'u',botId:'mine'},['utm-local','screen-101']]);
    assert.deepEqual(result.content[1],{type:'image',data:'/9j/2Q==',mimeType:'image/jpeg'});
    assert.match(result.content[0].text,/1440/);
    await assert.rejects(()=>tools.call('vm_computer',{action:'screenshot',screenId:'default'},{userId:'u',botId:'mine'}));
    assert.equal(seen.length,2,'invalid request must not allocate or run anything');
  `);
});
