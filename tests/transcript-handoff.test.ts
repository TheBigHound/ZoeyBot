import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { registerHooks } from 'node:module';
import type { Alert, Row } from '../server/src/types.ts';

// Components may import stylesheets; Node has no CSS loader, so treat .css as an empty module.
registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });

// Handoff cards: an ask_bot tool-call is a card of its own in the transcript (not folded into the steps chip),
// and the alert strip under the chat header shows the newest URGENT routine result for any bot.

const win = new EventTarget() as EventTarget & Record<string, unknown>;
const ls = new Map<string, string>();
Object.assign(globalThis, {
  React,
  window: win,
  document: { visibilityState: 'hidden', activeElement: null, addEventListener() {}, removeEventListener() {}, fullscreenEnabled: false, fullscreenElement: null, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v); }, removeItem: (k: string) => { ls.delete(k); } },
  location: { protocol: 'http:', host: 'test', search: '' },
  fetch: async () => { throw new Error('no network in tests'); },
  CustomEvent: class CustomEvent<T> extends Event { detail: T; constructor(type: string, init?: { detail: T }) { super(type); this.detail = init?.detail as T; } },
});
Object.assign(win, { addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win), dispatchEvent: win.dispatchEvent.bind(win), matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });

const mkBot = (id: string, name: string, color = 'blue') => ({
  id, name, label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: color, mode: 'personal',
  isPrimary: id === 'zoey', kind: 'agent', pinned: false, effort: 'medium', voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', model: null, provider: null,
  generation: 1, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
});
const zoey = mkBot('zoey', 'Zoey', 'black');
const researcher = mkBot('res', 'Researcher', 'cyan');

const T0 = Date.UTC(2026, 10, 12, 15, 0, 0);
const row = (seq: number, body: Row['body'], dt = seq * 1000): Row => ({ botId: 'zoey', generation: 1, seq, updatedSeq: seq, kind: body.type as Row['kind'], body, createdAt: T0 + dt });

const askCall = (status: 'running' | 'done' | 'error', summary?: string, wait?: boolean) => row(3, {
  type: 'tool-call', callId: 'c-ask', name: 'ask_bot', label: 'Asking a Bot', status, summary,
  args: { bot_name: 'researcher', request: 'Summary of Ryzen 9 9950X3D findings so far', ...(wait === undefined ? {} : { wait }) },
});

const rows = (ask: Row): Row[] => [
  row(1, { type: 'message', role: 'user', text: 'What has the researcher found?' }),
  row(2, { type: 'tool-call', callId: 'c-web', name: 'web_search', label: 'Searching the web', status: 'done', summary: '3 results' }),
  ask,
  row(4, { type: 'tool-call', callId: 'c-read', name: 'read_file', label: 'Reading a file', status: 'done' }),
  row(5, { type: 'message', role: 'assistant', text: 'Researcher has two in-stock listings.' }),
];

const walk = (n: unknown): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(walk).join('') : n && typeof n === 'object' && 'children' in (n as object) ? (n as ReactTestInstance).children.map(walk).join('') : '';
const text = (n: ReactTestInstance | ReactTestRenderer['root']) => walk(n);
const settle = async () => { await act(async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); }); };
const byClass = (root: ReactTestRenderer, cls: string) => root.root.findAll((n) => typeof n.type === 'string' && typeof n.props.className === 'string' && n.props.className.split(' ').includes(cls));

async function mountTranscript(list: Row[]) {
  const { useStore } = await import('../web/src/store.ts');
  useStore.setState({ bots: [zoey, researcher] as any, selectedBotId: 'zoey' });
  const { Transcript } = await import('../web/src/components/Transcript.tsx');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Transcript, { bot: zoey as any, rows: list, live: undefined, loaded: true }), { createNodeMock: () => ({ style: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, scrollTo() {} }) }); });
  await settle();
  return { root, useStore };
}

test('buildItems: ask_bot gets a handoff item of its own; other tool-calls still fold into steps', async () => {
  const { buildItems } = await import('../web/src/components/Transcript.tsx');
  const items = buildItems(rows(askCall('done', 'Researcher answered')));
  assert.deepEqual(items.map((i) => i.kind), ['divider', 'group', 'steps', 'handoff', 'steps', 'group']);
  const handoff = items.find((i) => i.kind === 'handoff') as Extract<ReturnType<typeof buildItems>[number], { kind: 'handoff' }>;
  assert.equal(handoff.row.seq, 3);
  const steps = items.filter((i) => i.kind === 'steps') as Extract<ReturnType<typeof buildItems>[number], { kind: 'steps' }>[];
  assert.deepEqual(steps.map((s) => s.rows.map((r) => r.seq)), [[2], [4]]);
  assert.equal(steps[0].endTs, handoff.row.createdAt, 'the ask closes the run of steps before it');
  // A transcript with only ordinary tool-calls is unchanged: one steps chip.
  const plain = buildItems(rows(row(3, { type: 'tool-call', callId: 'c-x', name: 'terminal', label: 'Running a command', status: 'done' })));
  assert.deepEqual(plain.map((i) => i.kind), ['divider', 'group', 'steps', 'group']);
  assert.equal((plain[2] as any).rows.length, 3);
});

test('handoff card: answered state shows target, request, reply summary, open link; non-ask steps stay collapsed', async () => {
  const { root, useStore } = await mountTranscript(rows(askCall('done', 'Researcher answered')));
  const cards = byClass(root, 'handoff');
  assert.equal(cards.length, 1);
  const card = text(cards[0]);
  assert.match(card, /ask_bot · Researcher · wait=true/);
  assert.match(card, /Summary of Ryzen 9 9950X3D findings so far/);
  assert.match(card, /Reply/);
  assert.match(card, /Researcher answered/);
  assert.match(card, /visible in both transcripts/);
  const state = byClass(root, 'handoff-state')[0];
  assert.equal(text(state), 'answered');
  assert.match(state.props.className, /is-done/);
  // The two avatars in the head: caller then target.
  assert.ok(byClass(root, 'handoff-head').length === 1);
  // The other tool-calls are still folded into steps chips, each with one step.
  const chips = byClass(root, 'steps');
  assert.equal(chips.length, 2);
  assert.doesNotMatch(text(root.root), /Asking a Bot/, 'the ask is not listed as a step');
  // "Open in Researcher" selects the target bot.
  const open = byClass(root, 'handoff-link')[0];
  assert.equal(text(open), 'Open in Researcher');
  const loads: string[] = [];
  const { api } = await import('../web/src/lib/api.ts');
  api.rows = async (id: string) => { loads.push(id); return { generation: 1, rows: [] }; };
  api.routines = async () => ({ routines: [] });
  // Already-loaded transcripts keep selectBot from fetching rows (store.loadRows reads import.meta.env, which Node lacks).
  useStore.setState({ transcripts: { res: { generation: 1, bySeq: {}, loaded: true } } });
  await act(async () => { open.props.onClick(); });
  assert.equal(useStore.getState().selectedBotId, 'res');
});

test('handoff card: running, task and error states', async () => {
  const running = await mountTranscript(rows(askCall('running', undefined)));
  let state = byClass(running.root, 'handoff-state')[0];
  assert.equal(text(state), 'waiting…');
  assert.match(state.props.className, /is-wait/);
  assert.doesNotMatch(text(byClass(running.root, 'handoff-body')[0]), /Reply/);

  const task = await mountTranscript(rows(askCall('done', 'Asked Researcher (task)', false)));
  state = byClass(task.root, 'handoff-state')[0];
  assert.equal(text(state), 'task · running');
  assert.match(state.props.className, /is-wait/);
  assert.match(text(byClass(task.root, 'handoff-head')[0]), /wait=false/);
  assert.doesNotMatch(text(byClass(task.root, 'handoff-body')[0]), /Reply/, 'a task summary is not a reply');

  const failed = await mountTranscript(rows(askCall('error', 'Researcher did not answer')));
  state = byClass(failed.root, 'handoff-state')[0];
  assert.equal(text(state), 'failed');
  assert.match(state.props.className, /is-danger/);

  // Unknown target: name from the args, no Open link, neutral avatar.
  const unknown = await mountTranscript(rows(row(3, { type: 'tool-call', callId: 'c-ask', name: 'ask_bot', label: 'Asking a Bot', status: 'done', summary: 'Coder answered', args: { bot_name: 'Coder', request: 'Do it' } })));
  assert.match(text(byClass(unknown.root, 'handoff-head')[0]), /ask_bot · Coder · wait=true/);
  assert.equal(byClass(unknown.root, 'handoff-link').length, 0);
});

test('target side: a user message from another bot carries the ask_bot footnote; Telegram footnote unchanged', async () => {
  const list: Row[] = [
    row(1, { type: 'message', role: 'user', text: 'Summary of findings please', from: { kind: 'bot', id: 'zoey', name: 'Zoey' } }),
    row(2, { type: 'message', role: 'assistant', text: 'Two listings in stock.' }),
    row(3, { type: 'message', role: 'user', text: 'thanks', via: 'telegram' }),
  ];
  const { useStore } = await import('../web/src/store.ts');
  useStore.setState({ bots: [zoey, researcher] as any, selectedBotId: 'res' });
  const { Transcript } = await import('../web/src/components/Transcript.tsx');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Transcript, { bot: researcher as any, rows: list, live: undefined, loaded: true }), { createNodeMock: () => ({ style: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, scrollTo() {} }) }); });
  await settle();
  const notes = byClass(root, 'bubble__source').map(text);
  assert.deepEqual(notes, ['asked via ask_bot', 'via Telegram']);
  assert.equal(byClass(root, 'handoff').length, 0);
});

test('alert strip: shows the newest alert for any bot, Open selects it, Dismiss calls the api and reloads', async () => {
  const { useStore } = await import('../web/src/store.ts');
  const { api } = await import('../web/src/lib/api.ts');
  useStore.setState({ bots: [zoey, researcher, mkBot('mw', 'Market Watch', 'orange')] as any, selectedBotId: 'zoey' });
  const alert: Alert = { id: 'alert_1', botId: 'mw', botName: 'Market Watch', routineName: 'Quotes', text: '**URGENT**: NVDA crossed your 2% drop threshold\nMore detail below.', deliveredTo: 1, createdAt: Date.now() - 3 * 60_000, dismissedAt: null };
  let listCalls = 0;
  let pending: Alert[] = [alert];
  api.alerts = async () => { listCalls++; return { alerts: pending }; };
  const dismissed: string[] = [];
  api.dismissAlert = async (id: string) => { dismissed.push(id); pending = []; return { ok: true as const }; };
  api.rows = async () => ({ generation: 1, rows: [] });
  api.routines = async () => ({ routines: [] });
  useStore.setState({ transcripts: { mw: { generation: 1, bySeq: {}, loaded: true } } });
  const { AlertStrip } = await import('../web/src/components/AlertStrip.tsx');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(AlertStrip)); });
  await settle();
  const strip = byClass(root, 'alert-strip')[0];
  assert.ok(strip, 'strip rendered');
  const all = text(strip);
  assert.match(all, /Market Watch/);
  assert.match(all, /NVDA crossed your 2% drop threshold/);
  assert.doesNotMatch(all, /URGENT/, 'the URGENT prefix is stripped');
  assert.doesNotMatch(all, /More detail below/, 'only the first line');
  assert.match(all, /3m/);
  assert.match(all, /sent to Telegram/);
  const buttons = strip.findAll((n) => n.type === 'button');
  assert.deepEqual(buttons.map(text), ['Open', 'Dismiss']);
  // Open: selects the alert's bot and the Open button goes away (now the selected bot).
  await act(async () => { buttons[0].props.onClick(); });
  await settle();
  assert.equal(useStore.getState().selectedBotId, 'mw');
  assert.deepEqual(byClass(root, 'alert-strip')[0].findAll((n) => n.type === 'button').map(text), ['Dismiss']);
  // An SSE 'alerts' event (relayed by the store) reloads the list.
  const before = listCalls;
  await act(async () => { useStore.getState().handleEvent({ type: 'alerts' }); });
  await settle();
  assert.equal(listCalls, before + 1);
  // Dismiss: calls the api with the id and the strip disappears.
  const dismissBtn = byClass(root, 'alert-strip')[0].findAll((n) => n.type === 'button')[0];
  await act(async () => { dismissBtn.props.onClick(); });
  await settle();
  assert.deepEqual(dismissed, ['alert_1']);
  assert.equal(byClass(root, 'alert-strip').length, 0);
});

test('alertHeadline: strips the URGENT marker and cuts long lines', async () => {
  const { alertHeadline } = await import('../web/src/components/AlertStrip.tsx');
  assert.equal(alertHeadline('URGENT: NVDA -12%\nmore'), 'NVDA -12%');
  assert.equal(alertHeadline('\n  **URGENT** — disk full'), 'disk full');
  assert.equal(alertHeadline('URGENT'), 'URGENT', 'a bare marker is kept rather than shown empty');
  assert.equal(alertHeadline('x'.repeat(200)).length, 120);
  assert.ok(alertHeadline('x'.repeat(200)).endsWith('…'));
});
