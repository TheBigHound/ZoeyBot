import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

// The root tsx runner uses classic JSX; Vite uses the web tsconfig's automatic runtime.
Object.assign(globalThis, { React, localStorage: { getItem: () => null } });

test('the chat header mounts the voice pill (the single read-aloud opt-in) and the composer cancels obsolete audio before sending', () => {
  const composer = readFileSync(new URL('../web/src/components/Composer.tsx', import.meta.url), 'utf8');
  const chatView = readFileSync(new URL('../web/src/components/ChatView.tsx', import.meta.url), 'utf8');
  assert.match(chatView, /<VoiceStatusPill botId=\{bot.id\} options=\{voiceOptions\}/);
  assert.match(composer, /cancelReadAloud\(\);\s*await api.send/);
});

const local = { provider: 'local', capabilities: { tts: true, stt: true, calls: false, realtime: false }, voices: [{ id: 'Zoey', name: 'Zoey' }], speeds: [1], languages: [] } as const;

test('real store live events trigger new speech, but opening/loading transcript history never does', async () => {
  const { useStore } = await import('../web/src/store.ts');
  const { LocalReadAloud } = await import('../web/src/voice/readAloud.ts');
  const { bindLocalReadAloud } = await import('../web/src/voice/readAloudBinding.ts');
  const spoken: string[] = [];
  const c = new LocalReadAloud({ activate: async () => {}, synthesize: async (_bot, text) => { spoken.push(text); return new Int16Array([1]); }, play: async () => {}, clear() {}, close() {} });
  const row = (seq: number, text: string, streaming = false) => ({ botId: 'fixture', generation: 1, seq, updatedSeq: seq, kind: 'message' as const, createdAt: 0, body: { type: 'message' as const, role: 'assistant' as const, text, streaming } });
  useStore.setState({ selectedBotId: 'fixture', transcripts: { fixture: { generation: 1, loaded: true, bySeq: { 1: row(1, 'historic') } } } });
  const unbind = bindLocalReadAloud(c);
  try {
    await c.enable({ botId: 'fixture', generation: 1, loaded: true, rows: [row(1, 'historic')] });
    // A REST history refresh is intentionally not a live event.
    useStore.setState({ transcripts: { fixture: { generation: 1, loaded: true, bySeq: { 1: row(1, 'historic'), 2: row(2, 'history refresh') } } } });
    assert.deepEqual(spoken, []);
    useStore.getState().handleEvent({ type: 'rows', botId: 'fixture', generation: 1, rows: [row(2, 'history refresh')] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(spoken, [], 'a replay of an already loaded historic row is not a new reply');
    useStore.getState().handleEvent({ type: 'rows', botId: 'fixture', generation: 1, rows: [row(3, 'partial', true)] });
    assert.deepEqual(spoken, []);
    useStore.getState().handleEvent({ type: 'rows', botId: 'fixture', generation: 1, rows: [row(3, 'final spoken reply')] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(spoken, ['final spoken reply']);
    // Switching bots keeps voice on; the other bot's existing history is never read.
    useStore.setState({ selectedBotId: 'another-fixture', transcripts: { ...useStore.getState().transcripts, 'another-fixture': { generation: 1, loaded: true, bySeq: { 5: { ...row(5, 'other history'), botId: 'another-fixture' } } } } });
    assert.equal(c.enabled, true);
    useStore.getState().handleEvent({ type: 'rows', botId: 'fixture', generation: 1, rows: [row(4, 'previous bot keeps talking in the background')] });
    useStore.getState().handleEvent({ type: 'rows', botId: 'another-fixture', generation: 1, rows: [{ ...row(6, 'new reply from the selected bot'), botId: 'another-fixture' }] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(spoken, ['final spoken reply', 'new reply from the selected bot']);
  } finally { unbind(); }
});

test('legacy local toggle is a thin wrapper over the pill: opt-in, absent for cloud voice, silent when compact', async () => {
  const { LocalVoiceToggle } = await import('../web/src/components/LocalVoiceToggle.tsx');
  const html = renderToStaticMarkup(React.createElement(LocalVoiceToggle, { botId: 'fixture', options: local as any }));
  assert.match(html, /class="voice-pill"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /Enable voice/);
  assert.equal(renderToStaticMarkup(React.createElement(LocalVoiceToggle, { botId: 'fixture', options: { ...local, provider: 'xai' } as any })), '');
  assert.equal(renderToStaticMarkup(React.createElement(LocalVoiceToggle, { botId: 'fixture', options: local as any, compact: true })), '');
});
