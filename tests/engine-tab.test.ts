import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { registerHooks } from 'node:module';
import type { Bot, EngineInfo } from '../server/src/types.ts';

// Engine tab (details panel): the Hermes home group (home, execution, editable working dir) and the
// tool-allowlist chips that PATCH /api/bots/:id/engine immediately, optimistic with revert on error.

registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });

const win = new EventTarget() as EventTarget & Record<string, unknown>;
Object.assign(globalThis, {
  React,
  window: win,
  document: { visibilityState: 'hidden', activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { protocol: 'http:', host: 'test' },
  fetch: async () => { throw new Error('no network in tests'); },
  CustomEvent: class CustomEvent<T> extends Event { detail: T; constructor(type: string, init?: { detail: T }) { super(type); this.detail = init?.detail as T; } },
});
Object.assign(win, { addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win), dispatchEvent: win.dispatchEvent.bind(win), matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });

const bot = {
  id: 'coder', name: 'Coder', label: 'Builds things', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue', mode: 'personal',
  isPrimary: false, kind: 'agent', pinned: false, effort: 'medium', voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', model: 'qwen3.5:35b', provider: 'ollama',
  generation: 1, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
} as unknown as Bot;

const baseEngine: EngineInfo = {
  botId: 'coder', profile: 'coder', status: 'ready', error: null, model: 'qwen3.5:35b', provider: 'ollama', version: '1', ownScreen: false,
  providers: [{ id: 'ollama', name: 'Ollama (local)', kind: 'api_key', connected: true, models: ['qwen3.5:35b'] }],
  execution: 'host', home: '/Users/x/zoeybot/data/engines/coder', cwd: '/Users/x/proj', toolsets: ['terminal', 'file', 'apps'],
};

const walk = (n: unknown): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(walk).join('') : n && typeof n === 'object' && 'children' in (n as object) ? (n as ReactTestInstance).children.map(walk).join('') : '';
const settle = async () => { await act(async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); }); };

type Patch = { provider?: string | null; model?: string | null; cwd?: string; toolsets?: string[] };

async function mount(opts: { engine?: Partial<EngineInfo>; patch?: (p: Patch) => Promise<{ engine: EngineInfo; note?: string }> } = {}) {
  const { configApi } = await import('../web/src/lib/configApi.ts');
  const { ApiError } = await import('../web/src/lib/api.ts');
  const engine = { ...baseEngine, ...opts.engine };
  const patches: Patch[] = [];
  configApi.engine = async () => ({ engine });
  configApi.setEngine = async (_id: string, p: Patch) => { patches.push(p); return opts.patch ? opts.patch(p) : { engine: { ...engine, ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.toolsets ? { toolsets: p.toolsets } : {}), status: 'starting' as const } }; };
  const { EngineSettings, useEngineInfo } = await import('../web/src/components/EngineSettings.tsx');
  function Host() { const ctl = useEngineInfo(bot); return React.createElement(EngineSettings, { bot, ctl }); }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Host), { createNodeMock: () => ({ style: {}, focus() {} }) }); });
  await settle();
  const chips = () => root.root.findAll((n) => n.type === 'button' && typeof n.props['data-toolset'] === 'string');
  const chip = (id: string) => chips().find((n) => n.props['data-toolset'] === id)!;
  const click = async (n: ReactTestInstance) => { await act(async () => { n.props.onClick?.({ preventDefault() {} }); }); await settle(); };
  return { root, chips, chip, click, patches, ApiError, text: () => walk(root.root) };
}

test('engine tab: Hermes home group shows home (~), Mac host execution and the working dir', async () => {
  const { root, text } = await mount();
  const all = text();
  assert.match(all, /Hermes home/);
  assert.match(all, /~\/zoeybot\/data\/engines\/coder/, 'home dir prefix shown as ~');
  assert.match(all, /Mac host/);
  assert.match(all, /Tool allowlist/);
  assert.match(all, /Changes restart this bot’s agent\./);
  const cwdInput = root.root.findAll((n) => n.type === 'input' && n.props.className === 'field__input')[0];
  assert.ok(cwdInput, 'working dir input');
  assert.equal(cwdInput.props.value, '/Users/x/proj');
  // Existing provider/model form is still there.
  assert.ok(root.root.findAll((n) => n.type === 'select' && n.props['aria-label'] === 'Provider').length === 1);
  act(() => root.unmount());
});

test('engine tab: chips reflect engine.toolsets and clicking Web search PATCHes the new list', async () => {
  const { root, chips, chip, click, patches } = await mount();
  const on = chips().filter((n) => n.props['aria-pressed'] === true).map((n) => n.props['data-toolset']);
  assert.deepEqual(on.sort(), ['apps', 'file', 'terminal']);
  assert.equal(chips().length, 15, 'one chip per valid toolset');
  assert.ok(chip('terminal').props.className.includes('is-on'));
  assert.ok(chip('web').props.className.includes('is-off'));
  assert.equal(walk(chip('web')), 'Web search');
  assert.equal(chip('apps').props.title, 'Connected apps (Composio) through the app');
  await click(chip('web'));
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].toolsets?.slice().sort(), ['apps', 'file', 'terminal', 'web']);
  assert.ok(chip('web').props.className.includes('is-on'), 'web chip is on after the PATCH');
  // The server answered 'starting' → chips are locked and the hint says so.
  assert.equal(chip('web').props.disabled, true);
  assert.match(walk(root.root), /Restarting this bot’s agent/);
  act(() => root.unmount());
});

test('engine tab: a 400 from the patch reverts the chip and shows the error text', async () => {
  const { chip, click, patches, ApiError, text } = await mount({ patch: async () => { throw new ApiError(400, 'unknown toolset: web'); } });
  await click(chip('web'));
  assert.equal(patches.length, 1);
  assert.ok(chip('web').props.className.includes('is-off'), 'reverted');
  assert.equal(chip('web').props.disabled, false, 'unlocked again after the failure');
  assert.match(text(), /unknown toolset: web/);
});

test('engine tab: saving a working dir shows the 400 inline, and the primary note when the server returns one', async () => {
  let fail = true;
  const { root, click, patches, ApiError, text } = await mount({
    patch: async (p) => { if (fail) throw new ApiError(400, 'cwd must be an absolute path to an existing directory'); return { engine: { ...baseEngine, cwd: p.cwd! }, note: 'The primary home is managed outside the app; the working dir was stored.' }; },
  });
  const input = () => root.root.findAll((n) => n.type === 'input' && n.props.className === 'field__input')[0];
  const save = () => root.root.findAll((n) => n.type === 'button' && n.props['data-action'] === 'save-cwd')[0];
  assert.equal(save().props.disabled, true, 'nothing to save yet');
  await act(async () => { input().props.onChange({ target: { value: 'relative/dir' } }); });
  assert.equal(save().props.disabled, false);
  await click(save());
  assert.deepEqual(patches[0], { cwd: 'relative/dir' });
  assert.match(text(), /cwd must be an absolute path/);
  assert.equal(input().props['aria-invalid'], true);
  fail = false;
  await act(async () => { input().props.onChange({ target: { value: '/Users/x/other' } }); });
  await click(save());
  assert.deepEqual(patches[1], { cwd: '/Users/x/other' });
  assert.doesNotMatch(text(), /cwd must be an absolute path/);
  assert.match(text(), /primary home is managed outside the app/);
  assert.equal(input().props.value, '/Users/x/other');
  act(() => root.unmount());
});
