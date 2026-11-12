import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalConversation, railSteps, formatStepTime, type LocalConversationState, type LocalConversationTransport } from '../web/src/voice/localConversation.ts';

Object.assign(globalThis, { React, localStorage: { getItem: () => null } });
const tick = () => new Promise<void>((r) => setImmediate(r));
const row = (seq: number, role: 'user' | 'assistant', text: string, streaming = false) => ({ botId: 'fixture', generation: 1, seq, updatedSeq: seq, kind: 'message' as const, createdAt: 0, body: { type: 'message' as const, role, text, streaming } });
const base: LocalConversationState = { botId: 'fixture', status: 'off', muted: false, transcript: '', reply: '', error: null, turn: {} };

function clock() {
  const original = Date.now;
  let now = 10_000;
  Date.now = () => now;
  return { advance: (ms: number) => { now += ms; }, get now() { return now; }, restore: () => { Date.now = original; } };
}

function fixture() {
  let onFrame = (_pcm: Int16Array) => {};
  let finishPlay = () => {};
  const snapshot = { botId: 'fixture', generation: 1, loaded: true, running: false, rows: [row(1, 'assistant', 'old reply')] };
  const io: LocalConversationTransport = {
    snapshot: () => snapshot,
    activate: async (frame) => { onFrame = frame; },
    mute() {},
    transcribe: async () => 'hello Zoey',
    send: async (_botId, text) => row(2, 'user', text),
    synthesize: async () => new Int16Array([1]),
    play: async () => { await new Promise<void>((resolve) => { finishPlay = resolve; }); },
    clear: () => { finishPlay(); },
    close() {},
    interrupt: async () => {},
    level: () => 0,
  };
  const controller = new LocalConversation(io);
  const utterance = () => { for (let i = 0; i < 10; i++) onFrame(new Int16Array(960).fill(4000)); for (let i = 0; i < 25; i++) onFrame(new Int16Array(960)); };
  return { controller, io, snapshot, utterance, finishPlay: () => finishPlay() };
}

test('rail derivation: the current step is lit, earlier steps are done with their timings, later steps are hollow', () => {
  const now = 50_000;
  const turn = { listeningStartedAt: 40_000, listeningMs: 3200, transcribingStartedAt: 43_200, transcribingMs: 600, waitingStartedAt: 43_800, waitingMs: 4100, speakingStartedAt: 47_900 };
  const states = (status: LocalConversationState['status']) => railSteps({ ...base, status, turn }, now).map((s) => s.state).join(',');
  assert.equal(states('starting'), 'todo,todo,todo,todo');
  assert.equal(states('listening'), 'on,todo,todo,todo');
  assert.equal(states('paused'), 'on,todo,todo,todo');
  assert.equal(states('transcribing'), 'done,on,todo,todo');
  assert.equal(states('sending'), 'done,done,on,todo');
  assert.equal(states('waiting'), 'done,done,on,todo');
  assert.equal(states('synthesizing'), 'done,done,done,on');
  assert.equal(states('speaking'), 'done,done,done,on');
  const speaking = railSteps({ ...base, status: 'speaking', turn }, now);
  assert.deepEqual(speaking.map((s) => s.ms), [3200, 600, 4100, 2100]);
  assert.deepEqual(speaking.map((s) => s.id), ['listening', 'transcribing', 'waiting', 'speaking']);
  // The live step counts from its own start; done steps keep their recorded duration.
  const listening = railSteps({ ...base, status: 'listening', turn: { listeningStartedAt: 49_000 } }, now);
  assert.equal(listening[0].ms, 1000);
  assert.equal(listening[1].ms, undefined);
  // After a tool-heavy reply, waiting can light up again with the speaking step done behind it.
  const again = railSteps({ ...base, status: 'waiting', turn: { ...turn, speakingMs: 7000, speakingStartedAt: undefined } }, now);
  assert.equal(again.map((s) => s.state).join(','), 'done,done,on,done');
  assert.equal(formatStepTime(3240), '3.2s');
  assert.equal(formatStepTime(7000, 'clock'), '0:07');
  assert.equal(formatStepTime(65_000, 'clock'), '1:05');
});

test('controller records turn timings at each state transition and starts a fresh turn when listening resumes', async () => {
  const c = clock();
  const f = fixture();
  try {
    await f.controller.start();
    assert.equal(f.controller.state.turn.listeningStartedAt, c.now);
    c.advance(3200); f.utterance(); await tick();
    assert.equal(f.controller.state.status, 'waiting');
    assert.equal(f.controller.state.turn.listeningMs, 3200);
    assert.equal(f.controller.state.turn.transcribingMs, 0);
    assert.equal(f.controller.state.turn.waitingStartedAt, c.now);
    c.advance(4100);
    f.controller.receive('fixture', 1, [row(3, 'assistant', 'Hello there.')]); await tick();
    assert.equal(f.controller.state.status, 'speaking');
    assert.equal(f.controller.state.turn.waitingMs, 4100);
    assert.equal(f.controller.state.turn.speakingStartedAt, c.now);
    c.advance(7000); f.finishPlay(); await tick();
    assert.equal(f.controller.state.status, 'listening');
    assert.deepEqual(f.controller.state.turn, { listeningStartedAt: c.now }, 'a new turn begins when the mic reopens');
  } finally { c.restore(); f.controller.stop(); }
});

test('speakingStartedAt survives chunk boundaries and speakingMs is recorded when a tool turn keeps waiting', async () => {
  const c = clock();
  const f = fixture();
  try {
    await f.controller.start(); f.utterance(); await tick();
    f.snapshot.running = true;
    f.controller.receive('fixture', 1, [row(3, 'assistant', 'x'.repeat(399) + ' ' + 'y'.repeat(300))]); await tick();
    const startedAt = f.controller.state.turn.speakingStartedAt;
    assert.equal(startedAt, c.now);
    c.advance(1500); f.finishPlay(); await tick();
    assert.equal(f.controller.state.status, 'speaking');
    assert.equal(f.controller.state.turn.speakingStartedAt, startedAt);
    c.advance(1500); f.finishPlay(); await tick();
    assert.equal(f.controller.state.status, 'waiting');
    assert.equal(f.controller.state.turn.speakingMs, 3000);
    assert.equal(f.controller.state.turn.waitingStartedAt, c.now);
  } finally { c.restore(); f.controller.stop(); }
});

test('voice panel: Skip reply only renders while a reply can be interrupted, End carries its accessible name, QA status strings stay', async () => {
  const { LocalConversationView } = await import('../web/src/components/LocalConversationPanel.tsx');
  const markup = (voice: Partial<LocalConversationState>) => renderToStaticMarkup(React.createElement(LocalConversationView, { botId: 'fixture', name: 'Zoey', voice: { ...base, botId: 'fixture', ...voice }, level: 0.5, history: [0.1, 0.9], now: 1000 }));
  // What a browser QA sees: textContent, not markup.
  const render = (voice: Partial<LocalConversationState>) => markup(voice).replace(/<[^>]+>/g, '');
  for (const status of ['waiting', 'synthesizing', 'speaking'] as const) assert.match(render({ status }), /Skip reply/, status);
  for (const status of ['starting', 'listening', 'paused', 'transcribing', 'sending'] as const) assert.doesNotMatch(render({ status }), /Skip reply/, status);
  const html = render({ status: 'speaking', transcript: 'Repeat your last message.', reply: 'Bottom line.' });
  const raw = markup({ status: 'speaking', transcript: 'Repeat your last message.', reply: 'Bottom line.' });
  assert.match(raw, /aria-label="End voice conversation"[^>]*>End</);
  assert.match(html, /Zoey is speaking · mic paused until she finishes/);
  assert.match(html, /Output · Zoey/);
  assert.match(html, /mic off/);
  assert.match(html, /Local voice/); assert.match(html, /Turn-based/);
  assert.match(html, /Whisper \+ phonon run on this Mac/);
  assert.match(html, /You · voice/i); assert.match(html, /Repeat your last message\./); assert.match(html, /Bottom line\./);
  assert.match(html, /Pause listening/);
  assert.match(render({ status: 'starting' }), /Opening microphone/);
  assert.match(render({ status: 'listening' }), /Listening · pause ~1s to send/);
  assert.match(render({ status: 'listening' }), /Input · you/);
  assert.match(render({ status: 'paused', muted: true }), /Listening paused/);
  assert.match(render({ status: 'paused', muted: true }), /Resume listening/);
  assert.match(render({ status: 'transcribing' }), /Transcribing locally/);
  assert.match(render({ status: 'waiting' }), /Waiting for Zoey · tools may take a while/);
  assert.match(render({ status: 'synthesizing' }), /Preparing speech/);
  const error = markup({ status: 'error', error: 'Microphone access was blocked.' });
  assert.match(error, /role="alert"/); assert.match(error, /Microphone access was blocked/);
  assert.match(error, /aria-label="End voice conversation"/);
  assert.equal(render({ status: 'off' }), '');
  assert.equal(render({ status: 'listening', botId: 'other' }), '');
  // 40 level bars are rendered from the published history.
  assert.equal((raw.match(/class="voice-panel__bar"/g) ?? []).length, 40);
});

type Rendered = { type: string; props: Record<string, unknown>; children: Rendered[] | null } | string;
const flat = (n: Rendered | Rendered[] | null): string => n === null ? '' : typeof n === 'string' ? n : Array.isArray(n) ? n.map(flat).join('') : flat(n.children);
const classes = (n: Rendered | Rendered[] | null): string[] => n === null || typeof n === 'string' ? [] : Array.isArray(n) ? n.flatMap(classes) : [String(n.props.className ?? ''), ...classes(n.children)];
const disabledAttr = (n: Rendered | Rendered[] | null): boolean => n === null || typeof n === 'string' ? false : Array.isArray(n) ? n.some(disabledAttr) : !!n.props.disabled || disabledAttr(n.children);

test('voice status pill: Mic live only while listening unmuted; every other phase is honest about a paused mic', async () => {
  // zustand hooks serve the initial state under server rendering, so mount with react-test-renderer.
  const { create, act } = await import('react-test-renderer');
  const { VoiceStatusPill } = await import('../web/src/components/VoiceStatusPill.tsx');
  const { useLocalConversation } = await import('../web/src/voice/localConversationStore.ts');
  const { useReadAloud } = await import('../web/src/voice/readAloudStore.ts');
  const { useStore } = await import('../web/src/store.ts');
  const win = { addEventListener() {}, removeEventListener() {} };
  const original = (globalThis as any).window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  const options = { provider: 'local' as const, capabilities: { tts: true, stt: true, realtime: false, calls: false }, voices: [], languages: [], speeds: [] };
  let root!: ReturnType<typeof create>;
  // Unmounting the last pill releases the read-aloud binding (which disables read-aloud), so state that must survive
  // the mount is applied inside `after`, once the new pill is up.
  const render = (opts = options, after: () => void = () => {}) => {
    act(() => { root?.unmount(); root = create(React.createElement(VoiceStatusPill, { botId: 'fixture', options: opts })); });
    act(() => { after(); });
    const json = root.toJSON() as Rendered | Rendered[] | null;
    return { text: flat(json), cls: classes(json)[0] ?? '', disabled: disabledAttr(json), empty: json === null };
  };
  try {
    useStore.setState({ transcripts: { fixture: { generation: 1, loaded: true, bySeq: {} } } as any, bots: [{ id: 'fixture', name: 'Zoey' } as any] });
    useLocalConversation.setState({ ...base, botId: 'fixture', status: 'listening' });
    let r = render();
    assert.equal(r.cls, 'voice-pill is-live'); assert.match(r.text, /Mic live · local voice/);
    for (const status of ['transcribing', 'sending', 'waiting', 'synthesizing', 'speaking'] as const) {
      useLocalConversation.setState({ ...base, botId: 'fixture', status });
      r = render();
      assert.equal(r.cls, 'voice-pill is-paused', status); assert.match(r.text, /Mic paused/, status); assert.doesNotMatch(r.text, /Mic live/, status);
    }
    assert.match(r.text, /Mic paused · Zoey speaking/);
    useLocalConversation.setState({ ...base, botId: 'fixture', status: 'listening', muted: true });
    r = render();
    assert.equal(r.cls, 'voice-pill is-paused'); assert.doesNotMatch(r.text, /Mic live/);
    useLocalConversation.setState({ ...base, botId: 'fixture', status: 'paused', muted: true });
    r = render();
    assert.equal(r.cls, 'voice-pill is-paused'); assert.match(r.text, /Mic paused/);
    useLocalConversation.setState({ ...base, botId: 'fixture', status: 'starting' });
    r = render();
    assert.match(r.text, /Starting mic/); assert.doesNotMatch(r.text, /Mic live/);
    // A conversation on another bot does not light this bot's pill.
    useLocalConversation.setState({ ...base, botId: 'other', status: 'listening' });
    r = render(options, () => useReadAloud.setState({ enabled: true, status: 'ready', error: null }));
    assert.equal(r.cls, 'voice-pill is-on'); assert.match(r.text, /Voice on · replies read aloud/); assert.equal(r.disabled, false);
    useReadAloud.setState({ enabled: false, status: 'off', error: null });
    useLocalConversation.setState({ ...base, status: 'off' });
    r = render();
    assert.equal(r.cls, 'voice-pill'); assert.match(r.text, /Enable voice/); assert.equal(r.disabled, false);
    assert.equal(render({ ...options, capabilities: { ...options.capabilities, tts: false } }).disabled, true);
    useStore.setState({ transcripts: {} });
    assert.equal(render().disabled, true);
    assert.equal(render({ ...options, provider: 'xai' }).empty, true);
  } finally { act(() => { root?.unmount(); }); Object.defineProperty(globalThis, 'window', { configurable: true, value: original }); }
});

test('voice status pill owns the read-aloud binding: connects once per page, pagehide disables, unmount disconnects', async () => {
  const { create, act } = await import('react-test-renderer');
  const { VoiceStatusPill } = await import('../web/src/components/VoiceStatusPill.tsx');
  const { useStore } = await import('../web/src/store.ts');
  const listeners = new Map<string, Set<EventListener>>();
  const win = {
    addEventListener: (type: string, fn: EventListener) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener: (type: string, fn: EventListener) => { listeners.get(type)?.delete(fn); },
  };
  const original = (globalThis as any).window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  try {
    const options = { provider: 'local' as const, capabilities: { tts: true, stt: true, realtime: false, calls: false }, voices: [], languages: [], speeds: [] };
    void useStore;
    let a!: ReturnType<typeof create>; let b!: ReturnType<typeof create>;
    act(() => { a = create(React.createElement(VoiceStatusPill, { botId: 'fixture', options })); });
    act(() => { b = create(React.createElement(VoiceStatusPill, { botId: 'fixture', options })); });
    assert.equal(listeners.get('pagehide')?.size, 1, 'two mounted pills share one pagehide/read-aloud binding');
    act(() => { a.unmount(); });
    assert.equal(listeners.get('pagehide')?.size, 1, 'binding survives while any pill remains');
    act(() => { b.unmount(); });
    assert.equal(listeners.get('pagehide')?.size ?? 0, 0, 'last unmount releases the binding');
    act(() => { a = create(React.createElement(VoiceStatusPill, { botId: 'fixture', options: { ...options, provider: 'xai' } })); });
    assert.equal(listeners.get('pagehide')?.size ?? 0, 0, 'non-local providers never bind');
    act(() => { a.unmount(); });
  } finally { Object.defineProperty(globalThis, 'window', { configurable: true, value: original }); }
});

test('skip reply drops the current speech, interrupts the bot turn and reopens the mic; the skipped reply is never spoken later', async () => {
  const c = clock();
  const f = fixture();
  const events: string[] = [];
  f.io.interrupt = async () => { events.push('interrupt'); };
  const spoken: string[] = [];
  f.io.synthesize = async (_b, text) => { spoken.push(text); return new Int16Array([1]); };
  try {
    await f.controller.start(); f.utterance(); await tick();
    f.controller.receive('fixture', 1, [row(3, 'assistant', 'First long reply')]); await tick();
    assert.equal(f.controller.state.status, 'speaking');
    c.advance(1200);
    const skipping = f.controller.skipReply();
    assert.equal(f.controller.state.status, 'waiting', 'speech is cut immediately');
    await skipping; await tick();
    assert.deepEqual(events, ['interrupt']);
    assert.equal(f.controller.state.status, 'listening', 'the conversation continues');
    assert.equal(f.controller.state.turn.listeningStartedAt, c.now);
    // The next turn works normally.
    f.utterance(); await tick();
    assert.equal(f.controller.state.status, 'waiting');
    f.controller.receive('fixture', 1, [row(5, 'assistant', 'Second reply')]); await tick();
    assert.equal(f.controller.state.status, 'speaking');
    assert.deepEqual(spoken, ['First long reply', 'Second reply']);
    f.finishPlay(); await tick();
    assert.equal(f.controller.state.status, 'listening');
    // Skip while tools are still running keeps waiting instead of reopening the mic.
    f.utterance(); await tick();
    f.snapshot.running = true;
    f.controller.receive('fixture', 1, [row(7, 'assistant', 'Working…')]); await tick();
    await f.controller.skipReply(); await tick();
    assert.equal(f.controller.state.status, 'waiting');
    f.controller.observe({ ...f.snapshot, running: false });
    assert.equal(f.controller.state.status, 'listening');
    // Skip is a no-op outside an interruptible phase.
    await f.controller.skipReply();
    assert.equal(f.controller.state.status, 'listening');
    assert.equal(events.length, 2);
  } finally { c.restore(); f.controller.stop(); }
});

test('a skipped reply whose synthesis is still in flight cannot play, and the next reply still gets spoken', async () => {
  const f = fixture();
  let finish!: (pcm: Int16Array) => void;
  const played: number[] = [];
  f.io.synthesize = async () => new Promise((r) => { finish = r; });
  f.io.play = async (pcm) => { played.push(pcm.length); };
  try {
    await f.controller.start(); f.utterance(); await tick();
    f.controller.receive('fixture', 1, [row(3, 'assistant', 'Stale')]); await tick();
    assert.equal(f.controller.state.status, 'synthesizing');
    await f.controller.skipReply(); await tick();
    assert.equal(f.controller.state.status, 'listening');
    f.utterance(); await tick();
    f.controller.receive('fixture', 1, [row(5, 'assistant', 'Fresh')]); await tick();
    // Stale synth resolves after the new turn queued a reply: nothing stale plays, the fresh reply is spoken.
    const stale = finish; f.io.synthesize = async () => new Int16Array([7, 7]);
    stale(new Int16Array([1])); await tick(); await tick();
    assert.deepEqual(played, [2]);
    assert.equal(f.controller.state.status, 'listening');
  } finally { f.controller.stop(); }
});
