import type { VoiceOptions } from '../voice/api';
import { VoiceStatusPill } from './VoiceStatusPill';

/**
 * Legacy mount point above the composer. The header VoiceStatusPill is now the single mic/voice indicator and owns
 * the read-aloud binding (ref-counted, so mounting both never double-binds). `compact` renders nothing.
 */
export function LocalVoiceToggle({ botId, options, compact }: { botId: string; options: VoiceOptions | null; compact?: boolean }) {
  if (compact || options?.provider !== 'local') return null;
  return <div className="local-voice"><VoiceStatusPill botId={botId} options={options} /></div>;
}
