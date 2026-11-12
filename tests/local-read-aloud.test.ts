import test from 'node:test';
import assert from 'node:assert/strict';
import type { Row } from '../server/src/types.ts';

const row = (seq: number, text: string, streaming = false, role: 'assistant' | 'user' = 'assistant'): Row => ({ botId: 'zoey', generation: 1, seq, updatedSeq: seq, kind: 'message', createdAt: 0, body: { type: 'message', role, text, streaming } });
const snapshot = (rows: Row[] = [], extra = {}) => ({ botId: 'zoey', generation: 1, loaded: true, rows, ...extra });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function harness() {
  const { LocalReadAloud } = await import('../web/src/voice/readAloud.ts');
  const spoken: string[] = [];
  let activations = 0;
  let clears = 0;
  const controller = new LocalReadAloud({
    activate: async () => { activations++; },
    synthesize: async (_botId: string, text: string) => { spoken.push(text); return new Int16Array([1, 2]); },
    play: async () => {},
    clear: () => { clears++; },
    close: () => {},
  });
  return { controller, spoken, activations: () => activations, clears: () => clears };
}

test('enabling voice can speak a confirmation without replaying history', async () => {
  const h = await harness();
  await h.controller.enable(snapshot([row(1, 'Do not read old history')]), 'Local voice is ready.');
  await tick();
  assert.deepEqual(h.spoken, ['Local voice is ready.']);
  h.controller.receive('zoey', 1, [row(2, 'A new live reply')]);
  await tick();
  assert.deepEqual(h.spoken, ['Local voice is ready.', 'A new live reply']);
});

test('long replies are synthesized and played serially in chunks of at most 400 characters', async () => {
  const { LocalReadAloud } = await import('../web/src/voice/readAloud.ts');
  const chunks: string[] = [];
  const played: number[] = [];
  const releases: (() => void)[] = [];
  const controller = new LocalReadAloud({
    activate: async () => {},
    synthesize: async (_bot, text) => { chunks.push(text); return new Int16Array([chunks.length]); },
    play: (pcm) => { played.push(pcm[0]); return new Promise<void>((resolve) => releases.push(resolve)); },
    clear() {}, close() {},
  });
  await controller.enable(snapshot());
  const text = ('Hello there. ' + 'word '.repeat(90) + '😀'.repeat(240)).trim();
  controller.receive('zoey', 1, [row(1, text), row(2, 'After the long reply')]);
  await tick();
  assert.equal(chunks.length, 1, 'must not start next synthesis while previous audio is playing');
  assert.ok(chunks[0].length <= 400, 'backend rejects longer chunks');
  while (releases.length) { releases.shift()!(); await tick(); }
  assert.equal(chunks.join(' ').replace(/\s/g, ''), (text + 'After the long reply').replace(/\s/g, ''));
  assert.ok(chunks.every((c) => c.length > 0 && c.length <= 400 && !/[\uD800-\uDBFF]$/.test(c)), 'do not split a surrogate pair');
  assert.equal(played.length, chunks.length);
});

test('a new user message cancels obsolete synthesis and queues without overlapping requests', async () => {
  const { LocalReadAloud } = await import('../web/src/voice/readAloud.ts');
  const requested: string[] = [];
  const played: number[] = [];
  let release!: (pcm: Int16Array) => void;
  let clears = 0;
  const controller = new LocalReadAloud({
    activate: async () => {},
    synthesize: async (_bot, text) => { requested.push(text); return new Promise<Int16Array>((resolve) => { release = resolve; }); },
    play: async (pcm) => { played.push(pcm[0]); },
    clear() { clears++; }, close() {},
  });
  await controller.enable(snapshot());
  controller.receive('zoey', 1, [row(1, 'old '.repeat(200)), row(2, 'also obsolete')]);
  controller.receive('zoey', 1, [row(3, 'new question', false, 'user'), row(4, 'fresh answer')]);
  assert.equal(clears, 1);
  assert.equal(requested.length, 1, 'cancelled synthesis must settle before requesting more local speech');
  release(new Int16Array([1]));
  await tick();
  assert.deepEqual(played, [], 'late obsolete audio must never play');
  assert.deepEqual(requested.slice(1), ['fresh answer']);
  release(new Int16Array([2]));
  await tick();
  assert.deepEqual(played, [2]);
  controller.receive('zoey', 1, [row(2, 'late duplicate old reply')]);
  await tick();
  assert.equal(requested.length, 2);
});

test('disable immediately stops playback, drops queued chunks and ignores late synthesis across re-enable', async () => {
  const { LocalReadAloud } = await import('../web/src/voice/readAloud.ts');
  let release!: (pcm: Int16Array) => void;
  const played: number[] = [];
  let closed = 0;
  const c = new LocalReadAloud({
    activate: async () => {}, synthesize: () => new Promise((resolve) => { release = resolve; }),
    play: async (pcm) => { played.push(pcm[0]); }, clear() {}, close() { closed++; },
  });
  await c.enable(snapshot());
  c.receive('zoey', 1, [row(1, 'obsolete')]);
  c.disable();
  assert.equal(c.enabled, false);
  assert.equal(closed, 1);
  await c.enable(snapshot([row(1, 'obsolete')]));
  c.receive('zoey', 1, [row(2, 'fresh')]);
  release(new Int16Array([1]));
  await tick();
  assert.deepEqual(played, []);
  release(new Int16Array([2]));
  await tick();
  assert.deepEqual(played, [2]);
});

test('bot switch disables speech; conversation reset cancels and never reads the reset snapshot', async () => {
  const h = await harness();
  await h.controller.enable(snapshot());
  h.controller.observe(snapshot([row(50, 'history after reset')], { generation: 2 }));
  h.controller.receive('zoey', 1, [row(99, 'stale generation')]);
  h.controller.receive('zoey', 2, [row(50, 'reset history'), row(51, 'new conversation reply')]);
  await tick();
  assert.deepEqual(h.spoken, ['new conversation reply']);
  h.controller.observe(snapshot([], { botId: 'other' }));
  assert.equal(h.controller.enabled, false);
  h.controller.receive('zoey', 2, [row(52, 'background bot')]);
  await tick();
  assert.deepEqual(h.spoken, ['new conversation reply']);
});

test('cancel during audio activation cannot turn speech back on', async () => {
  const { LocalReadAloud } = await import('../web/src/voice/readAloud.ts');
  let release!: () => void;
  const c = new LocalReadAloud({ activate: () => new Promise<void>((resolve) => { release = resolve; }), synthesize: async () => new Int16Array([1]), play: async () => {}, clear() {}, close() {} });
  const enabling = c.enable(snapshot());
  c.disable();
  release();
  await enabling;
  assert.equal(c.enabled, false);
});

test('unloaded history cannot be enabled; synthesis failure disables and exposes an honest error', async () => {
  const { LocalReadAloud } = await import('../web/src/voice/readAloud.ts');
  const states: any[] = [];
  const c = new LocalReadAloud({ activate: async () => {}, synthesize: async () => { throw new Error('Local speech unavailable; no cloud fallback was used.'); }, play: async () => {}, clear() {}, close() {} }, (state) => states.push(state));
  await c.enable(snapshot([], { loaded: false }));
  assert.equal(c.enabled, false);
  assert.match(states.at(-1).error, /load/i);
  await c.enable(snapshot());
  c.receive('zoey', 1, [row(1, 'hello')]);
  await tick();
  assert.equal(c.enabled, false);
  assert.match(states.at(-1).error, /no cloud fallback/);
});

test('off by default; one enable gesture reads only new completed assistant replies once', async () => {
  const h = await harness();
  h.controller.receive('zoey', 1, [row(1, 'before enabling')]);
  assert.deepEqual(h.spoken, []);
  const enabling = h.controller.enable(snapshot([row(1, 'history'), row(2, 'already streaming', true)]));
  assert.equal(h.activations(), 1, 'audio activation must happen synchronously inside the gesture');
  await enabling;
  h.controller.receive('zoey', 1, [row(1, 'history'), row(2, 'old stream finalized')]);
  h.controller.receive('zoey', 1, [row(3, 'partial', true)]);
  assert.deepEqual(h.spoken, []);
  h.controller.receive('zoey', 1, [row(3, 'New reply')]);
  await tick();
  h.controller.receive('zoey', 1, [row(3, 'New reply'), row(4, 'Second reply')]);
  await tick();
  assert.deepEqual(h.spoken, ['New reply', 'Second reply']);
  assert.equal(h.activations(), 1);
});
