#!/usr/bin/env python3
"""Typed CDP operations executed ONLY inside the dedicated Linux guest.
Requires the Ubuntu python3-websocket package. No host Python/CDP evaluation.
"""
import base64
import json
import re
import signal
import sys
import time
import urllib.parse
import urllib.request

MAX_OUTPUT = 8_000_000


def port_for(screen):
    if screen == 'default':
        return 9299
    if screen not in ('screen-100', 'screen-101', 'screen-102'):
        raise ValueError('Unknown VM screen')
    return 9200 + int(screen[7:])


def validate(req):
    if not isinstance(req, dict):
        raise ValueError('Expected browser request object')
    allowed = {'tabs': set(), 'navigate': {'url'}, 'read': set(),
               'click': {'selector'}, 'fill': {'selector', 'text'}, 'screenshot': set()}
    op = req.get('action')
    if op not in allowed or set(req) - (allowed[op] | {'action', 'tab_id'}):
        raise ValueError('Unknown browser action or fields')
    if 'tab_id' in req and (not isinstance(req['tab_id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', req['tab_id'])):
        raise ValueError('Invalid tab_id')
    if op == 'navigate':
        url = req.get('url')
        if not isinstance(url, str) or len(url) > 4000:
            raise ValueError('Invalid navigation URL')
        parsed = urllib.parse.urlsplit(url)
        if url != 'about:blank' and (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password):
            raise ValueError('Only http(s) URLs or about:blank are allowed')
    if op in ('click', 'fill'):
        selector = req.get('selector')
        if not isinstance(selector, str) or not 1 <= len(selector) <= 1000:
            raise ValueError('Invalid selector')
    if op == 'fill' and (not isinstance(req.get('text'), str) or len(req['text']) > 16000):
        raise ValueError('Invalid fill text')
    return req


READ_SCRIPT = r'''(() => {
  const trim = (s,n) => String(s || '').slice(0,n);
  const selector = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let e=el; e && e.nodeType===1 && parts.length<12; e=e.parentElement) {
      let i=1; for(let p=e.previousElementSibling;p;p=p.previousElementSibling) if(p.localName===e.localName)i++;
      parts.unshift(e.localName + ':nth-of-type(' + i + ')');
    }
    return parts.join(' > ');
  };
  const elements = [];
  for(const e of document.querySelectorAll('a,button,input:not([type=password]):not([type=hidden]),textarea,select,[role=button]')) {
    if (!e.getClientRects().length) continue;
    elements.push({selector:trim(selector(e),1000),tag:e.localName,type:trim(e.type,30),
      label:trim(e.getAttribute('aria-label') || e.innerText || e.placeholder || e.name,200),
      href:e.localName==='a'?trim(e.href,1000):undefined});
    if(elements.length>=100)break;
  }
  return {title:trim(document.title,500),url:trim(location.href,4000),
    text:trim(document.body ? document.body.innerText : '',20000),elements};
})()'''


class CDP:
    def __init__(self, port, tab_id):
        import websocket
        self.ws = websocket.create_connection('ws://127.0.0.1:%s/devtools/page/%s' % (port, tab_id),
                                               timeout=15, suppress_origin=True, http_proxy_host=None)
        self.seq = 0

    def call(self, method, params=None):
        self.seq += 1
        self.ws.send(json.dumps(dict(id=self.seq, method=method, params=params or {})))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            raw = self.ws.recv()
            if not raw or len(raw) > MAX_OUTPUT:
                raise RuntimeError('Invalid or oversized CDP response')
            message = json.loads(raw)
            if message.get('id') == self.seq:
                if 'error' in message:
                    raise RuntimeError(str(message['error'])[:500])
                return message.get('result', {})
        raise TimeoutError('CDP action timed out')

    def close(self):
        self.ws.close()


def evaluate(cdp, expression):
    result = cdp.call('Runtime.evaluate', dict(expression=expression, returnByValue=True, timeout=10000))
    if result.get('exceptionDetails'):
        raise RuntimeError('Browser action failed: ' + str(result['exceptionDetails'].get('exception', {}).get('description', 'JavaScript exception'))[:500])
    return result.get('result', {}).get('value')


def perform(cdp, req, tab_id):
    op = req['action']
    if op == 'screenshot':
        result = cdp.call('Page.captureScreenshot', dict(format='jpeg', quality=75, captureBeyondViewport=False))
        return dict(tab_id=tab_id, image=result['data'], mime_type='image/jpeg')
    if op == 'navigate':
        result = cdp.call('Page.navigate', dict(url=req['url']))
        if result.get('errorText'):
            raise RuntimeError(result['errorText'][:500])
        time.sleep(.2)
        for _ in range(60):
            if evaluate(cdp, "document.readyState === 'complete' || document.readyState === 'interactive'"):
                break
            time.sleep(.1)
        else:
            raise TimeoutError('Navigation did not become readable')
    elif op in ('click', 'fill'):
        selector = json.dumps(req['selector'])
        prefix = "const e=document.querySelector(%s); if(!e)throw Error('Selector not found'); if(e.disabled)throw Error('Element disabled');" % selector
        if op == 'click':
            point = evaluate(cdp, "(() => {%s e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Element not visible');return {x:r.x+r.width/2,y:r.y+r.height/2};})()" % prefix)
            for kind in ('mousePressed', 'mouseReleased'):
                cdp.call('Input.dispatchMouseEvent', dict(type=kind, x=point['x'], y=point['y'], button='left', clickCount=1))
        else:
            # Never fill password/file/hidden inputs. Use native value setter for React-like controlled fields.
            script = """(() => {%s
              if(!['INPUT','TEXTAREA'].includes(e.tagName)||['password','file','hidden'].includes(e.type)||e.readOnly)throw Error('Not an editable non-secret text input');
              e.focus();const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(p,'value').set.call(e,%s);
              e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
              return {value:e.value.slice(0,16000)};
            })()""" % (prefix, json.dumps(req['text']))
            value = evaluate(cdp, script)
            return dict(tab_id=tab_id, **value)
        return dict(tab_id=tab_id, delivered=True, note='Read the page or capture again to verify the click.')
    value = evaluate(cdp, READ_SCRIPT)
    return dict(tab_id=tab_id, **value)


def action(screen, req):
    validate(req)
    port = port_for(screen)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:%s/json/list' % port, timeout=5) as response:
        raw = response.read(1_000_001)
    if len(raw) > 1_000_000:
        raise RuntimeError('Too many browser targets')
    tabs = [t for t in json.loads(raw) if t.get('type') == 'page' and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', str(t.get('id', '')))]
    if req['action'] == 'tabs':
        return dict(tabs=[dict(tab_id=t['id'], title=str(t.get('title', ''))[:500], url=str(t.get('url', ''))[:4000]) for t in tabs[:30]])
    tab = next((t for t in tabs if t['id'] == req['tab_id']), None) if 'tab_id' in req else next(iter(tabs), None)
    if not tab:
        raise ValueError('No matching tab on your browser; call tabs and use its tab_id')
    cdp = CDP(port, tab['id'])
    try:
        return perform(cdp, req, tab['id'])
    finally:
        cdp.close()


if __name__ == '__main__':
    # Bound wall time even if a page never answers or floods CDP events.
    def timeout(_signum, _frame):
        raise TimeoutError('VM browser action timed out')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(20)
    try:
        payload = base64.b64decode(sys.argv[1], validate=True)
        if len(payload) > 128000:
            raise ValueError('Browser request too large')
        result = action(sys.argv[2], json.loads(payload))
        output = json.dumps(result, ensure_ascii=True)
        if len(output) > MAX_OUTPUT:
            raise ValueError('Browser output too large')
        print(output)
    except Exception as error:
        print(str(error)[:1000], file=sys.stderr)
        sys.exit(1)
