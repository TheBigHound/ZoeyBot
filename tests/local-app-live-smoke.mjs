// Live app integration (host mode): authenticates through the local-only dev endpoint.
// Run: node tests/local-app-live-smoke.mjs [--voice] [--chat]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const base = process.env.ZOEYBOT_URL ?? 'http://127.0.0.1:8787';
const email = process.env.ZOEYBOT_EMAIL ?? 'TheHound@HoundBuilt.com';
const health = await (await fetch(base+'/api/health')).json();
assert.equal(health.ok,true);
const login=await fetch(base+'/api/auth/dev',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,name:'TheHound'})});
assert.equal(login.status,200);
const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
assert(cookie,'Local login did not create a session');
const bots=await (await fetch(base+'/api/bots',{headers:{cookie}})).json();
assert(bots.bots.length,'No bot exists');
const botId=bots.bots[0].id;
const engine=(await (await fetch(base+`/api/bots/${botId}/engine`,{headers:{cookie}})).json()).engine;
assert.equal(engine.execution,'host');assert.equal(engine.status,'ready',`engine ${engine.status}: ${engine.error??''}`);
const options=await (await fetch(base+'/api/voice/options',{headers:{cookie}})).json();
assert.equal(options.provider,'local');assert(options.voices.some(v=>v.id==='Zoey'));
assert.equal(options.capabilities.tts,true,'Local TTS must be available in the running app');
assert.equal(options.capabilities.stt,true,'Cached local Whisper must be available in the running app');
let voiceVerified=false;
if(process.argv.includes('--voice')) {
 const speech=await fetch(base+'/api/voice/preview',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({botId,text:'Zoey is speaking locally.',codec:'pcm'})});
 assert.equal(speech.status,200,'Running app could not synthesize local PCM');
 assert.match(speech.headers.get('content-type'),/^audio\/pcm;rate=24000$/);
 const pcm=Buffer.from(await speech.arrayBuffer());assert(pcm.length>4800&&pcm.length%2===0,'Invalid local PCM audio');
 const wav=Buffer.alloc(44+pcm.length);wav.write('RIFF',0);wav.writeUInt32LE(36+pcm.length,4);wav.write('WAVEfmt ',8);
 wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);
 wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);
 const form=new FormData();form.append('language','en');form.append('file',new Blob([wav],{type:'audio/wav'}),'local-zoey.wav');
 const transcribed=await fetch(base+'/api/voice/stt',{method:'POST',headers:{cookie},body:form});
 assert.equal(transcribed.status,200,'Running app could not transcribe local audio');
 assert.match((await transcribed.json()).text,/speaking locally/i,'Actual local speech did not round-trip through Whisper');
 voiceVerified=true;
}
let chatVerified=false;
if(process.argv.includes('--chat')) {
 const marker=randomUUID();const markerPath=path.join(os.tmpdir(),'zoeybot-smoke-'+marker);
 const command=`hostname; whoami; pwd; printf '%s' '${marker}' > '${markerPath}'`;
 const sent=await fetch(base+`/api/bots/${botId}/messages`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({text:`Installation verification: you must actually call your terminal tool to run this new command, not reuse prior output: ${command}. Return the real hostname, user, and directory.`})});
 assert.equal(sent.status,200);const baseline=(await sent.json()).row.seq;
 const deadline=Date.now()+120000;
 while(Date.now()<deadline) {
  const result=await(await fetch(base+`/api/bots/${botId}/rows`,{headers:{cookie}})).json();
  const fresh=result.rows.filter(r=>r.seq>baseline);
  const call=fresh.find(r=>r.body.type==='tool-call'&&r.body.name==='terminal'&&r.body.status==='done');
  const answer=fresh.find(r=>r.body.type==='message'&&r.body.role==='assistant'&&!r.body.streaming&&r.body.text.includes(os.userInfo().username));
  if(call&&answer){chatVerified=true;break;}
  const error=fresh.find(r=>r.kind==='notice'&&r.body.tone==='error');
  assert(!error,error?.body.text);
  await new Promise(r=>setTimeout(r,500));
 }
 assert(chatVerified,'No real completed terminal call and matching final answer arrived');
 const readBack=fs.readFileSync(markerPath,'utf8');fs.rmSync(markerPath,{force:true});
 assert.equal(readBack,marker,'Agent did not write the requested real file on this Mac');
}
console.log(JSON.stringify({ok:true,botId,execution:engine.execution,voiceProvider:options.provider,...(voiceVerified?{localVoiceRoundTrip:true}:{}),...(chatVerified?{localChatAndHostTool:true}:{})}));
