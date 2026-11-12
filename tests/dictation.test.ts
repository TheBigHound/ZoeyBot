import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { useDictation } from '../web/src/voice/dictation.ts';
import { voiceApi } from '../web/src/voice/api.ts';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture() {
  const originals = { recorder: globalThis.MediaRecorder, window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), now: Date.now, options: voiceApi.options, transcribe: voiceApi.transcribe };
  let now = 1000;
  Date.now = () => now;
  const options = deferred<any>();
  const mic = deferred<MediaStream>();
  const text = deferred<string>();
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const recorders: Recorder[] = [];
  const errors: string[] = [];
  const texts: { owner: string; text: string }[] = [];
  const uploads: { blob: Blob; language?: string }[] = [];
  let micRequests = 0;
  let constructorFails = false;
  let startFails = false;
  class Recorder {
    static isTypeSupported = (mime: string) => mime === 'audio/mp4';
    state = 'inactive';
    mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((e: { error: Error }) => void) | null = null;
    constructor(_stream: MediaStream, options?: { mimeType: string }) {
      if (constructorFails) throw new Error('recorder construction failed');
      this.mimeType = options?.mimeType || 'audio/mp4';
      recorders.push(this);
    }
    start() {
      if (startFails) throw new Error('recorder start failed');
      this.state = 'recording';
    }
    chunk(value: string) { this.ondataavailable?.({ data: new Blob([value], { type: this.mimeType }) }); }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.chunk(' final'); this.onstop?.(); });
    }
    fail() { this.onerror?.({ error: new Error('capture failed') }); }
  }
  Object.assign(globalThis, { MediaRecorder: Recorder, window: new EventTarget() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => { micRequests++; return mic.promise; } } } });
  voiceApi.options = () => options.promise;
  voiceApi.transcribe = async (blob, language) => { uploads.push({ blob, language }); return text.promise; };
  let owner = 'bot-a';
  let dictation!: ReturnType<typeof useDictation>;
  function Harness() {
    const capturedOwner = owner;
    // The fourth argument scopes late results to the active draft.
    dictation = useDictation(value => texts.push({ owner: capturedOwner, text: value }), error => errors.push(error), 'en', owner);
    return null;
  }
  let root!: ReturnType<typeof create>;
  act(() => { root = create(React.createElement(Harness)); });
  const step = async (fn: () => void) => { await act(async () => { fn(); await Promise.resolve(); }); };
  return {
    get state() { return dictation.state; },
    get micRequests() { return micRequests; },
    recorders, track, texts, errors, uploads, step,
    advance(ms: number) { now += ms; },
    allowOptions() { options.resolve({ capabilities: { stt: true } }); },
    allowMic() { mic.resolve(stream); },
    resolveText(value: string) { text.resolve(value); },
    failConstructor() { constructorFails = true; },
    failStart() { startFails = true; },
    down(id = 1) { dictation.onPointerDown({ button: 0, pointerId: id, preventDefault() {}, currentTarget: { setPointerCapture() {} } } as any); },
    up(id = 1) { dictation.onPointerUp({ pointerId: id } as any); },
    pointerCancel(id = 1) { (dictation as any).onPointerCancel({ pointerId: id }); },
    cancel() { dictation.cancel(); },
    changeBot(id: string) { owner = id; root.update(React.createElement(Harness)); },
    unmount() { root.unmount(); },
    cleanup() {
      act(() => root.unmount());
      Date.now = originals.now;
      Object.assign(globalThis, { MediaRecorder: originals.recorder, window: originals.window });
      if (originals.navigator) Object.defineProperty(globalThis, 'navigator', originals.navigator);
      else Reflect.deleteProperty(globalThis, 'navigator');
      voiceApi.options = originals.options;
      voiceApi.transcribe = originals.transcribe;
    },
  };
}

test('tap-toggle uploads every Safari MP4 chunk including the final stop event for short utterances', async () => {
  const f = fixture();
  try {
    await f.step(() => { f.allowOptions(); f.allowMic(); f.down(); });
    await f.step(() => { f.recorders[0].chunk('first'); f.advance(30); f.up(); });
    assert.equal(f.state, 'recording');
    await f.step(() => { f.recorders[0].chunk(' middle'); f.advance(150); f.down(); f.up(); });
    assert.equal(f.track.stopped, true);
    assert.equal(f.uploads.length, 1);
    assert.equal(await f.uploads[0].blob.text(), 'first middle final');
    assert.equal(f.uploads[0].blob.type, 'audio/mp4');
    assert.equal(f.uploads[0].language, 'en');
    await f.step(() => f.resolveText('all the words'));
    assert.deepEqual(f.texts, [{ owner: 'bot-a', text: 'all the words' }]);
    assert.equal(f.state, 'idle');
  } finally { f.cleanup(); }
});

test('pointer cancellation stops capture without transcribing an abandoned gesture', async () => {
  const f = fixture();
  try {
    await f.step(() => { f.allowOptions(); f.allowMic(); f.down(); });
    await f.step(() => { f.advance(600); f.pointerCancel(); });
    assert.equal(f.track.stopped, true);
    assert.equal(f.state, 'idle');
    assert.deepEqual(f.uploads, []);
  } finally { f.cleanup(); }
});

test('a MediaRecorder error releases the microphone and does not upload damaged audio', async () => {
  const f = fixture();
  try {
    await f.step(() => { f.allowOptions(); f.allowMic(); f.down(); });
    await f.step(() => f.recorders[0].fail());
    assert.equal(f.track.stopped, true);
    assert.equal(f.state, 'idle');
    assert.deepEqual(f.errors, ['capture failed']);
    assert.deepEqual(f.uploads, []);
  } finally { f.cleanup(); }
});

for (const failure of ['constructor', 'start'] as const) {
  test(`a recorder ${failure} failure closes the acquired microphone`, async () => {
    const f = fixture();
    try {
      await f.step(() => {
        if (failure === 'constructor') f.failConstructor(); else f.failStart();
        f.allowOptions(); f.allowMic(); f.down();
      });
      assert.equal(f.track.stopped, true);
      assert.equal(f.state, 'idle');
      assert.equal(f.errors.length, 1);
    } finally { f.cleanup(); }
  });
}

test('switching bots discards an in-flight transcript instead of using the new draft callback', async () => {
  const f = fixture();
  try {
    await f.step(() => { f.allowOptions(); f.allowMic(); f.down(); });
    await f.step(() => { f.advance(600); f.up(); });
    await f.step(() => f.changeBot('bot-b'));
    await f.step(() => f.resolveText('bot a words'));
    assert.deepEqual(f.texts, []);
    assert.equal(f.state, 'idle');
  } finally { f.cleanup(); }
});

test('cancelling an in-flight transcription suppresses its late text', async () => {
  const f = fixture();
  try {
    await f.step(() => { f.allowOptions(); f.allowMic(); f.down(); });
    await f.step(() => { f.advance(600); f.up(); });
    assert.equal(f.state, 'transcribing');
    await f.step(() => { f.cancel(); f.resolveText('obsolete words'); });
    assert.deepEqual(f.texts, []);
    assert.equal(f.state, 'idle');
  } finally { f.cleanup(); }
});

test('a second tap cancels a toggle that is still waiting for permission', async () => {
  const f = fixture();
  try {
    await f.step(() => { f.allowOptions(); f.down(); f.advance(30); f.up(); });
    await f.step(() => f.down());
    await f.step(() => f.allowMic());
    assert.equal(f.track.stopped, true);
    assert.equal(f.recorders.length, 0);
    assert.equal(f.state, 'idle');
  } finally { f.cleanup(); }
});

test('releasing a hold before permission arrives never starts an orphan toggle recording', async () => {
  const f = fixture();
  try {
    await f.step(() => { f.allowOptions(); f.down(); });
    await f.step(() => { f.advance(500); f.up(); });
    await f.step(() => f.allowMic());
    assert.equal(f.track.stopped, true);
    assert.equal(f.recorders.length, 0);
    assert.equal(f.state, 'idle');
  } finally { f.cleanup(); }
});

test('microphone startup is visibly pending rather than idle or recording', async () => {
  const f = fixture();
  try {
    await f.step(() => f.down());
    assert.equal(f.state, 'starting');
    assert.equal(f.recorders.length, 0);
    await f.step(() => { f.allowOptions(); f.allowMic(); });
    assert.equal(f.state, 'recording');
  } finally { f.cleanup(); }
});

test('cancelling pending permission closes the eventual stream without recording', async () => {
  const f = fixture();
  try {
    await f.step(() => { f.allowOptions(); f.down(); });
    assert.equal(f.micRequests, 1);
    await f.step(() => { f.cancel(); f.allowMic(); });
    assert.equal(f.track.stopped, true);
    assert.equal(f.recorders.length, 0);
    assert.equal(f.state, 'idle');
  } finally { f.cleanup(); }
});
