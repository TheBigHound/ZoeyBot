import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { LocalConversation } from '../web/src/voice/localConversation.ts';

Object.assign(globalThis, { React, localStorage: { getItem: () => null } });
const tick = () => new Promise<void>((r) => setImmediate(r));
const row = (seq: number, role: 'user' | 'assistant', text: string, streaming = false) => ({ botId: 'fixture', generation: 1, seq, updatedSeq: seq, kind: 'message' as const, createdAt: 0, body: { type: 'message' as const, role, text, streaming } });

test('real store live rows feed local conversation, but history, foreign bots and replay do not', async () => {
  const { useStore } = await import('../web/src/store.ts');
  const { bindLocalConversation, localConversationSnapshot } = await import('../web/src/voice/localConversationBinding.ts');
  useStore.setState({ selectedBotId: 'fixture', live: {}, transcripts: { fixture: { generation: 1, loaded: true, bySeq: { 1: row(1, 'assistant', 'historic') } } } });
  const spoken: string[] = [];
  let frame!: (pcm: Int16Array) => void;
  const c = new LocalConversation({
    snapshot: localConversationSnapshot,
    activate: async (onFrame) => { frame = onFrame; }, mute() {},
    transcribe: async () => 'hello',
    send: async () => {
      const r = row(2, 'user', 'hello');
      useStore.getState().handleEvent({ type: 'rows', botId: 'fixture', generation: 1, rows: [r] });
      return r;
    },
    synthesize: async (_bot, text) => { spoken.push(text); return new Int16Array([1]); },
    play: async () => {}, clear() {}, close() {}, interrupt: async () => {}, level: () => 0,
  });
  const unbind = bindLocalConversation(c);
  try {
    await c.start();
    for (let i = 0; i < 10; i++) frame(new Int16Array(960).fill(4000));
    for (let i = 0; i < 25; i++) frame(new Int16Array(960));
    await tick();
    assert.equal(c.state.status, 'waiting');
    // REST-only rows and their subsequent SSE replay remain silent.
    useStore.getState().upsertRows('fixture', 1, [row(3, 'assistant', 'loaded history')]);
    useStore.getState().handleEvent({ type: 'rows', botId: 'fixture', generation: 1, rows: [row(3, 'assistant', 'loaded history')] });
    useStore.getState().handleEvent({ type: 'rows', botId: 'elsewhere', generation: 1, rows: [row(4, 'assistant', 'wrong bot')] });
    useStore.getState().handleEvent({ type: 'rows', botId: 'fixture', generation: 1, rows: [row(4, 'assistant', 'partial', true)] });
    await tick(); assert.deepEqual(spoken, []);
    useStore.getState().handleEvent({ type: 'rows', botId: 'fixture', generation: 1, rows: [row(4, 'assistant', 'new final reply')] });
    await tick(); assert.deepEqual(spoken, ['new final reply']);
    useStore.setState({ selectedBotId: 'another-fixture' });
    assert.equal(c.state.status, 'off');
  } finally { unbind(); }
});

test('local capability gating allows turn-based chat when realtime calls are intentionally false', async () => {
  const { supportsLocalConversation } = await import('../web/src/voice/localConversationBrowser.ts');
  const local = { provider: 'local' as const, capabilities: { tts: true, stt: true, realtime: false, calls: false }, voices: [], languages: [], speeds: [] };
  assert.equal(supportsLocalConversation(local), true);
  assert.equal(supportsLocalConversation({ ...local, provider: 'xai' }), false);
  assert.equal(supportsLocalConversation({ ...local, capabilities: { ...local.capabilities, stt: false } }), false);
  assert.equal(supportsLocalConversation(null), false);
});

test('composer wires the far-right local control without changing cloud startCall', () => {
  const composer = readFileSync(new URL('../web/src/components/Composer.tsx', import.meta.url), 'utf8');
  assert.match(composer, /startLocalConversation\(bot.id\)/);
  assert.match(composer, /startCall\(bot.id\)/);
  assert.match(composer, /<LocalConversationPanel/);
  assert.match(composer, /supportsLocalConversation\(voiceOptions\)/);
  assert.match(composer, /endLocalConversation\(\);\s*cancelReadAloud\(\);\s*await api.send/);
});

test('conversation panel exposes listening/pause, captions, long-turn cancellation, End and visible errors', async () => {
  const { LocalConversationView } = await import('../web/src/components/LocalConversationPanel.tsx');
  const voice = { botId: 'fixture', status: 'waiting' as const, muted: false, transcript: 'Hello Zoey', reply: '', error: null, turn: {} };
  const html = renderToStaticMarkup(React.createElement(LocalConversationView, { botId: 'fixture', name: 'Zoey', voice }));
  assert.match(html, /Local voice conversation with Zoey/);
  assert.match(html, /Skip reply/);
  assert.match(html, /aria-label="End voice conversation"/);
  assert.match(html, /Pause listening/);
  assert.match(html, /Hello Zoey/);
  assert.match(html, /Whisper/);
  const error = renderToStaticMarkup(React.createElement(LocalConversationView, { botId: 'fixture', name: 'Zoey', voice: { ...voice, status: 'error', error: 'Microphone access was blocked.' } }));
  assert.match(error, /role="alert"/);
  assert.match(error, /Microphone access was blocked/);
  assert.equal(renderToStaticMarkup(React.createElement(LocalConversationView, { botId: 'fixture', name: 'Zoey', voice: { ...voice, status: 'off' } })), '');
});
