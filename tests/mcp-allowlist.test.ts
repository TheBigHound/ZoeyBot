import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * Host mode: a bot's toolset allowlist also governs the app's own MCP endpoint. Without 'apps' a
 * bot sees no connected-app tools; without 'terminal' it cannot reach Composio's remote shells
 * even when it has 'apps'.
 */

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XAI_|COMPOSIO_|HQ_|SESSION_SECRET)/.test(k)));
function probe(code: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), env: { ...cleanEnv(), HQ_HOST: '1', SESSION_SECRET: 'test-only', DB_PATH: ':memory:', ...extra }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
}

test('per-bot allowlist gates connected-app tools and remote shells on the MCP endpoint', () => {
  probe(`
    import assert from 'node:assert/strict';
    const {db}=await import('./server/src/db.ts');
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u','test@localhost','Test',0);
    const mk=(id,toolsets)=>db.prepare('INSERT INTO bots(id,user_id,name,engine,toolsets,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,'u',id,'managed',toolsets,0,0);
    mk('full', null);                                        // default allowlist: apps + terminal
    mk('mail', JSON.stringify(['file','todo','memory','apps'])); // apps, no terminal
    mk('watch', JSON.stringify(['web','browser','file']));   // no apps at all
    const {mcpApi,mcpDeps}=await import('./server/src/mcp.ts');
    mcpDeps.composioTools=async()=>[
      {type:'function',name:'GMAIL_FETCH_EMAILS',description:'',parameters:{type:'object',properties:{}}},
      {type:'function',name:'COMPOSIO_REMOTE_BASH_TOOL',description:'',parameters:{type:'object',properties:{}}},
    ];
    mcpDeps.runComposioTool=async(_ctx,name)=>({output:'RAN '+name,summary:'done'});
    const {mcpToken}=await import('./server/src/engine.ts');
    const request=async(slug,method,params)=>(await mcpApi.request('/'+slug,{method:'POST',headers:{authorization:'Bearer '+mcpToken(slug),'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
    const names=async(slug)=>(await request(slug,'tools/list')).result.tools.map(t=>t.name);
    const full=await names('full');
    assert.ok(full.includes('GMAIL_FETCH_EMAILS') && full.includes('COMPOSIO_REMOTE_BASH_TOOL') && full.includes('ask_bot'));
    const mail=await names('mail');
    assert.ok(mail.includes('GMAIL_FETCH_EMAILS'), 'apps allowed');
    assert.ok(!mail.includes('COMPOSIO_REMOTE_BASH_TOOL'), 'no remote shell without terminal');
    const watch=await names('watch');
    assert.ok(!watch.some(n=>n.startsWith('GMAIL_')||n.startsWith('COMPOSIO_')), 'no apps at all');
    assert.ok(watch.includes('ask_bot'), 'own tools stay');
    // Calling is refused too, not just hidden.
    const shell=await request('mail','tools/call',{name:'COMPOSIO_REMOTE_BASH_TOOL',arguments:{command:'whoami'}});
    assert.equal(shell.result.isError,true);assert.match(shell.result.content[0].text,/not in your allowlist/);
    const gmail=await request('watch','tools/call',{name:'GMAIL_FETCH_EMAILS',arguments:{}});
    assert.equal(gmail.result.isError,true);
    process.exit(0);
  `);
});
