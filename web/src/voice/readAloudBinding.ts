import { sortedRows, useStore } from '../store';
import { subscribeLiveRows } from '../lib/liveRows';
import { LocalReadAloud, type ReadAloudSnapshot } from './readAloud';

export function readAloudSnapshot(): ReadAloudSnapshot {
  const s = useStore.getState();
  const transcript = s.selectedBotId ? s.transcripts[s.selectedBotId] : undefined;
  return { botId: s.selectedBotId, generation: transcript?.generation ?? 0, loaded: !!transcript?.loaded, rows: sortedRows(transcript) };
}

export function bindLocalReadAloud(controller: LocalReadAloud): () => void {
  const unwatch = useStore.subscribe(() => controller.observe(readAloudSnapshot()));
  const unrows = subscribeLiveRows((botId, generation, rows) => controller.receive(botId, generation, rows));
  return () => { unwatch(); unrows(); controller.disable(); };
}
