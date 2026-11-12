import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { registerHooks } from 'node:module';
import type { ChannelsStatus } from '../server/src/types.ts';

// Some components import their stylesheet; Node has no CSS loader, so treat .css as an empty module.
registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });

// Details panel redesign: fixed screen + identity, segmented tabs (Activity · Routines · Channels · Engine · Library),
// Channels tab driven by /api/channels, and the old "Suggested" card / subscription link gone.

const win = new EventTarget() as EventTarget & Record<string, unknown>;
const ls = new Map<string, string>();
Object.assign(globalThis, {
  React,
  window: win,
  document: { visibilityState: 'hidden', activeElement: null, addEventListener() {}, removeEventListener() {}, fullscreenEnabled: false, fullscreenElement: null, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v); }, removeItem: (k: string) => { ls.delete(k); } },
  location: { protocol: 'http:', host: 'test' },
  fetch: async () => { throw new Error('no network in tests'); },
  CustomEvent: class CustomEvent<T> extends Event { detail: T; constructor(type: string, init?: { detail: T }) { super(type); this.detail = init?.detail as T; } },
});
Object.assign(win, { addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win), dispatchEvent: win.dispatchEvent.bind(win), matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });

const bot = {
  id: 'zoey', name: 'Zoey', label: 'Chief of Staff', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'black', mode: 'personal',
  isPrimary: true, kind: 'agent', pinned: false, effort: 'medium', voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', model: 'qwen3.5:35b', provider: 'ollama',
  generation: 1, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
} as const;

const routines = [
  { id: 'r1', botId: 'zoey', name: 'Daily Family Email Digest', prompt: '', schedule: '0 9 * * *', timezone: 'UTC', enabled: true, nextRunAt: Date.now() + 3600_000, lastRunAt: null, description: 'Every day at 9:00 AM' },
  { id: 'r2', botId: 'zoey', name: 'Flag Family Emails Important', prompt: '', schedule: '', timezone: 'UTC', enabled: true, nextRunAt: null, lastRunAt: Date.now() - 11 * 60_000, description: 'When Gmail: new message' },
  { id: 'r3', botId: 'zoey', name: 'Paused one', prompt: '', schedule: '', timezone: 'UTC', enabled: false, nextRunAt: null, lastRunAt: null, description: '' },
];

const engine = { botId: 'zoey', profile: 'default', status: 'ready', error: null, model: 'qwen3.5:35b', provider: 'ollama', version: '1', ownScreen: false, providers: [{ id: 'ollama', name: 'Ollama (local)', kind: 'api_key', connected: true, models: ['qwen3.5:35b'] }] };

const walk = (n: unknown): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(walk).join('') : n && typeof n === 'object' && 'children' in (n as object) ? (n as ReactTestInstance).children.map(walk).join('') : '';
const text = (n: ReactTestInstance | ReactTestRenderer['root']) => walk(n);
const settle = async () => { await act(async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); }); };

async function mount(channels: ChannelsStatus) {
  const { useStore } = await import('../web/src/store.ts');
  const { api } = await import('../web/src/lib/api.ts');
  const { configApi } = await import('../web/src/lib/configApi.ts');
  api.channels = async () => channels;
  configApi.engine = async () => ({ engine: engine as any });
  configApi.botTasks = async () => ({ tasks: [] });
  useStore.setState({ bots: [bot as any], selectedBotId: 'zoey', routines: { zoey: routines as any }, computer: { status: 'running', orgoId: null, error: null, screens: [] }, live: { zoey: { botId: 'zoey', isRunning: true, activity: { kind: 'reading_web', detail: 'Gmail', since: Date.now() }, awaiting: null, startedAt: Date.now() } }, detailsOpen: true });
  const { DetailsPanel } = await import('../web/src/components/DetailsPanel.tsx');
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(DetailsPanel), { createNodeMock: () => ({ style: {}, focus() {} }) }); });
  await settle();
  const tabs = () => root.root.findAll((n) => n.type === 'button' && n.props.role === 'tab');
  const click = async (n: ReactTestInstance) => { await act(async () => { n.props.onClick?.({ preventDefault() {} }); }); await settle(); };
  return { root, tabs, click, useStore };
}

const full: ChannelsStatus = { web: { connected: true }, telegram: { configured: true, username: 'zoey_hq_bot', chatAllowlisted: true, notifications: true }, slack: { connected: false } };

test('details panel: title, tab strip, no suggested card or subscription link', async () => {
  const { root, tabs } = await mount(full);
  const all = text(root.root);
  assert.match(all, /Zoey’s computer/);
  assert.deepEqual(tabs().map((t) => t.props['data-tab']), ['activity', 'routines', 'channels', 'engine', 'library']);
  assert.match(text(tabs()[1]), /Routines/);
  assert.match(text(tabs()[1]), /2/, 'routine count = enabled routines');
  assert.match(text(tabs()[2]), /Channels/);
  assert.doesNotMatch(all, /Suggested/);
  assert.doesNotMatch(all, /Sign in to a subscription/);
  assert.doesNotMatch(all, /Add to Slack/);
  // Activity tab summary: up next, channels, engine kv, and the live caption on the screen.
  assert.match(all, /Up next/i);
  assert.match(all, /Daily Family Email Digest/);
  assert.match(all, /Ollama \(local\)/);
  assert.match(all, /qwen3\.5:35b/);
  // No standalone LIVE badge: VM "running" is not a streaming frame; only ComputerScreen's phase badge may say Live.
  assert.doesNotMatch(all, /LIVE/);
  assert.equal(root.root.findAll((n) => n.props?.className === 'details__live').length, 0);
  assert.match(all, /Awake/);
  assert.match(all, /Reading/);
  assert.ok(root.root.findAll((n) => n.type === 'button' && n.props['aria-label'] === 'Pop out').length === 1);
});

test('details panel: hq:details-tab event switches tabs and the tab is remembered', async () => {
  const { root, tabs } = await mount(full);
  await act(async () => { win.dispatchEvent(new CustomEvent('hq:details-tab', { detail: 'engine' })); });
  await settle();
  assert.equal(tabs().find((t) => t.props['aria-selected'] === true)?.props['data-tab'], 'engine');
  assert.equal(ls.get('hq.detailsTab'), 'engine');
  assert.match(text(root.root), /Provider/);
  assert.ok(root.root.findAll((n) => n.type === 'select' && n.props['aria-label'] === 'Provider').length === 1, 'engine form present');
  await act(async () => { win.dispatchEvent(new CustomEvent('hq:details-tab', { detail: 'routines' })); });
  await settle();
  assert.equal(tabs().find((t) => t.props['aria-selected'] === true)?.props['data-tab'], 'routines');
  assert.match(text(root.root), /Paused one/);
  assert.equal(root.root.findAll((n) => n.type === 'button' && n.props.role === 'switch').length, 3);
  ls.delete('hq.detailsTab');
});

test('details panel: channels tab — telegram configured + allowlisted', async () => {
  const { root, tabs, click } = await mount(full);
  await click(tabs()[2]);
  const all = text(root.root);
  assert.match(all, /Web · this Mac/);
  assert.match(all, /Connected · you’re here/);
  assert.match(all, /@zoey_hq_bot/);
  assert.match(all, /notifications on/);
  assert.match(all, /Slack/);
  assert.match(all, /Not connected/);
  assert.ok(root.root.findAll((n) => n.type === 'button' && n.props['data-channel'] === 'slack-add').length === 1);
  ls.delete('hq.detailsTab');
});

test('details panel: channels tab — telegram configured but no chat allowlisted', async () => {
  const { root, tabs, click } = await mount({ ...full, telegram: { configured: true, username: 'zoey_hq_bot', chatAllowlisted: false, notifications: true }, slack: { connected: true } });
  await click(tabs()[2]);
  const all = text(root.root);
  assert.match(all, /Send \/start to @zoey_hq_bot to finish setup/);
  assert.match(all, /Connected/);
  ls.delete('hq.detailsTab');
});

test('details panel: channels tab — telegram not set up shows Set up + inline explainer', async () => {
  const { root, tabs, click } = await mount({ ...full, telegram: { configured: false, chatAllowlisted: false, notifications: true } });
  await click(tabs()[2]);
  assert.match(text(root.root), /Not set up/);
  const setup = root.root.findAll((n) => n.type === 'button' && n.props['data-channel'] === 'telegram-setup')[0];
  assert.ok(setup, 'Set up button');
  assert.doesNotMatch(text(root.root), /TELEGRAM_BOT_TOKEN/);
  await click(setup);
  assert.match(text(root.root), /Add TELEGRAM_BOT_TOKEN to \.env\.local and restart/);
  ls.delete('hq.detailsTab');
});
