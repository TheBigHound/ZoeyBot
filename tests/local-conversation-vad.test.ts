import test from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceDetector } from '../web/src/voice/localConversationVad.ts';

const silence = () => new Int16Array(960);
const speech = () => new Int16Array(960).fill(4000);

test('VAD ignores silence and a brief click, keeps pre-roll, and ends after one second of silence', () => {
  const vad = new UtteranceDetector();
  for (let i = 0; i < 100; i++) assert.equal(vad.push(silence()), null);
  assert.equal(vad.push(speech()), null);
  for (let i = 0; i < 25; i++) assert.equal(vad.push(silence()), null, '40ms noise is not a voice turn');
  for (let i = 0; i < 8; i++) assert.equal(vad.push(speech()), null);
  for (let i = 0; i < 24; i++) assert.equal(vad.push(silence()), null);
  const pcm = vad.push(silence());
  assert.ok(pcm);
  assert.ok(pcm.length >= 33 * 960, 'speech and trailing silence retained');
  assert.ok(pcm.length <= 39 * 960, 'pre-roll has a bounded size');
  assert.ok(pcm.some((sample) => sample === 4000));
  for (let i = 0; i < 25; i++) assert.equal(vad.push(silence()), null);
});

test('VAD bounds continuous speech to twenty seconds and reset discards a partial utterance', () => {
  const vad = new UtteranceDetector();
  let pcm: Int16Array | null = null;
  for (let i = 0; i < 500; i++) { pcm = vad.push(speech()); if (i < 499) assert.equal(pcm, null); }
  assert.equal(pcm?.length, 480000);
  for (let i = 0; i < 8; i++) vad.push(speech());
  vad.reset();
  for (let i = 0; i < 25; i++) assert.equal(vad.push(silence()), null);
});
