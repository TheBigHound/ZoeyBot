import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { getBot } from './store.js';
import { assignEngine, provisionEngine } from './engine.js';
import type { AvatarColor, AvatarShape } from './types.js';

export const SHAPES: AvatarShape[] = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star'];
export const COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

export interface NewBot { name: string; label?: string; description?: string; instructions?: string; avatarShape?: string; avatarColor?: string; mode?: string; isPrimary?: boolean }

/**
 * Engine and voice choices written to the row before the gateway first starts, so a bot built by
 * another bot comes up once with its real settings instead of starting on defaults and restarting.
 * Callers validate these; nothing here checks them.
 */
export interface BotSetup { provider?: string | null; model?: string | null; toolsets?: string[] | null; cwd?: string | null; voice?: string | null; effort?: string | null; createdBy?: string | null }

export function createBot(userId: string, b: NewBot, setup?: BotSetup) {
  const id = newId('bot');
  const shape = SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, SHAPES.slice(0, 13));
  const color = COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, b.name.trim().slice(0, 60) || 'New Bot', b.label ?? '', b.description ?? '', b.instructions ?? '', shape, color, b.mode === 'teammate' ? 'teammate' : 'personal', b.isPrimary ? 1 : 0, now(), now());
  if (setup) {
    db.prepare('UPDATE bots SET provider=?, model=?, toolsets=?, cwd=?, created_by=? WHERE id=?')
      .run(setup.provider ?? null, setup.model ?? null, setup.toolsets?.length ? JSON.stringify(setup.toolsets) : null, setup.cwd ?? null, setup.createdBy ?? null, id);
    if (setup.voice) db.prepare('UPDATE bots SET voice=? WHERE id=?').run(setup.voice, id);
    if (setup.effort) db.prepare('UPDATE bots SET effort=? WHERE id=?').run(setup.effort, id);
  }
  // The first bot is the primary Hermes agent (data/primary-hermes); the others get a managed gateway of their own.
  if (assignEngine(id) === 'managed') provisionEngine(id);
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}
