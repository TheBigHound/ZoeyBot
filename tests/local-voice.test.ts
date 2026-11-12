import { test } from 'node:test';
import assert from 'node:assert/strict';

test('local voice is default in host mode and never advertises realtime credentials', async () => {
  const { voiceMode, localVoiceOptions } = await import('../server/src/local-voice.js');
  assert.equal(voiceMode({ HQ_HOST: '1' }), 'local');
  assert.equal(voiceMode({ HQ_VM: '1' }), 'xai', 'the VM flag means nothing any more');
  assert.equal(voiceMode({ VOICE_PROVIDER: 'local' }), 'local');
  assert.equal(voiceMode({}), 'xai');
  const opts = await localVoiceOptions();
  assert.equal(opts.provider, 'local');
  assert.equal(opts.capabilities.realtime, false);
  assert.equal(opts.capabilities.calls, false);
  assert.equal(opts.voices[0].id, 'Zoey');
  assert.deepEqual(opts.speeds, [1]);
});

test('local synthesis rejects oversized/empty text before launching a process', async () => {
  const { synthesizeLocal } = await import('../server/src/local-voice.js');
  await assert.rejects(synthesizeLocal(''), /1 to 400/);
  await assert.rejects(synthesizeLocal('x'.repeat(401)), /1 to 400/);
});

test('per-bot voice: a phonon voice is honored, a cloud voice id falls back to the default', async () => {
  const { localVoices, resolveLocalVoice } = await import('../server/src/local-voice.js');
  const voices = await localVoices();
  assert.equal(voices[0], 'Zoey', 'default voice listed first');
  assert.equal(await resolveLocalVoice('luna'), 'Zoey', 'xAI voice ids are not phonon voices');
  assert.equal(await resolveLocalVoice(undefined), 'Zoey');
  if (voices.includes('Easton')) assert.equal(await resolveLocalVoice('Easton'), 'Easton');
  else assert.equal(voices.length, 1, 'without an ollama listing only the default voice exists');
});

test('WAV validation rejects non-audio output', async () => {
  const { validateWav } = await import('../server/src/local-voice.js');
  assert.throws(() => validateWav(Buffer.from('not a WAV')), /WAV/);
});

test('local transcription validates audio limits before starting Whisper', async () => {
  const { transcribeLocal } = await import('../server/src/local-voice.js');
  await assert.rejects(transcribeLocal(Buffer.alloc(0)), /empty/);
  await assert.rejects(transcribeLocal(Buffer.alloc(25 * 1024 * 1024 + 1)), /too long/);
});

test('cached local Whisper transcribes real Zoey speech offline', { skip: process.env.LOCAL_VOICE_INTEGRATION !== '1' }, async () => {
  const { transcribeLocal, synthesizeLocal, localVoiceOptions } = await import('../server/src/local-voice.js');
  assert.equal((await localVoiceOptions()).capabilities.stt, true);
  const wav = await synthesizeLocal('Hello. This is Zoey, speaking locally for ZoeyBot.');
  const text = await transcribeLocal(wav, 'en');
  assert.match(text, /speaking locally/i);
  console.log('Local transcript:', text);
  const { execFileSync } = await import('node:child_process');
  const webm = execFileSync(process.env.LOCAL_FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { input: wav });
  assert.match(await transcribeLocal(webm, 'en'), /speaking locally/i);
  const tooLong = execFileSync(process.env.LOCAL_FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '121', '-f', 'wav', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 });
  await assert.rejects(transcribeLocal(tooLong, 'en'), /at most 120 seconds/);
});

test('host voice HTTP routes do not mint secrets or contact cloud services', async () => {
  process.env.HQ_HOST = '1';
  process.env.SESSION_SECRET = 'local-voice-test';
  process.env.DB_PATH = ':memory:';
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Cloud fetch forbidden in local voice test'); }) as typeof fetch;
  try {
    const { voiceApi } = await import('../server/src/voice.js');
    const { Hono } = await import('hono');
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user' as never, { id: 'test' } as never); await next(); });
    app.route('/voice', voiceApi);
    const options = await app.request('/voice/options');
    assert.equal((await options.json()).provider, 'local');
    for (const path of ['/session', '/tool', '/end']) {
      const r = await app.request('/voice' + path, { method: 'POST', body: '{}' });
      assert.equal(r.status, 501);
      const body = await r.json();
      assert.match(body.error, /not supported/i);
      assert.equal(body.clientSecret, undefined);
    }
    const oversized = await app.request('/voice/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(401) }) });
    assert.equal(oversized.status, 400);
    if (process.env.LOCAL_VOICE_INTEGRATION === '1') {
      const preview = await app.request('/voice/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello from the local voice endpoint.' }) });
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('Content-Type'), 'audio/wav');
      const bytes = Buffer.from(await preview.arrayBuffer());
      const { validateWav } = await import('../server/src/local-voice.js');
      validateWav(bytes);
      const fd = new FormData();
      fd.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'sample.wav');
      fd.append('language', 'en');
      const stt = await app.request('/voice/stt', { method: 'POST', body: fd });
      assert.equal(stt.status, 200);
      assert.match((await stt.json()).text, /local voice/i);
    }
  } finally { globalThis.fetch = savedFetch; }
});

test('installed phonon Zoey produces real WAV and 24k mono PCM', { skip: process.env.LOCAL_VOICE_INTEGRATION !== '1' }, async () => {
  const { synthesizeLocal, validateWav } = await import('../server/src/local-voice.js');
  const wav = await synthesizeLocal('Hello. This is Zoey, speaking locally for ZoeyBot.');
  validateWav(wav);
  assert.ok(wav.length > 1000);
  const { writeFile } = await import('node:fs/promises');
  await writeFile('/Users/thehound/.hermes/cache/scratch/zoeybot-zoey-verified.wav', wav);
  const pcm = await synthesizeLocal('Local speech is ready.', 'pcm');
  assert.ok(pcm.length > 1000);
  assert.equal(pcm.length % 2, 0);
});
