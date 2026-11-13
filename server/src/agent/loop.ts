import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow, emitBot, getBotRow, getLive, getRow, setLive, updateRow } from '../store.js';
import type { ActivityKind, MessageBody, ToolCallBody } from '../types.js';
import { toolkitInfo } from '../composio.js';
import { engineFor } from '../engine.js';
import { instructionsFor } from './prompt.js';
import { activityFor, appToolName, humanizeSlug, policyFor } from './tools.js';

/**
 * A turn: one message handed to the bot's Hermes engine and streamed back into the conversation.
 *
 * Hermes owns the agent loop, the history and the tools. This file only
 *  - queues turns so a bot handles one at a time,
 *  - posts the trigger to the engine's /v1/responses endpoint and turns the event stream into
 *    rows (assistant messages, tool calls) and live state (what the bot is doing right now),
 *  - keeps the bookkeeping the app's own tools need while a turn runs (see mcp.ts): which tool-call
 *    row a call belongs to, and approvals the user has to answer before a call goes ahead.
 */

export type Trigger =
  | { type: 'user'; text: string }
  | { type: 'routine'; routineId: string; name: string; prompt: string }
  | { type: 'bot'; fromBotId: string; fromName: string; text: string; depth: number }
  /**
   * Another bot asked this one something with ask_bot. The turn's final reply goes back to the asker:
   * as the tool result while it waits (`wait`), or, once it stopped waiting, posted into its
   * conversation by deliverAsk (then `taskId` is the task that tracks the request on this bot).
   */
  | { type: 'ask'; askId: string; fromBotId: string; fromName: string; text: string; depth: number; wait: boolean; taskId?: string }
  | { type: 'system'; text: string };

/** Pieces of the turn the app's own tools may swap out in tests (no engine, no screen). */
export const loopDeps = { engineFor };

/**
 * Hooks other modules push in (telegram.ts imports this file, so it cannot be imported here).
 * `afterRoutine` runs once a routine-triggered turn ended successfully, with everything the bot wrote.
 */
export const turnHooks: { afterRoutine?: (botId: string, routineName: string, text: string) => void } = {};

// ---------- per-bot serial queue ----------

const queues = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();

export function enqueue(botId: string, trigger: Trigger) {
  // A new message from the user supersedes whatever is waiting for their approval.
  if (trigger.type === 'user') expireApprovals(botId);
  const prev = queues.get(botId) ?? Promise.resolve();
  // runTurn reports its own failures in the conversation and the log.
  const next = prev.then(() => runTurn(botId, trigger)).then(() => {}, () => {});
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
}

/**
 * Like enqueue, but resolves with what the bot wrote during the turn (every message it posted,
 * joined by blank lines) and rejects when the turn failed or was stopped.
 */
export function enqueueAndWait(botId: string, trigger: Trigger): Promise<string> {
  const prev = queues.get(botId) ?? Promise.resolve();
  const result = prev.then(() => runTurn(botId, trigger));
  const next = result.then(() => {}, () => {});
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
  return result;
}

export function interrupt(botId: string) {
  expireApprovals(botId);
  aborts.get(botId)?.abort();
}

/** Run a job in the bot's serial queue, after any running turn. */
export function runInBotQueue<T>(botId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(botId) ?? Promise.resolve();
  const result = prev.then(job);
  const next = result.then(() => {}, () => {});
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
  return result;
}

export const isBotBusy = (botId: string) => queues.has(botId);

// ---------- ask_bot: one bot asks another and gets the answer back ----------

/** Longest ask_bot waits for the answer in the tool call. Kept under the engines' 30 minute tool timeout. Tests shorten it. */
export const askSettings = { waitMs: 15 * 60_000 };

/** Which bot each waiting asker is waiting on; a chain that leads back to the asker would deadlock the queues. */
const waitingOn = new Map<string, string>();

function wouldDeadlock(fromBotId: string, toBotId: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | undefined = toBotId; cur && !seen.has(cur); cur = waitingOn.get(cur)) {
    if (cur === fromBotId) return true;
    seen.add(cur);
  }
  return false;
}

function createAskTask(targetId: string, userId: string, request: string): string {
  const id = newId('task');
  db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES (?,?,?,'working',?,?)").run(id, targetId, request.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Request from another bot', now(), now());
  hub.emit(userId, { type: 'tasks', botId: targetId });
  return id;
}

export interface AskOutcome { output: string; summary: string }

/**
 * Post `request` into the target's conversation as a message from the asker and run its turn at
 * hop `depth` (the asker's depth + 1).
 * `wait`: block until the turn ends and hand back what the target wrote. Otherwise (or once the wait
 * runs out) the target's reply is delivered into the asker's conversation by deliverAsk when the
 * turn ends, tracked as a task on the target meanwhile.
 */
export async function askBot(fromBotId: string, toBotId: string, request: string, wait: boolean, depth: number): Promise<AskOutcome> {
  const from = getBotRow(fromBotId);
  const to = getBotRow(toBotId);
  const trigger: Trigger & { type: 'ask' } = { type: 'ask', askId: newId('ask'), fromBotId, fromName: from.name, text: request, depth, wait };
  appendRow(toBotId, 'message', { type: 'message', role: 'user', text: request, from: { kind: 'bot', id: fromBotId, name: from.name } });

  const later = (why: string) => {
    trigger.wait = false;
    trigger.taskId = createAskTask(toBotId, to.user_id, request);
    return {
      output: JSON.stringify({ task_id: trigger.taskId, status: 'working', message: `${why} ${to.name} will post the result into this chat as a message when it is done; do not poll or ask again. Carry on with other work or end your turn.` }),
      summary: `Asked ${to.name} (task)`,
    };
  };

  if (!wait || wouldDeadlock(fromBotId, toBotId)) {
    const r = later(wait ? `${to.name} is waiting on you right now, so this request was queued instead.` : `Asked ${to.name}.`);
    enqueue(toBotId, trigger);
    return r;
  }

  const turn = enqueueAndWait(toBotId, trigger);
  let settled: { text: string } | { error: string } | null = null;
  const done = turn.then((text) => (settled = { text }), (e) => (settled = { error: String(e?.message ?? e) }));
  let timer: NodeJS.Timeout | undefined;
  waitingOn.set(fromBotId, toBotId);
  try {
    await Promise.race([done, new Promise<void>((r) => { timer = setTimeout(r, askSettings.waitMs); })]);
  } finally {
    clearTimeout(timer);
    waitingOn.delete(fromBotId);
  }
  if (!settled) return later(`${to.name} has not finished after ${Math.max(1, Math.round(askSettings.waitMs / 60_000))} minutes.`);
  const result = settled as { text: string } | { error: string };
  if ('error' in result) return { output: `${to.name} could not answer: ${result.error}`, summary: `${to.name} did not answer` };
  return { output: result.text.trim() || `${to.name} finished without writing a reply.`, summary: `${to.name} answered` };
}

/** An 'ask' turn nobody is waiting on any more has ended: hand its reply to the asker. */
function deliverAsk(targetId: string, trigger: Trigger & { type: 'ask' }, text: string, failure: string | null) {
  const target = getBotRow(targetId);
  const caller = getBotRow(trigger.fromBotId);
  if (!target || !caller) return;
  const reply = text.trim() || (failure ? `${target.name} could not finish this: ${failure}` : `${target.name} finished without writing a reply.`);
  appendRow(caller.id, 'message', { type: 'message', role: 'assistant', text: reply, from: { kind: 'bot', id: target.id, name: target.name } });
  if (trigger.taskId) db.prepare("UPDATE tasks SET state='done', note=?, updated_at=? WHERE id=?").run(reply.slice(0, 2000), now(), trigger.taskId);
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(caller.id);
  hub.emit(caller.user_id, { type: 'tasks', botId: target.id });
  emitBot(caller.id);
  enqueue(caller.id, { type: 'bot', fromBotId: target.id, fromName: target.name, text: reply, depth: trigger.depth });
}

function triggerText(t: Trigger): string {
  switch (t.type) {
    case 'user': return t.text;
    case 'routine': return `[Routine "${t.name}" is running now. Do this:]\n${t.prompt}`;
    case 'bot': return `[Message from ${t.fromName}, another Bot on the team. If it answers something you asked, carry on with your work. If they need something from you, use ask_bot.]\n${t.text}`;
    case 'ask': return `[${t.fromName}, another Bot on the team, is asking you this. Whatever you write as your final reply in this turn is delivered to ${t.fromName} automatically when you finish. Do not call ask_bot to answer them (use it only to ask someone a genuinely new question), and do not call stay_silent: do the work, then write the answer.]\n${t.text}`;
    case 'system': return `[System notice] ${t.text}`;
  }
}

// ---------- the running turn, as the app's tools see it ----------

interface ToolRef { seq: number; callId: string; name: string; claimed: boolean; done: boolean }
interface Outcome { status?: ToolCallBody['status']; summary?: string }

interface Turn {
  botId: string;
  userId: string;
  /** How many bot-to-bot hops led here (ask_bot stops a ping-pong at 3). */
  depth: number;
  /** What started this turn: the person ('user'), a routine, another bot ('bot'/'ask') or the app ('system'). */
  origin: Trigger['type'];
  /** A tool ended the conversation for now (asked the user, stayed silent): drop any closing text. */
  silent: boolean;
  tools: ToolRef[];
  /** What an app tool said about its own call; beats what we would guess from the raw output. */
  outcomes: Map<number, Outcome>;
}

const turns = new Map<string, Turn>();

export const turnDepth = (botId: string) => turns.get(botId)?.depth ?? 0;

/** What started the bot's running turn, or null when no turn of ours is running. */
export const turnOrigin = (botId: string): Trigger['type'] | null => turns.get(botId)?.origin ?? null;

export function markSilent(botId: string) {
  const t = turns.get(botId);
  if (t) t.silent = true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An app tool was called through MCP: find the tool-call row the event stream made for it.
 * The stream announces a call just before the engine runs it, so wait a moment for the row.
 * Returns null when the call did not come from a turn started here (e.g. the agent used the tool
 * while talking to its owner somewhere else).
 */
export async function claimToolRow(botId: string, name: string): Promise<number | null> {
  const deadline = Date.now() + 600;
  for (;;) {
    const t = turns.get(botId);
    if (!t) return null;
    const ref = t.tools.find((r) => !r.claimed && !r.done && r.name === name);
    if (ref) { ref.claimed = true; return ref.seq; }
    if (Date.now() > deadline) return null;
    await sleep(40);
  }
}

export function noteToolOutcome(botId: string, seq: number | null, outcome: Outcome) {
  if (seq === null) return;
  turns.get(botId)?.outcomes.set(seq, outcome);
  patchToolRow(botId, seq, outcome);
}

function patchToolRow(botId: string, seq: number, patch: Partial<ToolCallBody>) {
  const row = getRow(botId, seq);
  if (row && row.body.type === 'tool-call') updateRow(botId, seq, { ...row.body, ...patch });
}

// ---------- approvals ----------

export type ApprovalDecision = 'allow' | 'deny' | 'expired';

/** Longest a tool call waits for the user. Kept under the engines' 30 minute tool timeout. */
const APPROVAL_WAIT_MS = 25 * 60_000;

const waiters = new Map<string, { botId: string; resolve: (d: ApprovalDecision) => void }>();

function setApprovalCard(botId: string, rowSeq: number, approvalId: string, status: string) {
  const card = getRow(botId, rowSeq);
  if (card && card.body.type === 'card' && card.body.card === 'approval' && card.body.approvalId === approvalId) {
    updateRow(botId, rowSeq, { ...card.body, status } as any);
  }
}

const pendingApprovals = (botId: string) => db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending'").all(botId) as any[];

/** Put an approval card in the conversation and wait for the user's answer. */
export async function requestApproval(
  who: { userId: string; botId: string },
  pol: { key: string; toolkit?: string; title: string },
  args: any,
  rowSeq: number | null,
): Promise<ApprovalDecision> {
  const { userId, botId } = who;
  const approvalId = newId('apr');
  const tk = pol.toolkit ? await toolkitInfo(pol.toolkit).catch(() => undefined) : undefined;
  const card = appendRow(botId, 'card', {
    type: 'card', card: 'approval', approvalId, title: `Allow ${getBotRow(botId).name} to ${pol.title.split(': ')[1] ?? pol.title}?`,
    detail: describeArgs(args), tool: pol.key, toolkit: pol.toolkit, toolkitName: tk?.name, logo: tk?.logo, args, status: 'pending',
  });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)').run(approvalId, botId, card.seq, '', pol.key, 'pending', now());
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
  if (rowSeq !== null) patchToolRow(botId, rowSeq, { status: 'awaiting-approval' });
  setLive(botId, { isRunning: false, activity: { kind: 'waiting_for_you', since: now() }, awaiting: { reason: humanizeSlug(pol.key), since: now() } });
  hub.emit(userId, { type: 'tasks', botId });
  emitBot(botId);

  let timer: NodeJS.Timeout | undefined;
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    waiters.set(approvalId, { botId, resolve });
    timer = setTimeout(() => expireApproval(approvalId), APPROVAL_WAIT_MS);
  });
  clearTimeout(timer);
  waiters.delete(approvalId);

  if (rowSeq !== null) {
    if (decision === 'allow') patchToolRow(botId, rowSeq, { status: 'running' });
    else noteToolOutcome(botId, rowSeq, { status: 'denied', summary: decision === 'deny' ? 'Not allowed' : 'Skipped' });
  }
  if (!pendingApprovals(botId).length) {
    if (turns.has(botId)) setLive(botId, { isRunning: true, activity: { kind: decision === 'allow' ? 'connecting_service' : 'thinking', detail: decision === 'allow' ? tk?.name : undefined, since: now() }, awaiting: null });
    else setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null });
  }
  hub.emit(userId, { type: 'tasks', botId });
  return decision;
}

function expireApproval(approvalId: string) {
  const ap = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as any;
  if (ap?.status === 'pending') {
    db.prepare("UPDATE approvals SET status='expired', resolved_at=? WHERE id=?").run(now(), approvalId);
    setApprovalCard(ap.bot_id, ap.row_seq, approvalId, 'expired');
  }
  waiters.get(approvalId)?.resolve('expired');
}

export function expireApprovals(botId: string) {
  for (const ap of pendingApprovals(botId)) expireApproval(ap.id);
}

/** After a restart nothing is waiting on old approval cards any more. */
export function expireStaleApprovals() {
  for (const ap of db.prepare("SELECT id FROM approvals WHERE status='pending'").all() as any[]) expireApproval(ap.id);
}

/** Resolve an approval card from the UI. */
export function resolveApproval(userId: string, approvalId: string, decision: 'allow' | 'always' | 'deny') {
  const ap = db.prepare('SELECT a.*, b.user_id FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=?').get(approvalId) as any;
  if (!ap || ap.user_id !== userId) throw new Error('not found');
  if (ap.status !== 'pending') return;
  const waiter = waiters.get(approvalId);
  if (!waiter) return expireApproval(approvalId);
  const status = decision === 'deny' ? 'denied' : decision === 'always' ? 'always' : 'allowed';
  db.prepare('UPDATE approvals SET status=?, resolved_at=? WHERE id=?').run(status, now(), approvalId);
  if (decision === 'always') db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run(userId, ap.tool);
  setApprovalCard(ap.bot_id, ap.row_seq, approvalId, status);
  waiter.resolve(decision === 'deny' ? 'deny' : 'allow');
}

function describeArgs(args: any): string {
  if (!args || typeof args !== 'object') return '';
  const inner = Array.isArray(args.tools) ? args.tools.map((t: any) => t.arguments ?? t.args ?? t) : [args];
  const flat = inner.map((a: any) => Object.entries(a ?? {}).filter(([, v]) => typeof v !== 'object' || v === null).slice(0, 6).map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`).join('\n'));
  return flat.join('\n\n').slice(0, 1200);
}

// ---------- the engine's event stream ----------

interface StreamEvent { type: string; data: any }

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let event = '';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue; // a keepalive comment
      const raw = data.join('\n');
      if (raw === '[DONE]') continue;
      try {
        const json = JSON.parse(raw);
        yield { type: event || json?.type || '', data: json };
      } catch { /* not ours to understand */ }
    }
  }
}

async function failureText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === 'string' && m) return m;
  } catch { /* plain text */ }
  if (res.status === 401 || res.status === 403) return 'the engine did not accept our key';
  return raw.slice(0, 300) || `the engine answered ${res.status}`;
}

/** What a tool's raw result says about how it went. */
function readOutcome(item: any): Outcome {
  const text = Array.isArray(item?.output) ? item.output.map((p: any) => p?.text ?? '').join('') : String(item?.output ?? '');
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      if (j.error) return { status: 'error', summary: String(typeof j.error === 'string' ? j.error : JSON.stringify(j.error)).slice(0, 200) };
      if (typeof j.exit_code === 'number' && j.exit_code !== 0) return { status: 'error', summary: `Exit code ${j.exit_code}` };
      if (j.success === false) return { status: 'error', summary: String(j.message ?? 'Failed').slice(0, 200) };
    }
  } catch { /* not JSON */ }
  if (/^(tool )?error\b/i.test(text.trim())) return { status: 'error', summary: text.trim().slice(0, 200) };
  return { status: 'done' };
}

/** A short line for the "thinking" chip out of the model's running reasoning. */
function captionFrom(reasoning: string): string | null {
  const titles = [...reasoning.matchAll(/\*\*([^*\n]{3,80})\*\*/g)];
  if (titles.length) return titles[titles.length - 1][1].trim();
  const para = reasoning.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).pop();
  if (!para) return null;
  const sentence = para.split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').trim();
  if (sentence.length < 4) return null;
  return sentence.length > 84 ? `${sentence.slice(0, 81).trimEnd()}…` : sentence;
}

// ---------- the turn ----------

/** Hermes' own tool lookup (it loads rarely used tools on demand). */
const TOOLBOX = new Set(['tool_search', 'tool_describe']);

/** Runs one turn; resolves with everything the bot wrote, rejects when the turn failed or was stopped. */
async function runTurn(botId: string, trigger: Trigger): Promise<string> {
  const bot = getBotRow(botId);
  if (!bot || bot.kind === 'room') return '';
  const userId: string = bot.user_id;
  const ctrl = new AbortController();
  aborts.set(botId, ctrl);
  const turn: Turn = { botId, userId, origin: trigger.type, depth: trigger.type === 'bot' || trigger.type === 'ask' ? trigger.depth : 0, silent: false, tools: [], outcomes: new Map() };
  turns.set(botId, turn);
  setLive(botId, { isRunning: true, activity: { kind: 'thinking', since: now() }, awaiting: null, startedAt: now(), caption: null, steps: 0 });

  // Everything the bot said this turn, for whoever asked (ask_bot).
  const spoken: string[] = [];
  // The assistant message being written right now.
  let msgSeq: number | null = null;
  let text = '';
  let lastFlush = 0;
  let wroteText = false;
  const flush = (streaming: boolean) => {
    const b: MessageBody = { type: 'message', role: 'assistant', text, streaming };
    if (msgSeq === null) msgSeq = appendRow(botId, 'message', b).seq;
    else updateRow(botId, msgSeq, b);
    lastFlush = Date.now();
  };
  const closeMessage = () => {
    if (msgSeq === null) return;
    if (text.trim()) {
      flush(false);
      spoken.push(text.trim());
      db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
    } else updateRow(botId, msgSeq, { type: 'message', role: 'assistant', text: '', streaming: false });
    msgSeq = null;
    text = '';
  };
  const say = (t: string) => {
    if (turn.silent || !t.trim()) return;
    closeMessage();
    appendRow(botId, 'message', { type: 'message', role: 'assistant', text: t.trim(), streaming: false });
    spoken.push(t.trim());
    db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
    wroteText = true;
  };

  let reasoning = '';
  let lastCaption = 0;
  const caption = (c: string | null, force = false) => {
    if (!c || c === getLive(botId).caption) return;
    if (!force && Date.now() - lastCaption < 300) return;
    lastCaption = Date.now();
    setLive(botId, { caption: c });
  };
  const outputsSeen = new Set<string>();
  let steps = 0;
  let failure: string | null = null;

  try {
    const engine = await loopDeps.engineFor(botId);
    if (ctrl.signal.aborted) throw new Error('interrupted');

    const input = triggerText(trigger);

    const res = await fetch(`${engine.url}/v1/responses`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) },
      body: JSON.stringify({
        model: bot.model || 'hermes-agent',
        ...(bot.provider ? { provider: bot.provider } : {}),
        input,
        instructions: await instructionsFor(userId, botId),
        // One engine-side thread per conversation; "New chat" bumps the generation and starts another.
        conversation: `hq-${botId}-g${bot.generation}`,
        stream: true,
        store: true,
        model_options: { reasoning_effort: bot.effort ?? 'medium' },
      }),
    });
    if (!res.ok || !res.body) throw new Error(await failureText(res));

    for await (const ev of sseEvents(res.body)) {
      const d = ev.data;
      switch (ev.type) {
        case 'response.output_text.delta': {
          if (turn.silent || typeof d.delta !== 'string') break;
          // Models often open with blank lines; a message never starts with them.
          const piece = text ? d.delta : d.delta.trimStart();
          if (!piece) break;
          text += piece;
          wroteText = true;
          if (msgSeq === null) setLive(botId, { activity: { kind: 'working', since: now() } });
          if (msgSeq === null || Date.now() - lastFlush > 120) flush(true);
          break;
        }

        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          if (typeof d.delta === 'string') {
            reasoning = (reasoning + d.delta).slice(-4000);
            caption(captionFrom(reasoning));
          }
          break;
        }

        case 'hermes.status': {
          if (typeof d?.text === 'string' && d.text.trim()) caption(d.text.trim().slice(0, 84), true);
          break;
        }

        case 'response.output_item.added': {
          const item = d.item;
          if (item?.type === 'reasoning') {
            reasoning = '';
            if (getLive(botId).activity?.kind !== 'thinking') setLive(botId, { activity: { kind: 'thinking', since: now() } });
          }
          if (item?.type === 'function_call') {
            // Text written before this call is its own message; what follows starts a new one.
            closeMessage();
            const { name, ours } = appToolName(String(item.name ?? ''));
            // The agent looking through its own toolbox is not a step worth showing.
            if (!ours && TOOLBOX.has(name)) {
              caption('Finding the right tool', true);
              break;
            }
            let args: any;
            try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments; } catch { args = undefined; }
            const act = activityFor(String(item.name ?? ''), args);
            const row = appendRow(botId, 'tool-call', { type: 'tool-call', callId: String(item.call_id ?? item.id ?? ''), name, label: act.label, status: 'running', args } satisfies ToolCallBody);
            turn.tools.push({ seq: row.seq, callId: String(item.call_id ?? item.id ?? ''), name, claimed: false, done: false });
            steps++;
            const kind: ActivityKind = act.kind;
            const detail = act.detail;
            // A call that is waiting for the user keeps its "waiting for you" state.
            if (!getLive(botId).awaiting) setLive(botId, { isRunning: true, activity: { kind, detail, since: now() }, steps, caption: null });
            else setLive(botId, { steps });
            reasoning = '';
            if (ours && name.startsWith('COMPOSIO_')) {
              const tk = policyFor(userId, name, args ?? {}).toolkit;
              if (tk) {
                void toolkitInfo(tk).then((info) => {
                  const live = getLive(botId);
                  if (info?.name && turns.get(botId) === turn && live.activity?.kind === kind && !live.awaiting) setLive(botId, { activity: { ...live.activity, detail: info.name } });
                }).catch(() => {});
              }
            }
          }
          break;
        }

        case 'response.output_item.done': {
          const item = d.item;
          if (item?.type === 'message') {
            const full = (item.content ?? []).map((c: any) => c?.text ?? '').join('');
            if (item.phase === 'commentary') say(full);
            else if (msgSeq !== null) closeMessage();
            else if (!wroteText) say(full);
          }
          break;
        }

        case 'response.failed':
        case 'error':
          throw new Error(d?.response?.error?.message ?? d?.error?.message ?? d?.message ?? 'the agent run failed');
      }

      // A tool result arrives as an item of its own (announced twice: added and done).
      const item = d?.item;
      if (item?.type === 'function_call_output' && item.call_id && !outputsSeen.has(item.call_id)) {
        outputsSeen.add(item.call_id);
        const ref = turn.tools.find((r) => r.callId === item.call_id);
        if (ref) {
          ref.done = true;
          const told = turn.outcomes.get(ref.seq);
          const guess = readOutcome(item);
          patchToolRow(botId, ref.seq, told?.status && told.status !== 'running' ? told : { status: guess.status, summary: told?.summary ?? guess.summary });
          if (!getLive(botId).awaiting) setLive(botId, { activity: { kind: 'thinking', since: now() } });
        }
      }
    }
  } catch (e: any) {
    const stopped = ctrl.signal.aborted;
    failure = stopped ? 'Stopped' : String(e?.message ?? e);
    closeMessage();
    appendRow(botId, 'notice', { type: 'notice', text: stopped ? 'Stopped.' : `Something went wrong: ${failure}`, tone: stopped ? 'info' : 'error' });
    if (!stopped) console.error('[agent]', botId, e);
  } finally {
    closeMessage();
    for (const ref of turn.tools) {
      if (ref.done) continue;
      const row = getRow(botId, ref.seq);
      if (row?.body.type !== 'tool-call' || (row.body.status !== 'running' && row.body.status !== 'awaiting-approval')) continue;
      patchToolRow(botId, ref.seq, failure ? { status: 'error', summary: ctrl.signal.aborted ? 'Stopped' : 'Did not finish' } : { status: 'done' });
    }
    if (aborts.get(botId) === ctrl) aborts.delete(botId);
    if (turns.get(botId) === turn) turns.delete(botId);
    // An approval asked for outside this turn may still be waiting; leave its state alone.
    if (!pendingApprovals(botId).length) setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null, caption: null });
    else setLive(botId, { isRunning: false, caption: null });
    emitBot(botId);
    // The asker stopped waiting (or never did): the reply goes into its conversation instead.
    if (trigger.type === 'ask' && !trigger.wait) {
      try { deliverAsk(botId, trigger, spoken.join('\n\n'), failure); } catch (e) { console.error('[agent] could not deliver reply to', trigger.fromBotId, e); }
    }
  }
  if (failure) throw new Error(failure);
  const written = spoken.join('\n\n');
  if (trigger.type === 'routine') {
    try { turnHooks.afterRoutine?.(botId, trigger.name, written); } catch (e) { console.error('[agent] afterRoutine hook failed', e); }
  }
  return written;
}
