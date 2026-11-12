import { test } from 'node:test';
import assert from 'node:assert/strict';

test('frontend refuses unsupported local calls without requesting a session', async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json({ provider: 'local', voices: [{ id: 'Zoey', name: 'Zoey' }], languages: [], speeds: [1], capabilities: { tts: true, stt: true, realtime: false, calls: false }, callDisabledReason: 'Local calls are unavailable. Use dictation.' });
  }) as typeof fetch;
  const { ensureCallSupported } = await import('../web/src/voice/api.ts');
  await assert.rejects(ensureCallSupported(), /Use dictation/);
  assert.equal(requests, 1);
});
