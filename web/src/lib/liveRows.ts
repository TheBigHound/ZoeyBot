import type { Row } from '@shared/types';

type Listener = (botId: string, generation: number, rows: Row[]) => void;
const listeners = new Set<Listener>();

/** Live SSE row events only. REST transcript loads must never be published here. */
export function publishLiveRows(botId: string, generation: number, rows: Row[]) {
  for (const listener of listeners) listener(botId, generation, rows);
}

export function subscribeLiveRows(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
