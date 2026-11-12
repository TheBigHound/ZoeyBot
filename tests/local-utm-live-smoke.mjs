// Live integration test: requires HQ_VM=1, a provisioned guest, and local tunnels.
// Run: node --env-file=.env --import tsx tests/local-utm-live-smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import WebSocket from 'ws';
import { vmDesktop } from '../server/src/vm-desktop.ts';
import { env } from '../server/src/env.ts';
assert.equal(env.vmBox, true, 'This smoke test may only target the local VM');
const computer = await vmDesktop.getComputer('utm-local');
assert.equal(computer.status, 'running');
const shell = await vmDesktop.bash('utm-local', 'default', 'test "$(uname -s)" = Linux && hostname');
assert.equal(shell.exit_code, 0, shell.output);
assert.match(shell.output, /bot-hq/);
const screenshot = await vmDesktop.screenshot('utm-local', 'default');
const image = Buffer.from(screenshot.image, 'base64');
assert.equal(screenshot.width, 1440); assert.equal(screenshot.height, 900);
assert.equal(image.readUInt16BE(0), 0xffd8, 'Guest screenshot must be JPEG');
fs.mkdirSync('tests/out', {recursive: true});
fs.writeFileSync('tests/out/local-utm-desktop.jpg', image);
const screen = await vmDesktop.createScreen('utm-local');
try {
  assert.notEqual(screen.id, 'default');
  const screens = await vmDesktop.listScreens('utm-local');
  assert(screens.some(s => s.id === screen.id));
} finally { await vmDesktop.deleteScreen('utm-local', screen.id); }
await new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:6099');
  const timeout = setTimeout(() => {ws.terminate();reject(new Error('VNC handshake timed out'));}, 10000);
  ws.once('error', e => {clearTimeout(timeout);reject(e);});
  ws.once('message', data => {
    clearTimeout(timeout);
    try {assert.match(data.toString(), /^RFB 003\./);ws.close();resolve();}
    catch(e){ws.terminate();reject(e);}
  });
});
console.log(JSON.stringify({ok:true,guest: shell.output.trim(),screenshot:{width:screenshot.width,height:screenshot.height,bytes:image.length},multiScreen:true,vncHandshake:true}));
