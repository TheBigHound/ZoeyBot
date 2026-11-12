import test from 'node:test';
import assert from 'node:assert/strict';

function browserAudio() {
  const sources: any[] = [];
  const contexts: any[] = [];
  class Context {
    state = 'suspended'; currentTime = 0; destination = {}; resumed = 0;
    constructor() { contexts.push(this); }
    async resume() { this.resumed++; this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createGain() { return { connect(node: any) { return node; }, disconnect() {} }; }
    createAnalyser() { return { fftSize: 512, connect(node: any) { return node; }, disconnect() {} }; }
    createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { const source = { buffer: null, at: 0, stopped: false, onended: null as (() => void) | null, connect() {}, start(at: number) { this.at = at; }, stop() { this.stopped = true; } }; sources.push(source); return source; }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: Context } });
  return { sources, contexts };
}

test('local read-aloud refuses a cloud provider without requesting speech or a call session', async () => {
  const { voiceApi } = await import('../web/src/voice/api.ts');
  const { createLocalReadAloudAudio } = await import('../web/src/voice/localReadAloudAudio.ts');
  browserAudio();
  const original = voiceApi.options;
  let requests = 0;
  voiceApi.options = async () => ({ provider: 'xai', capabilities: { tts: true, stt: true, realtime: true, calls: true }, voices: [], languages: [], speeds: [] });
  globalThis.fetch = (async () => { requests++; throw new Error('must not contact a voice provider'); }) as typeof fetch;
  const audio = createLocalReadAloudAudio();
  try {
    await assert.rejects(audio.activate(), /No cloud voice was used/);
    await assert.rejects(audio.synthesize('zoey', 'hello'), /No cloud voice was used/);
    assert.equal(requests, 0);
  } finally { audio.close(); voiceApi.options = original; }
});

test('local playback unlocks from the gesture, uses raw 24kHz PCM, and settles only at actual audio end or stop', async () => {
  const { createLocalReadAloudAudio } = await import('../web/src/voice/localReadAloudAudio.ts');
  const { sources, contexts } = browserAudio();
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    requests.push({ url, body: init.body && JSON.parse(String(init.body)) });
    if (url.endsWith('/options')) return Response.json({ provider: 'local', capabilities: { tts: true } });
    return new Response(new Int16Array([0, 100, -100]).buffer, { headers: { 'Content-Type': 'audio/pcm;rate=24000' } });
  }) as typeof fetch;
  const audio = createLocalReadAloudAudio();
  const activated = audio.activate();
  assert.ok(contexts[0].resumed > 0, 'resume must happen before options fetch or an await');
  await activated;
  const pcm = await audio.synthesize('zoey', 'hello');
  assert.deepEqual([...pcm], [0, 100, -100]);
  assert.deepEqual(requests.at(-1), { url: '/api/voice/preview', body: { botId: 'zoey', text: 'hello', codec: 'pcm' } });
  let ended = false;
  const playing = audio.play(pcm).then(() => { ended = true; });
  await Promise.resolve();
  assert.equal(ended, false);
  sources[0].onended();
  await playing;
  assert.equal(ended, true);
  const stopped = audio.play(pcm);
  audio.clear();
  await stopped;
  assert.equal(sources[1].stopped, true);
  audio.close();
  assert.equal(contexts[0].state, 'closed');
});
