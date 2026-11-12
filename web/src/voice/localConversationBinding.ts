import { sortedRows, useStore } from '../store';
import { subscribeLiveRows } from '../lib/liveRows';
import type { LocalConversation, LocalConversationSnapshot } from './localConversation';

export function localConversationSnapshot(): LocalConversationSnapshot {
  const s = useStore.getState();
  const botId = s.selectedBotId;
  const transcript = botId ? s.transcripts[botId] : undefined;
  return { botId, generation: transcript?.generation ?? 0, loaded: !!transcript?.loaded, running: !!(botId && s.live[botId]?.isRunning), rows: sortedRows(transcript) };
}

/** Only live SSE can trigger speech; REST/history snapshots merely validate identity and lifetime. */
export function bindLocalConversation(controller: LocalConversation): () => void {
  const unwatch = useStore.subscribe(() => controller.observe(localConversationSnapshot()));
  const unrows = subscribeLiveRows((botId, generation, rows) => controller.receive(botId, generation, rows));
  return () => { unwatch(); unrows(); };
}
