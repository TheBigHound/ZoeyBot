// Set up the actual primary bot's guest desktop without changing its identity.
import { db } from '../server/src/db.ts';
import { dressScreen } from '../server/src/desk.ts';
import { env } from '../server/src/env.ts';
if (!env.vmBox) throw new Error('Local VM mode is required');
const b = db.prepare("SELECT id,name,label,avatar_shape,avatar_color FROM bots WHERE engine='primary' ORDER BY created_at LIMIT 1").get();
if (!b) throw new Error('Sign into the local app before preparing its primary desktop');
await dressScreen({id:b.id,name:b.name,label:b.label??'',avatarShape:b.avatar_shape,avatarColor:b.avatar_color},'default');
console.log(JSON.stringify({ok:true,botId:b.id,screen:'default',cdp:'http://127.0.0.1:9299'}));
