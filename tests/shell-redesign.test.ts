import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act, type ReactTestInstance } from 'react-test-renderer';

// Shell redesign: the bot roster is a list (not tiles), the chat header is a real row (not a floating
// pill), and the workspace nav gives Channels a home.

function bot(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: id === 'zoey' ? 'Zoey' : 'Rook', label: id === 'zoey' ? 'Chief of Staff' : '', description: 'Research helper', instructions: '',
    avatarShape: 'blob', avatarColor: 'orange', mode: 'personal', isPrimary: id === 'zoey', pinned: false, effort: 'medium',
    voice: 'v', voiceSpeed: 1, voiceLanguage: 'en', model: null, provider: null, generation: 1, unread: 0, lastPreview: null, lastActivityAt: 1, createdAt: 1,
    ...over,
  } as any;
}

async function fixture() {
  const originals = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  Object.assign(globalThis, {
    React,
    window: win,
    document: { activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {}, style: {}, setAttribute() {} } },
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => { throw new Error('offline in test'); },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: undefined, userAgent: 'test', clipboard: undefined } });

  const { useStore } = await import('../web/src/store.ts');
  const { useLocalConversation } = await import('../web/src/voice/localConversationStore.ts');
  const { voiceApi } = await import('../web/src/voice/api.ts');
  const originalOptions = voiceApi.options;
  voiceApi.options = async () => ({ provider: 'local', capabilities: { tts: true, stt: true, realtime: false, calls: false }, voices: [], languages: [], speeds: [] } as any);

  const bots = [bot('zoey'), bot('rook')];
  useStore.setState({
    bots,
    live: { rook: { botId: 'rook', isRunning: true, activity: null, awaiting: null, startedAt: 1, steps: 0 } as any },
    user: { id: 'u', email: 'hound@example.com', name: 'TheHound', avatarUrl: null },
    selectedBotId: 'zoey',
    transcripts: { zoey: { generation: 1, bySeq: {}, loaded: true } },
    detailsOpen: false,
  } as any);
  useLocalConversation.setState({ botId: 'zoey', status: 'speaking', muted: false, transcript: '', reply: '', error: null });

  const nodeMock = () => ({ focus() {}, style: {}, scrollHeight: 20, scrollTop: 0, clientHeight: 10, setSelectionRange() {}, scrollTo() {} });
  const render = async (el: React.ReactElement) => {
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(el, { createNodeMock: nodeMock }); await Promise.resolve(); await new Promise((r) => setImmediate(r)); });
    return root;
  };
  const byClass = (root: ReactTestInstance, cls: string) => root.findAll((n) => typeof n.props.className === 'string' && n.props.className.split(' ').includes(cls));
  const text = (n: ReactTestInstance) => n.findAll((c) => c.children.some((x) => typeof x === 'string')).map((c) => c.children.filter((x) => typeof x === 'string').join('')).join(' ');

  return {
    useStore, render, byClass, text,
    cleanup() {
      voiceApi.options = originalOptions;
      Object.assign(globalThis, { window: originals.window, document: originals.document, localStorage: originals.localStorage, fetch: originals.fetch });
      if (originals.navigator) Object.defineProperty(globalThis, 'navigator', originals.navigator); else Reflect.deleteProperty(globalThis, 'navigator');
    },
  };
}

test('sidebar renders bots as list rows with mode, a ghost create row and workspace nav incl. Channels', async () => {
  const f = await fixture();
  const { Sidebar } = await import('../web/src/components/Sidebar.tsx');
  const root = await f.render(React.createElement(Sidebar));
  try {
    const r = root.root;
    assert.equal(f.byClass(r, 'pinned__tile').length, 0, 'no pinned tile grid');
    const rows = f.byClass(r, 'bot-row').filter((n) => !n.props.className.includes('bot-row--ghost'));
    assert.equal(rows.length, 2, 'both bots are list rows (primary included)');
    const names = rows.map((n) => f.text(f.byClass(n, 'bot-row__name')[0]));
    assert.deepEqual(names, ['Zoey', 'Rook'], 'primary first, full name (no label mashed in)');
    const zoey = rows[0];
    assert.match(f.text(f.byClass(zoey, 'bot-row__sub')[0]), /Chief of Staff · speaking/, 'sub line = role + current mode from the local conversation store');
    assert.equal(f.text(f.byClass(zoey, 'bot-row__meta')[0]), 'voice', 'speaking bot gets the voice meta tag');
    assert.ok(f.byClass(zoey, 'bot-row__dot')[0]?.props.className.includes('is-live'), 'speaking bot shows the live dot');
    const rook = rows[1];
    assert.match(f.text(f.byClass(rook, 'bot-row__sub')[0]), /working/, 'running bot reads as working');
    assert.ok(f.byClass(rook, 'bot-row__dot')[0]?.props.className.includes('is-live'), 'running bot shows the live dot');
    const ghost = f.byClass(r, 'bot-row--ghost');
    assert.equal(ghost.length, 1, 'one ghost create row');
    assert.match(f.text(ghost[0]), /Create a bot/);
    assert.equal(f.byClass(r, 'bot-list__empty').length, 0, 'the old dashed create card is gone');
    const heads = f.byClass(r, 'nav-h').map((n) => f.text(n));
    assert.ok(heads.some((h) => /Bots/i.test(h) && /2 live · 2/.test(h)), `BOTS header shows live count and total, got ${JSON.stringify(heads)}`);
    assert.ok(heads.some((h) => /Workspace/i.test(h)));
    const nav = f.byClass(r, 'nav-item');
    const labels = nav.map((n) => n.props['data-nav']);
    assert.deepEqual(labels, ['tasks', 'routines', 'library', 'channels']);
    const channels = nav.find((n) => n.props['data-nav'] === 'channels')!;
    assert.match(f.text(channels), /Web/, 'Channels shows the Web badge');
    // Routines opens the details panel and asks it for the routines tab.
    const win = globalThis.window as unknown as EventTarget;
    let detail: unknown = null;
    win.addEventListener('hq:details-tab', (e) => { detail = (e as CustomEvent).detail; });
    await act(async () => { nav.find((n) => n.props['data-nav'] === 'routines')!.props.onClick(); });
    assert.equal(detail, 'routines');
    assert.equal(f.useStore.getState().detailsOpen, true);
    assert.ok(f.byClass(r, 'sidebar__search').length === 1, 'search field is present');
    assert.ok(f.byClass(r, 'account__gear').length === 1, 'bottom user row has the settings gear');
  } finally {
    act(() => root.unmount());
    f.cleanup();
  }
});

test('chat view has a real header row with name, role and the voice pill mount — no floating pill', async () => {
  const f = await fixture();
  const { ChatView } = await import('../web/src/components/ChatView.tsx');
  const root = await f.render(React.createElement(ChatView));
  try {
    const r = root.root;
    assert.equal(f.byClass(r, 'chat__pill').length, 0, 'floating pill is gone');
    const header = f.byClass(r, 'chat__header');
    assert.equal(header.length, 1);
    assert.equal(header[0].type, 'header');
    assert.match(f.text(f.byClass(header[0], 'chat__title')[0]), /^Zoey$/);
    assert.match(f.text(f.byClass(header[0], 'chat__sess')[0]), /Chief of Staff/);
    assert.equal(header[0].findAll((n) => n.props['data-voice-pill'] !== undefined).length, 1, 'VoiceStatusPill mount point lives in the header');
    assert.equal(f.byClass(r, 'local-voice__toggle').length, 0, 'old read-aloud pill above the composer is gone');
    const hint = f.byClass(r, 'composer-hint');
    assert.equal(hint.length, 1);
    assert.match(f.text(hint[0]), /to send · hold mic to dictate/);
    assert.match(f.text(hint[0]), /Enter/);
    assert.match(f.text(hint[0]), /Speech processed on this Mac/, 'local provider → speech-only privacy note');
    assert.doesNotMatch(f.text(hint[0]), /Everything stays/, 'no blanket privacy claim');
    assert.equal(f.byClass(r, 'share-btn')[0]?.props.disabled, true, 'Share is not presented as working');
    // The header menu still reaches the old actions.
    const more = f.byClass(header[0], 'chat__more')[0];
    assert.ok(more, 'overflow menu button');
    await act(async () => { more.props.onClick(); });
    const labels = r.findAll((n) => n.type === 'button' && typeof n.props.role === 'string' && n.props.role === 'menuitem').map((n) => f.text(n));
    for (const l of ['Show details', 'Open computer', 'New conversation', 'Bot settings']) assert.ok(labels.some((x) => x.includes(l)), `${l} in ${JSON.stringify(labels)}`);
  } finally {
    act(() => root.unmount());
    f.cleanup();
  }
});

test('transcript renders assistant turns as plain text with a meta line and voice user turns with a footnote', async () => {
  const f = await fixture();
  const { Transcript } = await import('../web/src/components/Transcript.tsx');
  const b = bot('zoey');
  const row = (seq: number, body: Record<string, unknown>) => ({ botId: 'zoey', generation: 1, seq, updatedSeq: seq, createdAt: 1_700_000_000_000 + seq * 1000, body }) as any;
  const rows = [
    row(1, { type: 'message', role: 'user', text: 'repeat your last message', from: { kind: 'voice', id: 'local', name: 'Voice' } }),
    row(2, { type: 'tool-call', callId: 'c1', name: 'read', label: 'Reading', status: 'done' }),
    row(3, { type: 'message', role: 'assistant', text: 'Bottom line: nothing is installed globally.' }),
  ];
  const root = await f.render(React.createElement(Transcript, { bot: b, rows, live: undefined, loaded: true }));
  try {
    const r = root.root;
    assert.equal(f.byClass(r, 'bubble').filter((n) => n.props.className.includes('is-agent')).length, 0, 'assistant text is not in a bubble');
    assert.equal(f.byClass(r, 'agent-text').length, 1);
    const meta = f.byClass(r, 'agent-meta');
    assert.equal(meta.length, 1, 'assistant turn has a meta line');
    assert.match(f.text(meta[0]), /Zoey/);
    assert.equal(f.byClass(r, 'bubble').filter((n) => n.props.className.includes('is-user')).length, 1, 'user turn keeps its bubble');
    assert.match(f.text(f.byClass(r, 'bubble__source')[0]), /Voice · transcribed locally/);
  } finally {
    act(() => root.unmount());
    f.cleanup();
  }
});
