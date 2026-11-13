import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE, WORKLET, createAudioContext } from '../web/src/voice/audio.ts';

/** Run the capture worklet source against a context running at `contextRate`, feeding `seconds` of a sine at `hz`. */
function capture(contextRate: number, hz: number, seconds: number): Int16Array {
  const out: number[] = [];
  let Processor: any;
  const scope = {
    sampleRate: contextRate,
    AudioWorkletProcessor: class { port = { postMessage: (m: { pcm: ArrayBuffer }) => { out.push(...new Int16Array(m.pcm)); } }; },
    registerProcessor: (_name: string, cls: unknown) => { Processor = cls; },
  };
  new Function(...Object.keys(scope), WORKLET)(...Object.values(scope));
  const node = new Processor({ processorOptions: { rate: RATE } });
  const total = Math.round(contextRate * seconds);
  for (let at = 0; at < total; at += 128) {
    const quantum = new Float32Array(Math.min(128, total - at));
    for (let i = 0; i < quantum.length; i++) quantum[i] = 0.5 * Math.sin((2 * Math.PI * hz * (at + i)) / contextRate);
    node.process([[quantum]]);
  }
  return Int16Array.from(out);
}
/** Dominant frequency from zero crossings, assuming the samples really are at RATE. */
function pitch(pcm: Int16Array): number {
  let crossings = 0;
  for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) crossings++;
  return (crossings / 2) / (pcm.length / RATE);
}

for (const contextRate of [48000, 44100, 24000, 16000, 12000, 8000]) {
  test(`mic capture at a ${contextRate} Hz context still yields real-time ${RATE} Hz audio`, () => {
    const pcm = capture(contextRate, 300, 2);
    assert.ok(Math.abs(pcm.length - 2 * RATE) <= RATE * 0.05, `expected about ${2 * RATE} samples for 2 s, got ${pcm.length}`);
    assert.ok(Math.abs(pitch(pcm) - 300) < 15, `a 300 Hz voice must stay 300 Hz, measured ${pitch(pcm).toFixed(0)} Hz`);
  });
}

test('audio contexts are asked for the 24 kHz the voice pipeline uses, falling back when the browser refuses', () => {
  const asked: unknown[] = [];
  const g = globalThis as any;
  const previous = g.window;
  try {
    g.window = { AudioContext: class { constructor(o: unknown) { asked.push(o); } resume() { return Promise.resolve(); } } };
    createAudioContext();
    assert.deepEqual(asked, [{ latencyHint: 'interactive', sampleRate: RATE }]);
    asked.length = 0;
    g.window = { AudioContext: class { constructor(o: { sampleRate?: number }) { asked.push(o); if (o.sampleRate) throw new Error('NotSupportedError'); } resume() { return Promise.resolve(); } } };
    createAudioContext();
    assert.deepEqual(asked, [{ latencyHint: 'interactive', sampleRate: RATE }, { latencyHint: 'interactive' }]);
  } finally { g.window = previous; }
});
