import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalConversation, type LocalConversationTransport } from '../web/src/voice/localConversation.ts';

const tick = () => new Promise<void>((r) => setImmediate(r));
const row = (seq: number, role: 'user' | 'assistant', text: string, streaming = false) => ({ botId: 'fixture', generation: 1, seq, updatedSeq: seq, kind: 'message' as const, createdAt: 0, body: { type: 'message' as const, role, text, streaming } });
function fixture() {
  const events: string[] = [];
  let onFrame = (_pcm: Int16Array) => {};
  let finishPlay = () => {};
  const snapshot = { botId: 'fixture', generation: 1, loaded: true, running: false, rows: [row(1, 'assistant', 'old reply')] };
  const io: LocalConversationTransport = {
    snapshot: () => snapshot,
    activate: async (frame) => { events.push('activate'); onFrame = frame; },
    mute: (muted) => { events.push(`mute:${muted}`); },
    transcribe: async () => { events.push('transcribe'); return 'hello Zoey'; },
    send: async (botId, text) => { events.push(`send:${botId}:${text}`); return row(2, 'user', text); },
    synthesize: async (botId, text) => { events.push(`speak:${botId}:${text}`); return new Int16Array([1]); },
    play: async () => { events.push('play'); await new Promise<void>((resolve) => { finishPlay = resolve; }); },
    clear: () => { events.push('clear'); finishPlay(); },
    close: () => { events.push('close'); },
    interrupt: async () => { events.push('interrupt'); },
    level: () => 0,
  };
  const controller = new LocalConversation(io);
  const utterance = () => { for (let i = 0; i < 10; i++) onFrame(new Int16Array(960).fill(4000)); for (let i = 0; i < 25; i++) onFrame(new Int16Array(960)); };
  return { controller, io, events, snapshot, utterance, finishPlay: () => finishPlay() };
}

test('local voice posts one utterance into the selected canonical chat and listens only after real audio end', async () => {
  const f = fixture();
  const starting = f.controller.start();
  assert.equal(f.events[0], 'activate', 'activation must be synchronous inside the click');
  await starting;
  assert.equal(f.controller.state.status, 'listening');
  f.utterance();
  await tick();
  assert.equal(f.controller.state.status, 'waiting');
  assert.ok(f.events.includes('send:fixture:hello Zoey'));
  f.controller.receive('fixture', 1, [row(1, 'assistant', 'old reply'), row(3, 'assistant', 'partial', true)]);
  await tick();
  assert.equal(f.events.some((e) => e.startsWith('speak:')), false);
  f.controller.receive('fixture', 1, [row(3, 'assistant', 'Hello there.')]);
  await tick();
  assert.equal(f.controller.state.status, 'speaking');
  f.utterance();
  assert.equal(f.events.filter((e) => e === 'transcribe').length, 1, 'never capture the speaker output');
  f.finishPlay();
  await tick();
  assert.equal(f.controller.state.status, 'listening');
  f.controller.stop();
  assert.equal(f.controller.state.status, 'off');
  assert.ok(f.events.includes('close'));
});

test('long replies are serialized into <=400 UTF-16 units and never reopen the mic between chunks', async () => {
  const f = fixture();
  await f.controller.start(); f.utterance(); await tick();
  const chunks: string[] = [];
  f.io.synthesize = async (_bot, text) => { chunks.push(text); return new Int16Array([1]); };
  const reply = 'x'.repeat(399) + '😀' + 'y'.repeat(450);
  f.controller.receive('fixture', 1, [row(3, 'assistant', reply)]);
  await tick();
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].length <= 400);
  assert.equal(/[\uD800-\uDBFF]$/.test(chunks[0]), false);
  f.finishPlay(); await tick();
  assert.equal(f.controller.state.status, 'speaking');
  assert.equal(chunks.length, 2);
  f.finishPlay(); await tick(); f.finishPlay(); await tick();
  assert.equal(f.controller.state.status, 'listening');
  assert.equal(chunks.join(''), reply);
  assert.ok(chunks.every((text) => text.length <= 400));
  f.controller.stop();
});

test('pause discards partial speech and stays paused through the assistant turn', async () => {
  const f = fixture(); await f.controller.start();
  f.controller.toggleMute(); f.utterance(); await tick();
  assert.equal(f.controller.state.status, 'paused');
  assert.equal(f.events.includes('transcribe'), false);
  f.controller.toggleMute(); f.utterance(); await tick();
  f.controller.toggleMute();
  f.controller.receive('fixture', 1, [row(3, 'assistant', 'Reply')]); await tick();
  f.finishPlay(); await tick();
  assert.equal(f.controller.state.status, 'paused');
  f.controller.stop();
});

test('SSE arriving before send resolves is buffered against the authoritative sent row, not dropped', async () => {
  const f = fixture(); await f.controller.start();
  let finishSend!: (value: ReturnType<typeof row>) => void;
  f.io.send = async () => new Promise((r) => { finishSend = r; });
  f.utterance(); await tick();
  f.controller.receive('fixture', 1, [row(2, 'user', 'hello Zoey'), row(3, 'assistant', 'Fast reply')]);
  finishSend(row(2, 'user', 'hello Zoey')); await tick();
  assert.ok(f.events.includes('speak:fixture:Fast reply'));
  f.finishPlay(); await tick();
  f.controller.receive('fixture', 1, [row(3, 'assistant', 'Fast reply')]); await tick();
  assert.equal(f.events.filter((e) => e.startsWith('speak:')).length, 1, 'a replay is not new speech');
  f.controller.stop();
});

test('external user messages stop the conversation and discard in-flight local synthesis', async () => {
  const f = fixture(); await f.controller.start(); f.utterance(); await tick();
  let finish!: (pcm: Int16Array) => void;
  f.io.synthesize = async () => new Promise((r) => { finish = r; });
  f.controller.receive('fixture', 1, [row(3, 'assistant', 'reply')]); await tick();
  f.controller.receive('fixture', 1, [row(4, 'user', 'typed in another window')]);
  assert.equal(f.controller.state.status, 'off');
  finish(new Int16Array([1])); await tick();
  assert.equal(f.events.includes('play'), false);
  assert.ok(f.events.includes('close'));
});

test('switching bots or clearing chat releases resources and stale transcription never sends', async () => {
  for (const change of ['bot', 'generation']) {
    const f = fixture(); await f.controller.start();
    let finish!: (text: string) => void;
    let signal!: AbortSignal;
    f.io.transcribe = async (_pcm, abort) => { signal = abort; return new Promise((r) => { finish = r; }); };
    f.utterance();
    f.controller.observe({ ...f.snapshot, botId: change === 'bot' ? 'other' : 'fixture', generation: change === 'generation' ? 2 : 1 });
    assert.equal(signal.aborted, true);
    assert.equal(f.controller.state.status, 'off');
    finish('stale words'); await tick();
    assert.equal(f.events.some((e) => e.startsWith('send:')), false);
  }
});

test('long-running tool turns keep listening off until the final live state and expose explicit cancellation', async () => {
  const f = fixture(); await f.controller.start(); f.utterance(); await tick();
  f.snapshot.running = true;
  f.controller.receive('fixture', 1, [row(3, 'assistant', 'Working on that.')]); await tick();
  f.finishPlay(); await tick();
  assert.equal(f.controller.state.status, 'waiting');
  f.controller.observe({ ...f.snapshot, running: false });
  assert.equal(f.controller.state.status, 'listening');
  f.utterance(); await tick();
  await f.controller.cancelTurn();
  assert.equal(f.controller.state.status, 'off');
  assert.ok(f.events.includes('interrupt'));
});

test('stale microphone callbacks from an ended activation cannot submit into a restarted conversation', async () => {
  const f = fixture();
  let stale!: (pcm: Int16Array) => void;
  let opened!: () => void;
  f.io.activate = async (frame) => { stale = frame; await new Promise<void>((r) => { opened = r; }); };
  const oldStart = f.controller.start();
  f.controller.stop();
  f.io.activate = async () => {};
  await f.controller.start();
  for (let i = 0; i < 10; i++) stale(new Int16Array(960).fill(4000));
  for (let i = 0; i < 25; i++) stale(new Int16Array(960));
  opened(); await oldStart; await tick();
  assert.equal(f.events.includes('transcribe'), false);
  assert.equal(f.controller.state.status, 'listening');
  f.controller.stop();
});

test('a competing user row racing ahead of our accepted send invalidates the whole pending voice turn', async () => {
  const f = fixture(); await f.controller.start();
  let finish!: (r: ReturnType<typeof row>) => void;
  f.io.send = async () => new Promise((r) => { finish = r; });
  f.utterance(); await tick();
  f.controller.receive('fixture', 1, [row(2, 'user', 'another window'), row(3, 'user', 'hello Zoey'), row(4, 'assistant', 'stale reply')]);
  finish(row(3, 'user', 'hello Zoey')); await tick();
  assert.equal(f.controller.state.status, 'off');
  assert.equal(f.events.some((e) => e.startsWith('speak:')), false);
});
