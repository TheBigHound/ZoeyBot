// Local-only integration. Does NOT restart any gateway or the app.
// node --env-file=.env --import tsx tests/vm-agent-live-smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { env } from '../server/src/env.ts';
import { db } from '../server/src/db.ts';
import { mcpApi } from '../server/src/mcp.ts';
import { mcpToken } from '../server/src/engine.ts';
import { vmBash } from '../server/src/vm.ts';
assert.equal(env.vmBox, true, 'Local VM only');
const bot = db.prepare("SELECT id FROM bots WHERE engine='primary' LIMIT 1").get();
assert.ok(bot, 'Existing primary bot required');
const token = mcpToken('primary');
const quote = s => `'${s.replace(/'/g, `'\\''`)}'`;
async function guest(source) {
  const r = await vmBash(`python3 -c ${quote(source)}`, 15, 'default');
  assert.equal(r.exit_code, 0, r.output);
  return JSON.parse(r.output);
}
async function call(name, args) {
  const response = await mcpApi.request('/primary', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const { result, error } = await response.json();
  assert.ok(!error, JSON.stringify(error));
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
}
const browser = async args => JSON.parse((await call('vm_browser', args)).content[0].text);
const originalTabs = (await browser({ action: 'tabs' })).tabs;
const originalTab = originalTabs[0]?.tab_id;
const unique = crypto.randomBytes(8).toString('hex');
let fixture;
let tab;
try {
  // Disposable loopback-only fixture process inside guest; never navigate a user's existing tab.
  const html = `<!doctype html><meta charset="utf-8"><title>VM browser smoke</title><h1>Controlled local page</h1><input id="name" aria-label="Name"><button id="act" onclick="document.querySelector('#result').textContent='clicked: '+document.querySelector('#name').value">Apply</button><p id="result">waiting</p>`;
  const serverSource = `from http.server import BaseHTTPRequestHandler, HTTPServer
import base64
PAGE=base64.b64decode('${Buffer.from(html).toString('base64')}')
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers();self.wfile.write(PAGE)
 def log_message(self,*a): pass
s=HTTPServer(('127.0.0.1',0),H)
open('/run/bot-hq/browser-smoke-${unique}','w').write(str(s.server_port))
s.serve_forever()
`;
  fixture = await guest(`import json, subprocess, sys,base64
source=base64.b64decode('${Buffer.from(serverSource).toString('base64')}').decode()
p=subprocess.Popen([sys.executable,'-c',source],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
import time,pathlib
path=pathlib.Path('/run/bot-hq/browser-smoke-${unique}')
for _ in range(50):
 if path.exists(): break
 time.sleep(.1)
print(json.dumps(dict(pid=p.pid,port=int(path.read_text()))))`);
  tab = await guest(`import json,urllib.request
r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9299/json/new?about:blank',method='PUT'))
print(r.read().decode())`);
  const tab_id = tab.id;
  await guest(`import json,urllib.request
urllib.request.urlopen('http://127.0.0.1:9299/json/activate/${tab_id}').read()
print(json.dumps(True))`);
  const page = await browser({ action: 'navigate', tab_id, url: `http://127.0.0.1:${fixture.port}/` });
  assert.equal(page.title, 'VM browser smoke');
  assert.match(page.text, /Controlled local page/);
  assert.ok(page.elements.some(e => e.selector === '#act'));
  const unicodeLimit = '界'.repeat(16000);
  assert.equal((await browser({ action: 'fill', tab_id, selector: '#name', text: unicodeLimit })).value, unicodeLimit);
  const fill = await browser({ action: 'fill', tab_id, selector: '#name', text: "guest-only '世界'" });
  assert.equal(fill.value, "guest-only '世界'");
  await browser({ action: 'click', tab_id, selector: '#act' });
  const read = await browser({ action: 'read', tab_id });
  assert.match(read.text, /clicked: guest-only '世界'/);
  // Exercise actual guest desktop input at the fixture's screenshot-verified input position.
  await call('vm_computer', { action: 'click', x: 80, y: 197 });
  await call('vm_computer', { action: 'key', key: 'CTRL+A' });
  await call('vm_computer', { action: 'type', text: 'desktop input verified' });
  await browser({ action: 'click', tab_id, selector: '#act' });
  assert.match((await browser({ action: 'read', tab_id })).text, /clicked: desktop input verified/);
  fs.mkdirSync('tests/out', { recursive: true });
  const shots = [];
  for (const [name, args, filename] of [
    ['vm_browser', { action: 'screenshot', tab_id }, 'vm-agent-browser.jpg'],
    ['vm_computer', { action: 'screenshot' }, 'vm-agent-desktop.jpg'],
  ]) {
    const result = await call(name, args);
    const image = result.content.find(c => c.type === 'image');
    assert.equal(image.mimeType, 'image/jpeg');
    const bytes = Buffer.from(image.data, 'base64');
    assert.equal(bytes.readUInt16BE(0), 0xffd8);
    assert.ok(bytes.length > 1000);
    fs.writeFileSync('tests/out/' + filename, bytes);
    shots.push({ name, bytes: bytes.length });
  }
  console.log(JSON.stringify({ ok: true, navigate: true, read: true, browserClick: true, fill: true, desktopKeyType: true, screenshots: shots }));
} finally {
  if (tab?.id) {
    await guest(`import json,urllib.request
urllib.request.urlopen('http://127.0.0.1:9299/json/close/${tab.id}').read()
print(json.dumps(True))`);
  }
  if (originalTab) {
    await guest(`import json,urllib.request
urllib.request.urlopen('http://127.0.0.1:9299/json/activate/${originalTab}').read()
print(json.dumps(True))`);
  }
  if (fixture?.pid) {
    await guest(`import os,json,pathlib,signal,socket,time
os.kill(${fixture.pid},signal.SIGTERM)
path=pathlib.Path('/run/bot-hq/browser-smoke-${unique}')
path.unlink(missing_ok=True)
for _ in range(50):
 try:
  with socket.create_connection(('127.0.0.1',${fixture.port}),timeout=.1): pass
 except OSError: break
 time.sleep(.1)
else: raise RuntimeError('Fixture still listening after stop')
assert not path.exists()
print(json.dumps(True))`);
  }
  const restored = (await browser({ action: 'tabs' })).tabs;
  assert.deepEqual(new Set(restored.map(t => t.tab_id)), new Set(originalTabs.map(t => t.tab_id)), 'All original tabs must remain; fixture tab must be removed');
  console.log(JSON.stringify({ restoredOriginalTabs: true, fixtureStopped: true }));
}
