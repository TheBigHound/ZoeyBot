import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';

// Composer-boundary regression: the dictation hook's bot scoping, pointer cancellation and
// visible "starting" state must actually reach the mic button, not just exist in the hook.

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function fixture() {
  const originals = { recorder: globalThis.MediaRecorder, window: globalThis.window, document: globalThis.document, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), now: Date.now, localStorage: globalThis.localStorage };
  let now = 1000;
  Date.now = () => now;
  const mic = deferred<MediaStream>();
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  let micRequests = 0;
  class Recorder {
    static isTypeSupported = () => true;
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((e: { error: Error }) => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  }
  const win = new EventTarget() as EventTarget & { requestAnimationFrame?: unknown };
  Object.assign(globalThis, {
    React,
    MediaRecorder: Recorder,
    window: win,
    document: { activeElement: null, addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => { micRequests++; return mic.promise; } }, userAgent: 'test' } });

  const { voiceApi } = await import('../web/src/voice/api.ts');
  const originalOptions = voiceApi.options;
  voiceApi.options = async () => ({ provider: 'local', capabilities: { tts: true, stt: true, realtime: false, calls: false }, voices: [], languages: [], speeds: [] } as any);
  const { Composer } = await import('../web/src/components/Composer.tsx');

  const bot = (id: string) => ({ id, name: 'Zoey', voiceLanguage: 'en' } as any);
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(React.createElement(Composer, { bot: bot('bot-a'), running: false }), { createNodeMock: () => ({ focus() {}, style: {}, scrollHeight: 20, setSelectionRange() {} }) }); });
  const step = async (fn: () => void | Promise<void>) => { await act(async () => { await fn(); await Promise.resolve(); await new Promise((r) => setImmediate(r)); }); };
  const mic$ = () => root.root.findAll((n) => n.type === 'button' && typeof n.props['data-dictation'] === 'string')[0];
  return {
    step, track, mic$,
    get micRequests() { return micRequests; },
    allowMic() { mic.resolve(stream); },
    advance(ms: number) { now += ms; },
    down() { mic$().props.onPointerDown({ button: 0, pointerId: 1, preventDefault() {}, currentTarget: { setPointerCapture() {} } }); },
    up() { mic$().props.onPointerUp({ pointerId: 1 }); },
    pointerCancel() { mic$().props.onPointerCancel({ pointerId: 1 }); },
    escape() { win.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); },
    async switchBot(id: string) { await step(() => { root.update(React.createElement(Composer, { bot: bot(id), running: false })); }); },
    cleanup() {
      act(() => root.unmount());
      Date.now = originals.now;
      Object.assign(globalThis, { MediaRecorder: originals.recorder, window: originals.window, document: originals.document, localStorage: originals.localStorage });
      if (originals.navigator) Object.defineProperty(globalThis, 'navigator', originals.navigator); else Reflect.deleteProperty(globalThis, 'navigator');
      voiceApi.options = originalOptions;
    },
  };
}

test('composer shows a visible starting state while microphone permission is pending and binds pointer cancel', async () => {
  const f = await fixture();
  try {
    await f.step(() => {}); // let voice options load
    assert.equal(f.mic$().props['data-dictation'], 'idle');
    assert.equal(f.mic$().props.disabled, false, 'mic button should be enabled when local STT is available');
    await f.step(() => f.down());
    assert.equal(f.mic$().props['data-dictation'], 'starting');
    assert.equal(f.mic$().props['aria-busy'], true);
    assert.match(f.mic$().props.title, /Starting microphone/);
    assert.equal(typeof f.mic$().props.onPointerCancel, 'function');
    await f.step(() => { f.advance(600); f.pointerCancel(); });
    assert.equal(f.mic$().props['data-dictation'], 'idle');
    await f.step(() => f.allowMic());
    assert.equal(f.track.stopped, true, 'late microphone grant after cancel must be released');
    assert.equal(f.mic$().props['data-dictation'], 'idle');
  } finally { f.cleanup(); }
});

test('Escape cancels dictation while the microphone is still starting', async () => {
  const f = await fixture();
  try {
    await f.step(() => {});
    await f.step(() => f.down());
    assert.equal(f.mic$().props['data-dictation'], 'starting');
    await f.step(() => f.escape());
    assert.equal(f.mic$().props['data-dictation'], 'idle');
    await f.step(() => f.allowMic());
    assert.equal(f.track.stopped, true);
  } finally { f.cleanup(); }
});

test('switching bots through the composer cancels an in-flight dictation for the previous draft', async () => {
  const f = await fixture();
  try {
    await f.step(() => {});
    await f.step(() => { f.allowMic(); f.down(); });
    await f.step(() => { f.advance(30); f.up(); });
    assert.equal(f.mic$().props['data-dictation'], 'recording');
    await f.switchBot('bot-b');
    assert.equal(f.track.stopped, true, 'bot switch must release the microphone');
    assert.equal(f.mic$().props['data-dictation'], 'idle');
  } finally { f.cleanup(); }
});
