import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now } from '../db.js';
import { hub } from '../lib/hub.js';
import { emitBot } from '../store.js';
import { createBot, COLORS, SHAPES } from '../bots.js';
import { engineHome, engineInfo, forgetEngineOptions, syncPersona, updateEngineSettings } from '../engine.js';
import { KNOWN_TOOLSETS, validToolsets } from '../engine-runtime.js';
import type { ToolCtx, ToolDef, ToolResult } from './tools.js';

/**
 * The bot builder's tools: create a bot, change a bot's setup, copy a skill into a bot's home.
 *
 * Who may call them is decided in mcp.ts, not here and not in any prompt: only a bot whose row has
 * `builder=1`, and (for the three that change something) only in a turn the person started in that
 * bot's own chat. On top of that every change the person has not already approved in this build
 * waits on an approval card:
 *   - create_bot always asks;
 *   - configure_bot_engine and seed_bot_skill ask unless the target was created by this builder
 *     less than FRESH_MS ago (finishing a build the person just approved).
 * There is no delete here and nothing reaches the primary bot.
 */

/** How long after create_bot the builder may finish setting up its new bot without a second card. */
export const FRESH_MS = 2 * 60 * 60_000;

/** Test seams: everything that starts a gateway, touches a Hermes home or reads the person's skills. */
export const builderDeps = {
  createBot,
  engineInfo,
  updateEngineSettings,
  syncPersona,
  engineHome,
  /** Where seed_bot_skill looks for a skill directory, in order. */
  skillRoots: (builderBotId: string): string[] => {
    const own = engineHome(builderBotId);
    return [path.join(os.homedir(), '.hermes', 'skills'), ...(own ? [path.join(own, 'skills')] : [])];
  },
  readyTimeoutMs: 180_000,
  pollMs: 3000,
};

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const fail = (output: string): ToolResult => ({ output, summary: 'Refused' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function botByName(userId: string, name: unknown) {
  const n = String(name ?? '').trim();
  return (db.prepare('SELECT * FROM bots WHERE user_id=? AND (lower(name)=lower(?) OR id=?)').get(userId, n, n) as any) ?? null;
}

function toolsetsOf(row: any): string[] {
  try { return row?.toolsets ? validToolsets(JSON.parse(row.toolsets)) : []; } catch { return []; }
}

/** A problem with the engine choices, or null. `cwd`/`toolsets` undefined means "not being set". */
function engineProblem(p: { cwd?: unknown; toolsets?: unknown; effort?: unknown }): string | null {
  if (p.cwd !== undefined && p.cwd !== null && p.cwd !== '') {
    const cwd = String(p.cwd).trim();
    if (!path.isAbsolute(cwd)) return 'cwd must be an absolute path.';
    try { if (!fs.statSync(cwd).isDirectory()) return `Not a directory: ${cwd}`; } catch { return `No such directory: ${cwd}. Create it first.`; }
  }
  if (p.toolsets !== undefined && p.toolsets !== null) {
    if (!Array.isArray(p.toolsets) || !p.toolsets.length || p.toolsets.some((t) => typeof t !== 'string')) return `toolsets must be a non-empty list of names. Known: ${KNOWN_TOOLSETS.join(', ')}.`;
    const unknown = (p.toolsets as string[]).filter((t) => !(KNOWN_TOOLSETS as readonly string[]).includes(t.trim()));
    if (unknown.length) return `Unknown toolset(s): ${unknown.join(', ')}. Known: ${KNOWN_TOOLSETS.join(', ')}.`;
  }
  if (p.effort !== undefined && p.effort !== null && !EFFORTS.includes(String(p.effort))) return `effort must be one of ${EFFORTS.join(', ')}.`;
  return null;
}

/**
 * Check a provider/model pair against what the builder's own gateway can reach (bots share the
 * primary agent's providers). A wrong provider or a display name is an error; a model id the
 * provider does not list is only a warning, because the list is a short "featured" set.
 */
async function modelProblem(builderBotId: string, provider: string, model: string): Promise<{ error?: string; warning?: string }> {
  if (!provider || !model) return { error: 'Give both provider and model (real ids, e.g. provider "anthropic", model "claude-sonnet-5").' };
  if (/\s/.test(model) || /[A-Z]/.test(model)) return { error: `"${model}" looks like a display name. Use the model id (lower case, no spaces), e.g. claude-sonnet-5 or qwen3.5:35b.` };
  let providers: { id: string; connected: boolean; models: string[] }[] = [];
  try { providers = (await builderDeps.engineInfo(builderBotId)).providers; } catch { /* checked below */ }
  if (!providers.length) return { warning: 'Could not read the provider list right now; the model id was not checked.' };
  const p = providers.find((x) => x.id === provider);
  if (!p) return { error: `Unknown provider "${provider}". Available: ${providers.map((x) => x.id).join(', ')}.` };
  if (!p.connected) return { error: `Provider "${provider}" is not signed in on this Mac. Connected: ${providers.filter((x) => x.connected).map((x) => x.id).join(', ') || 'none'}.` };
  if (!p.models.includes(model)) return { warning: `"${model}" is not in ${provider}'s suggested list (${p.models.join(', ') || 'empty'}). Saved anyway; only a real reply from the bot proves it works.` };
  return {};
}

/** What the person has to see before a build tool goes ahead. */
function originProblem(ctx: ToolCtx): string | null {
  if (ctx.origin === 'user') return null;
  return `This tool only works in a turn the owner started in your own chat (this turn was started by: ${ctx.origin ?? 'nothing the app knows of'}). Tell whoever asked that bots are built by talking to you directly.`;
}

async function waitReady(botId: string): Promise<{ status: string; error: string | null }> {
  const until = Date.now() + builderDeps.readyTimeoutMs;
  let last = { status: 'starting', error: null as string | null };
  for (;;) {
    try {
      const e = await builderDeps.engineInfo(botId);
      last = { status: e.status, error: e.error };
      if (e.status === 'ready' || e.status === 'error') return last;
    } catch (e: any) { last = { status: 'error', error: String(e?.message ?? e) }; }
    if (Date.now() >= until) return last;
    await sleep(builderDeps.pollMs);
  }
}

function describe(row: any, full: boolean) {
  return {
    id: row.id, name: row.name, label: row.label, description: row.description,
    primary: !!row.is_primary || row.engine === 'primary',
    provider: row.provider ?? null, model: row.model ?? null, effort: row.effort ?? 'medium',
    toolsets: toolsetsOf(row).length ? toolsetsOf(row) : '(default)', cwd: row.cwd ?? '(its own workspace)',
    voice: row.voice, engine: row.engine, port: row.engine_port ?? null, home: builderDeps.engineHome(row.id),
    created_by: row.created_by ?? null, created_at: new Date(row.created_at).toISOString(),
    ...(full ? { instructions: row.instructions ?? '' } : { instructions_chars: (row.instructions ?? '').length }),
  };
}

export const BUILDER_TOOLS: ToolDef[] = [
  {
    name: 'describe_bots',
    description: "Read how the team's bots are set up: model, provider, effort, toolsets, working directory, voice, Hermes home. Give bot_name for one bot including its full instructions; leave it out for a summary of all. Read-only.",
    parameters: obj({ bot_name: { type: 'string' } }),
    activity: 'working',
    label: 'Reading bot setups',
    builder: 'read',
    impl: async (a, ctx) => {
      if (a.bot_name) {
        const b = botByName(ctx.userId, a.bot_name);
        return b ? { output: JSON.stringify(describe(b, true)) } : fail(`No bot named "${a.bot_name}".`);
      }
      const rows = db.prepare("SELECT * FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at").all(ctx.userId) as any[];
      return { output: JSON.stringify({ bots: rows.map((r) => describe(r, false)), known_toolsets: KNOWN_TOOLSETS, efforts: EFFORTS, avatar_colors: COLORS, avatar_shapes: SHAPES }) };
    },
  },
  {
    name: 'create_bot',
    description: 'Create a new bot on the team from an approved spec. Shows the owner an approval card and waits for their answer, then creates the bot, starts its agent and waits until it is ready. Only works in a turn the owner started in your chat. Give real ids for provider and model. After it returns, the bot still has to pass its smoke test.',
    parameters: obj({
      name: { type: 'string' },
      label: { type: 'string', description: 'Short role, e.g. "Research analyst".' },
      description: { type: 'string', description: 'One or two sentences on what the bot is for.' },
      instructions: { type: 'string', description: 'Standing rules the bot gets on every turn.' },
      provider: { type: 'string', description: 'Provider id, e.g. anthropic, ollama.' },
      model: { type: 'string', description: 'Model id, e.g. claude-sonnet-5, qwen3.5:35b.' },
      effort: { type: 'string', enum: EFFORTS },
      toolsets: { type: 'array', items: { type: 'string' }, description: 'Tool allowlist; see describe_bots for known names.' },
      cwd: { type: 'string', description: "Absolute path of an existing working directory. Leave out for the bot's own workspace folder." },
      voice: { type: 'string', description: 'A local voice name; leave out for the default.' },
      avatar_color: { type: 'string' },
      avatar_shape: { type: 'string' },
    }, ['name', 'label', 'description', 'instructions', 'provider', 'model', 'toolsets']),
    activity: 'working',
    label: 'Building a bot',
    builder: 'write',
    impl: async (a, ctx) => {
      const blocked = originProblem(ctx);
      if (blocked) return fail(blocked);
      const name = str(a.name, 60);
      if (!name) return fail('Give the bot a name.');
      if (botByName(ctx.userId, name)) return fail(`There is already a bot named "${name}". Pick another name, or use configure_bot_engine to change that one.`);
      const instructions = str(a.instructions, 20_000);
      if (!str(a.label, 80) || !str(a.description, 600) || !instructions) return fail('label, description and instructions are all required; the spec is not complete without them.');
      const provider = str(a.provider, 120);
      const model = str(a.model, 120);
      const bad = engineProblem({ cwd: a.cwd, toolsets: a.toolsets, effort: a.effort });
      if (bad) return fail(bad);
      const m = await modelProblem(ctx.botId, provider, model);
      if (m.error) return fail(m.error);
      const toolsets = validToolsets(a.toolsets);
      const cwd = str(a.cwd, 400) ? path.resolve(str(a.cwd, 400)) : null;

      const answer = await ctx.approve(`create the bot "${name}"`, {
        name, role: str(a.label, 80), model: `${provider} / ${model}${a.effort ? ` (${a.effort})` : ''}`,
        tools: toolsets.join(', '), folder: cwd ?? "the bot's own workspace", voice: str(a.voice, 60) || 'default',
      });
      if (answer !== 'allow') return fail(answer === 'deny' ? 'The owner declined. Nothing was created. Ask what should change in the spec; do not retry as is.' : 'The owner did not answer the approval card. Nothing was created.');

      const bot = builderDeps.createBot(ctx.userId, {
        name, label: str(a.label, 80), description: str(a.description, 600), instructions,
        avatarColor: str(a.avatar_color, 20), avatarShape: str(a.avatar_shape, 20),
      }, { provider, model, toolsets, cwd, voice: str(a.voice, 60) || null, effort: a.effort ?? null, createdBy: ctx.botId });
      const ready = await waitReady(bot.id);
      const row = db.prepare('SELECT * FROM bots WHERE id=?').get(bot.id) as any;
      return {
        output: JSON.stringify({
          ok: true, bot: row ? describe(row, false) : { id: bot.id, name }, engine_status: ready.status, engine_error: ready.error,
          ...(m.warning ? { model_warning: m.warning } : {}),
          next: 'Engine status is not proof. Seed its skills, then run the smoke test from the spec with ask_bot and check the result before reporting.',
        }),
        summary: `Created ${name}`,
      };
    },
  },
  {
    name: 'configure_bot_engine',
    description: "Change an existing bot's setup: provider, model, effort, toolsets, working directory, instructions, label, description or voice. Only the fields you pass change. Shows the owner a before/after approval card first, except while finishing a bot you created in the last two hours. Changing toolsets or cwd restarts that bot's agent. Never works on the main bot or on yourself, and only in a turn the owner started in your chat.",
    parameters: obj({
      bot_name: { type: 'string' },
      provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string', enum: EFFORTS },
      toolsets: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' },
      instructions: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, voice: { type: 'string' },
    }, ['bot_name']),
    activity: 'working',
    label: 'Changing a bot',
    builder: 'write',
    impl: async (a, ctx) => {
      const blocked = originProblem(ctx);
      if (blocked) return fail(blocked);
      const t = botByName(ctx.userId, a.bot_name);
      if (!t || t.kind === 'room') return fail(`No bot named "${a.bot_name}".`);
      if (t.id === ctx.botId) return fail('You cannot change your own setup.');
      if (t.is_primary || t.engine !== 'managed') return fail(`${t.name} is the main bot; its agent is off-limits to you. Tell the owner what you would change instead.`);
      const bad = engineProblem({ cwd: a.cwd, toolsets: a.toolsets, effort: a.effort });
      if (bad) return fail(bad);

      const next: Record<string, any> = {};
      const diff: Record<string, string> = {};
      const short = (v: unknown) => { const s = String(v ?? '') || '(none)'; return s.length > 60 ? `${s.slice(0, 57)}...` : s; };
      const text = (key: string, col: string, max: number) => {
        if (typeof a[key] !== 'string') return;
        const v = str(a[key], max);
        if (v !== (t[col] ?? '')) { next[col] = v; diff[key] = key === 'instructions' ? `${(t[col] ?? '').length} chars -> ${v.length} chars` : `${short(t[col])} -> ${short(v)}`; }
      };
      text('provider', 'provider', 120); text('model', 'model', 120); text('effort', 'effort', 20);
      text('instructions', 'instructions', 20_000); text('label', 'label', 80); text('description', 'description', 600); text('voice', 'voice', 60);
      let warning: string | undefined;
      if (next.provider !== undefined || next.model !== undefined) {
        const m = await modelProblem(ctx.botId, next.provider ?? t.provider ?? '', next.model ?? t.model ?? '');
        if (m.error) return fail(m.error);
        warning = m.warning;
      }
      const engine: { cwd?: string | null; toolsets?: string[] | null } = {};
      if (Array.isArray(a.toolsets)) {
        const want = validToolsets(a.toolsets);
        if (JSON.stringify(want) !== JSON.stringify(toolsetsOf(t))) { engine.toolsets = want; diff.tools = `${toolsetsOf(t).join(', ') || '(default)'} -> ${want.join(', ')}`; }
      }
      if (typeof a.cwd === 'string' && str(a.cwd, 400)) {
        const want = path.resolve(str(a.cwd, 400));
        if (want !== (t.cwd ?? '')) { engine.cwd = want; diff.folder = `${t.cwd ?? '(own workspace)'} -> ${want}`; }
      }
      if (!Object.keys(diff).length) return { output: JSON.stringify({ ok: true, changed: [], note: 'Nothing to change; the bot already has these values.' }) };
      const restarts = engine.cwd !== undefined || engine.toolsets !== undefined;
      if (restarts && ctx.isBusy(t.id)) return fail(`${t.name} is in the middle of a turn, and this change restarts its agent. Try again when it is idle.`);

      const fresh = t.created_by === ctx.botId && now() - t.created_at < FRESH_MS;
      if (!fresh) {
        const answer = await ctx.approve(`change ${t.name}'s setup${restarts ? ' (restarts it)' : ''}`, diff);
        if (answer !== 'allow') return fail(answer === 'deny' ? 'The owner declined. Nothing was changed.' : 'The owner did not answer the approval card. Nothing was changed.');
      }
      for (const [col, v] of Object.entries(next)) db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(v, now(), t.id);
      if (next.label !== undefined || next.description !== undefined) { try { builderDeps.syncPersona(t.id); } catch { /* the persona file is a nicety */ } }
      let status: { status: string; error: string | null } | null = null;
      if (restarts) {
        await builderDeps.updateEngineSettings(t.id, engine);
        forgetEngineOptions(t.id);
        status = await waitReady(t.id);
      }
      emitBot(t.id);
      hub.emit(ctx.userId, { type: 'roster' });
      return {
        output: JSON.stringify({ ok: true, bot: t.name, changed: diff, approved_by: fresh ? 'covered by the create_bot approval (fresh build)' : 'owner, on the approval card', ...(status ? { engine_status: status.status, engine_error: status.error } : {}), ...(warning ? { model_warning: warning } : {}) }),
        summary: `Changed ${t.name}: ${Object.keys(diff).join(', ')}`,
      };
    },
  },
  {
    name: 'seed_bot_skill',
    description: "Copy a skill (a directory with SKILL.md) into another bot's Hermes home so that bot can load it. `skill` is the directory name, looked up in the owner's skills and then in your own. Asks the owner first unless you created the target in the last two hours. An existing copy is kept unless overwrite is true. Only in a turn the owner started in your chat; never on the main bot.",
    parameters: obj({ bot_name: { type: 'string' }, skill: { type: 'string' }, overwrite: { type: 'boolean' } }, ['bot_name', 'skill']),
    activity: 'working',
    label: 'Giving a bot a skill',
    builder: 'write',
    impl: async (a, ctx) => {
      const blocked = originProblem(ctx);
      if (blocked) return fail(blocked);
      const t = botByName(ctx.userId, a.bot_name);
      if (!t || t.kind === 'room') return fail(`No bot named "${a.bot_name}".`);
      if (t.is_primary || t.engine !== 'managed') return fail(`${t.name} is the main bot; its home is off-limits to you.`);
      const skill = String(a.skill ?? '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skill)) return fail('skill must be a skill directory name: lower-case letters, digits, hyphens or underscores.');
      const src = findSkill(builderDeps.skillRoots(ctx.botId), skill);
      if (!src) return fail(`No skill directory "${skill}" with a SKILL.md was found. Create it in your own skills first, or check the name.`);
      const home = builderDeps.engineHome(t.id);
      if (!home) return fail(`${t.name} has no Hermes home.`);
      const dest = path.join(home, 'skills', skill);
      const exists = fs.existsSync(dest) || !!findSkill([path.join(home, 'skills')], skill);
      if (exists && !a.overwrite) return { output: JSON.stringify({ ok: true, already_there: true, note: `${t.name} already has "${skill}". Pass overwrite=true to replace it.` }), summary: `${t.name} already has ${skill}` };
      const fresh = t.created_by === ctx.botId && now() - t.created_at < FRESH_MS;
      if (!fresh) {
        const answer = await ctx.approve(`give ${t.name} the skill "${skill}"`, { bot: t.name, skill, from: src, ...(exists ? { note: 'replaces the copy it has' } : {}) });
        if (answer !== 'allow') return fail(answer === 'deny' ? 'The owner declined. Nothing was copied.' : 'The owner did not answer the approval card. Nothing was copied.');
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Replace, never merge: copying onto an existing directory would leave stale files behind.
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
      return { output: JSON.stringify({ ok: true, bot: t.name, skill, from: src, to: dest, files: countFiles(dest) }), summary: `Gave ${t.name} the skill ${skill}` };
    },
  },
];

/** The directory named `skill` that holds a SKILL.md, at the root or one or two category levels down. */
function findSkill(roots: string[], skill: string): string | null {
  const ok = (dir: string) => { try { return fs.statSync(path.join(dir, 'SKILL.md')).isFile(); } catch { return false; } };
  const dirs = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => path.join(dir, d.name)); } catch { return []; } };
  for (const root of roots) {
    if (ok(path.join(root, skill))) return path.join(root, skill);
    for (const cat of dirs(root)) {
      if (ok(path.join(cat, skill))) return path.join(cat, skill);
      for (const sub of dirs(cat)) if (ok(path.join(sub, skill))) return path.join(sub, skill);
    }
  }
  return null;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) n += d.isDirectory() ? countFiles(path.join(dir, d.name)) : 1;
  return n;
}
