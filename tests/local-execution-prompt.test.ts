import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROBE=`
   import {db} from './server/src/db.ts';
   import {instructionsFor} from './server/src/agent/prompt.ts';
   db.exec("ALTER TABLE bots ADD COLUMN hidden INTEGER DEFAULT 0; ALTER TABLE bots ADD COLUMN kind TEXT DEFAULT 'agent'; ALTER TABLE bots ADD COLUMN members TEXT;");
   db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('user-test','test@example.invalid','Test',0);
   db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot-test','user-test','Test Bot',0,0);
   process.stdout.write(await instructionsFor('user-test','bot-test'));
   db.close();
  `;

function prompt(extra:Record<string,string>){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hq-prompt-'));
 try {
  const r=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',PROBE],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,HQ_HOST:'1',COMPOSIO_API_KEY:'',SESSION_SECRET:'prompt-test-only',DB_PATH:path.join(dir,'test.db'),...extra}});
  assert.equal(r.status,0,r.stderr);
  return r.stdout;
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

test('prompt carries the local voice notes and the ask_bot contract',()=>{
  const out=prompt({});
  assert.match(out,/Enable local voice/);
  assert.match(out,/phonon\/Zoey/);
  assert.match(out,/cannot enable it from chat or verify browser playback/);
  assert.match(out,/blue waveform button/);
  assert.match(out,/turn-based voice conversation/);
  assert.doesNotMatch(out,/voice calls are not supported/i);
  assert.doesNotMatch(out,/send_to_bot/);
  assert.match(out,/- ask_bot asks another agent on the team/);
  assert.match(out,/wait=true/);
  assert.match(out,/wait=false/);
  assert.match(out,/Do not poll/);
});

test('prompt leads with the Mac execution rules and has no shared screen or VM text',()=>{
  const out=prompt({});
  assert(out.startsWith("# Execution rules\nYour terminal, file and browser tools run on the owner's Mac, in your working directory."), out.slice(0,200));
  assert.match(out,/never invent command output/);
  assert.match(out,/never modify another bot's home/);
  assert.match(out,/## Your computer\nYou work on the owner's Mac from your own working directory and Hermes home; there is no separate screen to watch\./);
  assert.doesNotMatch(out,/local VM/);
  assert.doesNotMatch(out,/own screen on a Linux computer/);
  assert.doesNotMatch(out,/\/root\/zoeybot/);
  assert.match(out,/`library` folder of your Hermes home/);
  assert.equal(out, prompt({}), 'the prompt must not depend on the clock');
});
