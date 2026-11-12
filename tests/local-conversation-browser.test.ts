import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalConversationTransport } from '../web/src/voice/localConversationBrowser.ts';
import { voiceApi } from '../web/src/voice/api.ts';

const snapshot = () => ({ botId: 'fixture', generation: 1, loaded: true, running: false, rows: [] });
const local = { provider: 'local' as const, capabilities: { tts: true, stt: true, realtime: false, calls: false }, voices: [], languages: [], speeds: [] };
function browser() {
  const contexts: any[] = []; const nodes: any[] = [];
  const tracks = [{ enabled: true, stopped: false, stop() { this.stopped = true; } }];
  const stream = { getAudioTracks: () => tracks, getTracks: () => tracks } as unknown as MediaStream;
  const connect = () => ({ gain: { value: 0 }, connect(node: any) { return node; }, disconnect() {} });
  class Context {
    state = 'suspended'; currentTime = 0; destination = {};
    audioWorklet = { addModule: async () => {} };
    constructor() { contexts.push(this); }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createGain = connect;
    createAnalyser() { return { ...connect(), fftSize: 512 }; }
    createMediaStreamSource = connect;
  }
  class Worklet {
    port = { onmessage: null }; constructor() { nodes.push(this); }
    connect(node: any) { return node; } disconnect() {}
  }
  Object.assign(globalThis, { window: { AudioContext: Context }, AudioWorkletNode: Worklet });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  return { contexts, tracks, stream, nodes };
}

test('real browser transport resumes audio synchronously, captures PCM via worklet and stops every track/context', async () => {
  const b = browser(); const original = voiceApi.options;
  voiceApi.options = async () => local;
  const io = createLocalConversationTransport(snapshot);
  const frames: Int16Array[] = [];
  try {
    const starting = io.activate((pcm) => frames.push(pcm));
    assert.equal(b.contexts.length, 2);
    assert.ok(b.contexts.every((ctx) => ctx.state === 'running'), 'both contexts unlock in the click');
    await starting;
    b.nodes[0].port.onmessage({ data: { pcm: new Int16Array([3, -3]).buffer, level: 0.1 } });
    assert.deepEqual([...frames[0]], [3, -3]);
    io.mute(true); assert.equal(b.tracks[0].enabled, false);
    io.mute(false); assert.equal(b.tracks[0].enabled, true);
    io.close();
    assert.ok(b.tracks.every((t) => t.stopped));
    assert.ok(b.contexts.every((ctx) => ctx.state === 'closed'));
  } finally { io.close(); voiceApi.options = original; }
});

test('microphone permission resolving after End cannot leak an active track', async () => {
  const b = browser(); const original = voiceApi.options;
  voiceApi.options = async () => local;
  let grant!: (stream: MediaStream) => void;
  navigator.mediaDevices.getUserMedia = async () => new Promise((r) => { grant = r; });
  const io = createLocalConversationTransport(snapshot);
  try {
    const starting = io.activate(() => {});
    await new Promise((r) => setImmediate(r));
    io.close(); grant(b.stream); await starting;
    assert.ok(b.tracks.every((t) => t.stopped));
    assert.ok(b.contexts.every((ctx) => ctx.state === 'closed'));
  } finally { io.close(); voiceApi.options = original; }
});

test('STT uses a valid 24kHz mono PCM WAV, selected language and cancellation; no session/tool/end routes', async () => {
  browser(); const original = voiceApi.options; voiceApi.options = async () => local;
  const io = createLocalConversationTransport(snapshot, () => 'en');
  const abort = new AbortController();
  let calls = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls++; assert.equal(url, '/api/voice/stt');
    assert.equal(init.credentials, 'include'); assert.equal(init.signal, abort.signal);
    const form = init.body as FormData;
    assert.equal(form.get('language'), 'en');
    const file = form.get('file') as File;
    assert.equal(file.name, 'voice-turn.wav'); assert.equal(file.type, 'audio/wav');
    const bytes = await file.arrayBuffer(); const view = new DataView(bytes);
    assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
    assert.equal(view.getUint32(24, true), 24000); assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint16(34, true), 16); assert.equal(view.getUint32(40, true), 6);
    assert.deepEqual([...new Int16Array(bytes.slice(44))], [0, 1234, -1234]);
    return Response.json({ text: 'hello' });
  }) as typeof fetch;
  try { assert.equal(await io.transcribe(new Int16Array([0, 1234, -1234]), abort.signal), 'hello'); assert.equal(calls, 1); }
  finally { io.close(); voiceApi.options = original; globalThis.fetch = oldFetch; }
});

test('unsupported provider fails closed before microphone access or transcription', async () => {
  browser(); const original = voiceApi.options;
  voiceApi.options = async () => ({ ...local, provider: 'xai' });
  let mic = 0; navigator.mediaDevices.getUserMedia = async () => { mic++; throw new Error('must not request microphone'); };
  const io = createLocalConversationTransport(snapshot);
  try {
    await assert.rejects(io.activate(() => {}), /[Ll]ocal/);
    await assert.rejects(io.transcribe(new Int16Array([1]), new AbortController().signal), /[Ll]ocal/);
    assert.equal(mic, 0);
  } finally { io.close(); voiceApi.options = original; }
});

test('pending worklet startup is disconnected when End happens during addModule', async () => {
  const b = browser(); const original = voiceApi.options; voiceApi.options = async () => local;
  let load!: () => void;
  const io = createLocalConversationTransport(snapshot);
  try {
    const starting = io.activate(() => {});
    b.contexts[0].audioWorklet.addModule = async () => new Promise<void>((r) => { load = r; });
    await new Promise((r) => setImmediate(r));
    io.close(); load(); await starting;
    assert.equal(b.nodes[0].port.onmessage, null, 'late worklet must not keep delivering captured frames');
    assert.ok(b.tracks.every((t) => t.stopped));
  } finally { io.close(); voiceApi.options = original; }
});

test('local speech retries transient unavailable synthesis serially with a bounded backoff', async (t) => {
  browser(); const original = voiceApi.options; const preview = voiceApi.preview;
  voiceApi.options = async () => local;
  const io = createLocalConversationTransport(snapshot);
  let attempts = 0;
  try {
    await io.activate(() => {});
    voiceApi.preview = async () => { attempts++; if (attempts < 3) throw new Error('Local speech unavailable. No cloud fallback was used.'); return new Int16Array([17]); };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = io.synthesize('fixture', 'reply');
    await new Promise((r) => setImmediate(r));
    assert.equal(attempts, 1);
    t.mock.timers.tick(1000); await new Promise((r) => setImmediate(r));
    assert.equal(attempts, 2);
    t.mock.timers.tick(2000);
    assert.deepEqual([...(await pending)], [17]);
    assert.equal(attempts, 3);
  } finally { io.close(); voiceApi.options = original; voiceApi.preview = preview; }
});
