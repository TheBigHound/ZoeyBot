import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('local VM prompt leads with actual-tool execution policy, not app persona',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-prompt-'));
 try {
  const code=`
   import {db} from './server/src/db.ts';
   import {instructionsFor} from './server/src/agent/prompt.ts';
   db.exec("ALTER TABLE bots ADD COLUMN hidden INTEGER DEFAULT 0; ALTER TABLE bots ADD COLUMN kind TEXT DEFAULT 'agent'; ALTER TABLE bots ADD COLUMN members TEXT;");
   db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('user-test','test@example.invalid','Test',0);
   db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot-test','user-test','Test Bot',0,0);
   process.stdout.write(await instructionsFor('user-test','bot-test'));
   db.close();
  `;
  const r=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,HQ_VM:'1',HQ_LOCAL:'0',COMPOSIO_API_KEY:'',SESSION_SECRET:'prompt-test-only',DB_PATH:path.join(dir,'test.db')}});
  assert.equal(r.status,0,r.stderr);
  assert(r.stdout.startsWith('# Execution rules for this local VM'), 'Local execution policy must precede app-specific instructions');
  assert.match(r.stdout,/must issue a real tool call before reporting results/);
  assert.match(r.stdout,/never the Mac host/);
  assert.match(r.stdout,/Enable local voice/);
  assert.match(r.stdout,/phonon\/Zoey/);
  assert.match(r.stdout,/cannot enable it from chat or verify browser playback/);
  assert.match(r.stdout,/Local live voice calls are not supported/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
