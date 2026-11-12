import { useEffect } from 'react';
import { useStore } from '../store';
import type { VoiceOptions } from '../voice/api';
import { connectLocalReadAloud, disableReadAloud, toggleLocalReadAloud, useReadAloud } from '../voice/readAloudStore';
import { useLocalConversation } from '../voice/localConversationStore';

// One live read-aloud binding per page, however many voice controls are mounted (pill in the header, legacy toggle).
let subscribers = 0;
let disconnect: (() => void) | null = null;
function acquireReadAloudConnection() {
  if (subscribers++ === 0) {
    disconnect = connectLocalReadAloud();
    window.addEventListener('pagehide', disableReadAloud);
  }
  return () => {
    if (--subscribers > 0) return;
    window.removeEventListener('pagehide', disableReadAloud);
    disconnect?.(); disconnect = null;
  };
}

/** Keeps the local read-aloud controller bound to the store while a local-provider voice control is mounted. */
export function useLocalReadAloudConnection(local: boolean) {
  useEffect(() => { if (local) return acquireReadAloudConnection(); }, [local]);
}

export type VoicePillState = 'starting' | 'live' | 'paused' | 'on' | 'enabling' | 'off';

/**
 * The single honest mic/voice indicator for the chat header.
 * live/paused = a local turn-based conversation holds the mic for this bot; on = replies are read aloud; off = quiet opt-in.
 * Renders nothing for non-local providers (cloud calls have their own call bar).
 */
export function VoiceStatusPill({ botId, options }: { botId: string; options: VoiceOptions | null }) {
  const conversation = useLocalConversation();
  const readAloud = useReadAloud();
  const loaded = useStore((s) => !!s.transcripts[botId]?.loaded);
  const name = useStore((s) => s.bots.find((b) => b.id === botId)?.name) || 'Zoey';
  const local = options?.provider === 'local';
  useLocalReadAloudConnection(local);
  if (!local) return null;

  const inConversation = conversation.botId === botId && conversation.status !== 'off' && conversation.status !== 'error';
  // "Mic live" is only true while the capture is open and unmuted; every other conversation phase has the mic paused.
  const state: VoicePillState = inConversation ? (conversation.status === 'starting' ? 'starting' : conversation.status === 'listening' && !conversation.muted ? 'live' : 'paused')
    : readAloud.enabled ? 'on' : readAloud.status === 'enabling' ? 'enabling' : 'off';
  const pausedWhy = conversation.muted ? 'local voice' : conversation.status === 'speaking' ? `${name} speaking` : conversation.status === 'transcribing' ? 'transcribing' : conversation.status === 'synthesizing' ? 'preparing speech' : 'waiting for reply';
  const label = { starting: 'Starting mic…', live: 'Mic live · local voice', paused: `Mic paused · ${pausedWhy}`, on: 'Voice on · replies read aloud', enabling: 'Enabling voice…', off: 'Enable voice' }[state];
  const modifier = { starting: ' is-paused', live: ' is-live', paused: ' is-paused', on: ' is-on', enabling: ' is-on', off: '' }[state];
  const canEnable = loaded && options.capabilities.tts;
  const title = inConversation
    ? 'A local turn-based voice conversation is running. Use the panel above the composer to pause or end it.'
    : state === 'on' || state === 'enabling' ? 'Stop audio and mute automatic read-aloud'
      : canEnable ? 'Read new replies aloud with the local voice. No cloud speech or live calls.'
        : !options.capabilities.tts ? 'Local speech is unavailable' : 'Wait for the chat to load';
  const detail = readAloud.error || (readAloud.status === 'synthesizing' ? 'Preparing speech…' : readAloud.status === 'speaking' ? 'Speaking…' : null);

  return (
    <button
      type="button"
      className={`voice-pill${modifier}`}
      aria-pressed={state === 'on' || state === 'enabling'}
      aria-disabled={inConversation || undefined}
      disabled={!inConversation && state === 'off' && !canEnable}
      onClick={inConversation ? undefined : toggleLocalReadAloud}
      title={readAloud.error || title}
    >
      <i className="voice-pill__dot" aria-hidden />
      <span className="voice-pill__label">{label}</span>
      {detail && !inConversation && <span className="voice-pill__detail" role={readAloud.error ? 'alert' : 'status'}>{detail}</span>}
    </button>
  );
}
