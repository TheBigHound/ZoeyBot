import { db } from './db.js';
import { appendRow, getBotRow } from './store.js';
import { enqueueAndWait, turnHooks } from './agent/loop.js';
import { primaryBotId } from './engine.js';

/**
 * Telegram as a ZoeyBot channel. Not the engine's own Telegram platform: everything here writes
 * into the bots' canonical rows and goes through the same turn queue as the web composer.
 *
 *  - Inbound: text from an allowlisted chat is posted to Zoey (the primary bot) as a user message
 *    and the reply of that turn is sent back to the same chat. Every other chat is ignored silently.
 *  - Outbound: when a routine turn of any bot ends with a reply whose first line starts with URGENT,
 *    the reply is forwarded to every allowlisted chat (TELEGRAM_NOTIFICATIONS=0 switches this off).
 *
 * The bot token is read from env at call time and never logged; error logs carry only a status or
 * an error name, never the request URL (which contains the token).
 */

const API = 'https://api.telegram.org';
/** Telegram caps a message at 4096 chars; stay under it so an ellipsis or a counter never tips it over. */
export const TELEGRAM_CHUNK = 4000;
const SEND_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_SEC = 25;
const OFFSET_KEY = 'telegram.offset';

export interface TelegramConfig {
  token: string;
  allowedChatIds: string[];
  notifications: boolean;
}

export function telegramConfig(): TelegramConfig {
  return {
    token: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    notifications: process.env.TELEGRAM_NOTIFICATIONS !== '0',
  };
}

/** Pieces tests swap out (no network, fake bots). Same pattern as loopDeps. */
export const telegramDeps = {
  fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
  enqueueAndWait,
  appendRow,
  primaryBotId,
  getBotRow,
  /** Long-poll length and error backoff; tests shorten them. */
  pollTimeoutSec: POLL_TIMEOUT_SEC,
  backoffMinMs: 1000,
  backoffMaxMs: 30_000,
};

/** Counters for the status surface and tests; message contents are never kept. */
export const telegramStats = { handled: 0, ignored: 0, sent: 0, errors: 0 };

// ---------- offset persistence ----------

let kvReady = false;
function kv() {
  if (!kvReady) {
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
    kvReady = true;
  }
  return {
    get: (key: string) => (db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value?: string } | undefined)?.value,
    set: (key: string, value: string) => db.prepare('INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value),
  };
}

export function readTelegramOffset(): number | null {
  const v = kv().get(OFFSET_KEY);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

function writeTelegramOffset(offset: number) {
  kv().set(OFFSET_KEY, String(offset));
}

// ---------- sending ----------

async function callApi(token: string, method: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuter = () => ctrl.abort();
  signal?.addEventListener('abort', onOuter, { once: true });
  try {
    return await telegramDeps.fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
}

export function chunkText(text: string, size = TELEGRAM_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    // Prefer breaking at a line end in the second half of the window.
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/** Plain-text sendMessage, chunked. Resolves true when every chunk was accepted; failures are logged without the token. */
export async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  const { token } = telegramConfig();
  if (!token) return false;
  const body = text.trim() ? text : '(empty)';
  let ok = true;
  for (const chunk of chunkText(body)) {
    try {
      const res = await callApi(token, 'sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true }, SEND_TIMEOUT_MS);
      if (!res.ok) {
        ok = false;
        telegramStats.errors++;
        console.warn(`[telegram] send failed ${res.status}`);
      } else telegramStats.sent++;
    } catch (e: any) {
      ok = false;
      telegramStats.errors++;
      // Only the error's name: its message may carry the request URL, which contains the token.
      console.warn(`[telegram] send failed ${e?.name ?? 'error'}`);
    }
  }
  return ok;
}

// ---------- URGENT forwarding ----------

/** True when the first non-empty line starts with the word URGENT (markdown or punctuation before it allowed). */
export function isUrgent(text: string): boolean {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return !!first && /^\W*URGENT\b/i.test(first);
}

/** A routine turn ended: forward the reply to every allowlisted chat when it is flagged urgent. */
export async function notifyUrgent(botId: string, routineName: string, reply: string): Promise<void> {
  const cfg = telegramConfig();
  if (!cfg.token || !cfg.notifications || !cfg.allowedChatIds.length) return;
  if (!isUrgent(reply)) return;
  const name = telegramDeps.getBotRow(botId)?.name ?? botId;
  const header = `⚠️ ${name} · ${routineName}\n`;
  const room = TELEGRAM_CHUNK - header.length;
  const body = reply.length > room ? `${reply.slice(0, room - 1).trimEnd()}…` : reply;
  const sent = await Promise.all(cfg.allowedChatIds.map((chat) => sendTelegram(chat, header + body)));
  console.log(`[telegram] urgent alert from ${name} (${routineName}): delivered to ${sent.filter(Boolean).length}/${sent.length} chat(s)`);
}

let hooksInstalled = false;
/** Register the URGENT forwarder with the turn loop. loop.ts must not import this module (cycle), so it is pushed in. */
export function installTelegramHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  turnHooks.afterRoutine = (botId, name, text) => { void notifyUrgent(botId, name, text).catch(() => {}); };
}

// ---------- inbound polling ----------

interface TgMessage { message_id?: number; text?: string; chat?: { id?: number | string } }
interface TgUpdate { update_id: number; message?: TgMessage }

let pollCtrl: AbortController | null = null;
let pollLoop: Promise<void> | null = null;

export const isTelegramPolling = () => pollLoop !== null;

async function handleMessage(msg: TgMessage, allow: Set<string>) {
  if (typeof msg.text !== 'string' || msg.chat?.id === undefined || msg.chat.id === null) return;
  const chatId = String(msg.chat.id);
  if (!allow.has(chatId)) { telegramStats.ignored++; return; }
  const text = msg.text.trim();
  if (!text) return;
  telegramStats.handled++;
  if (/^\/start(@\w+)?$/.test(text)) {
    await sendTelegram(chatId, 'Connected to ZoeyBot. Messages here go to Zoey.');
    return;
  }
  const primary = telegramDeps.primaryBotId();
  if (!primary) { await sendTelegram(chatId, 'Zoey is not set up yet.'); return; }
  try {
    telegramDeps.appendRow(primary, 'message', { type: 'message', role: 'user', text, via: 'telegram' });
    const reply = await telegramDeps.enqueueAndWait(primary, { type: 'user', text });
    await sendTelegram(chatId, reply?.trim() || 'Zoey finished without a written reply.');
  } catch (e: any) {
    await sendTelegram(chatId, `Zoey hit an error: ${String(e?.message ?? e)}`);
  }
}

async function getMeUsername(token: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const res = await callApi(token, 'getMe', {}, 5000, signal);
    if (!res.ok) return undefined;
    const j = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return j.ok && typeof j.result?.username === 'string' ? j.result.username : undefined;
  } catch { return undefined; }
}

async function pollForever(signal: AbortSignal) {
  let backoff = telegramDeps.backoffMinMs;
  let offset = readTelegramOffset();
  while (!signal.aborted) {
    const cfg = telegramConfig();
    if (!cfg.token) return;
    const allow = new Set(cfg.allowedChatIds);
    try {
      const res = await callApi(cfg.token, 'getUpdates', {
        timeout: telegramDeps.pollTimeoutSec,
        allowed_updates: ['message'],
        ...(offset !== null ? { offset } : {}),
      }, (telegramDeps.pollTimeoutSec + 10) * 1000, signal);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const j = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
      if (!j.ok || !Array.isArray(j.result)) throw new Error('bad body');
      backoff = telegramDeps.backoffMinMs;
      const updates = j.result.filter((u) => typeof u?.update_id === 'number').sort((a, b) => a.update_id - b.update_id);
      if (!updates.length) continue;
      // Confirm the whole batch first so a crash while a turn runs never replays the same message forever.
      offset = updates[updates.length - 1].update_id + 1;
      writeTelegramOffset(offset);
      for (const u of updates) {
        if (signal.aborted) return;
        if (u.message) await handleMessage(u.message, allow);
      }
    } catch (e: any) {
      if (signal.aborted) return;
      console.warn(`[telegram] poll failed (${e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e).slice(0, 80)}); retrying in ${backoff}ms`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, backoff);
        signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
      backoff = Math.min(telegramDeps.backoffMaxMs, backoff * 2);
    }
  }
}

/** Start long-polling getUpdates when a token is configured. Returns the loop's promise (resolves after stopTelegramPolling). */
export function startTelegramPolling(deps: Partial<typeof telegramDeps> = {}): Promise<void> | null {
  Object.assign(telegramDeps, deps);
  if (pollLoop) return pollLoop;
  const cfg = telegramConfig();
  if (!cfg.token) return null;
  const ctrl = new AbortController();
  pollCtrl = ctrl;
  pollLoop = (async () => {
    const username = await getMeUsername(cfg.token, ctrl.signal);
    if (ctrl.signal.aborted) return;
    if (!cfg.allowedChatIds.length) console.log('[telegram] token set but no allowlisted chats; inbound ignored until TELEGRAM_ALLOWED_CHAT_IDS is set');
    else console.log(`[telegram] polling as @${username ?? 'unknown'}`);
    await pollForever(ctrl.signal);
  })().catch((e) => console.error('[telegram] polling stopped:', e?.name ?? e)).finally(() => {
    if (pollCtrl === ctrl) { pollCtrl = null; pollLoop = null; }
  });
  return pollLoop;
}

export function stopTelegramPolling(): Promise<void> {
  const loop = pollLoop ?? Promise.resolve();
  pollCtrl?.abort();
  return loop;
}
