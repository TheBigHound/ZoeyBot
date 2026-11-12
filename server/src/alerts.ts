import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { getBotRow } from './store.js';
import { turnHooks } from './agent/loop.js';
import { isUrgent, notifyUrgent } from './telegram.js';
import type { Alert } from './types.js';

/**
 * URGENT alerts. A routine turn whose reply starts with URGENT is forwarded to Telegram (telegram.ts)
 * and kept here so the dashboard's alert strip can show it to the person, whatever bot they have open.
 * One row per alert; dismissing hides it from the strip but keeps the record.
 */

const TEXT_MAX = 600;

function toAlert(r: any): Alert {
  return {
    id: r.id, botId: r.bot_id, botName: r.bot_name ?? r.bot_id, routineName: r.routine_name ?? null,
    text: String(r.text).slice(0, TEXT_MAX), deliveredTo: r.delivered_to, createdAt: r.created_at, dismissedAt: r.dismissed_at ?? null,
  };
}

export function recordAlert(a: { botId: string; routineName?: string | null; text: string; deliveredTo?: number }): Alert {
  const id = newId('alert');
  db.prepare('INSERT INTO alerts(id,bot_id,routine_name,text,delivered_to,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, a.botId, a.routineName ?? null, a.text.slice(0, TEXT_MAX), a.deliveredTo ?? 0, now());
  return toAlert({ ...db.prepare('SELECT * FROM alerts WHERE id=?').get(id) as any, bot_name: getBotRow(a.botId)?.name });
}

/** Newest first, scoped to the user's bots. Dismissed alerts are left out unless asked for. */
export function listAlerts(userId: string, opts: { includeDismissed?: boolean; limit?: number } = {}): Alert[] {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
  const where = opts.includeDismissed ? '' : 'AND a.dismissed_at IS NULL';
  const rows = db.prepare(`SELECT a.*, b.name AS bot_name FROM alerts a JOIN bots b ON b.id=a.bot_id WHERE b.user_id=? ${where} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`).all(userId, limit) as any[];
  return rows.map(toAlert);
}

/** Returns false when the alert does not exist or belongs to another user's bot. */
export function dismissAlert(userId: string, id: string): boolean {
  const r = db.prepare('UPDATE alerts SET dismissed_at=? WHERE id=? AND dismissed_at IS NULL AND bot_id IN (SELECT id FROM bots WHERE user_id=?)').run(now(), id, userId);
  if (r.changes) hub.emit(userId, { type: 'alerts' });
  return r.changes > 0;
}

/** A routine turn ended with an URGENT reply: send it on, keep it, and tell open dashboards. */
export async function handleRoutineResult(botId: string, routineName: string, text: string): Promise<Alert | null> {
  if (!isUrgent(text)) return null;
  let delivered = 0;
  try { delivered = await notifyUrgent(botId, routineName, text); } catch { /* delivery problems are logged by telegram.ts */ }
  const alert = recordAlert({ botId, routineName, text, deliveredTo: delivered });
  const userId = getBotRow(botId)?.user_id as string | undefined;
  if (userId) hub.emit(userId, { type: 'alerts' });
  return alert;
}

let hooksInstalled = false;
/** Register the URGENT handler with the turn loop. loop.ts must not import this module (cycle), so it is pushed in. */
export function installAlertHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  turnHooks.afterRoutine = (botId, name, text) => { void handleRoutineResult(botId, name, text).catch((e) => console.error('[alerts] hook failed', e?.message ?? e)); };
}
