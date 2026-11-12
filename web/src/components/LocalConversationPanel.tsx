import { useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { useStore } from '../store';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { endLocalConversation, skipLocalConversationReply, toggleLocalConversationMute, useLocalConversation, useVoiceLevel, VOICE_LEVEL_BARS } from '../voice/localConversationStore';
import { formatStepTime, railSteps, type LocalConversationState, type LocalConversationStatus, type RailStepId } from '../voice/localConversation';

const WORKING: LocalConversationStatus[] = ['sending', 'waiting', 'synthesizing', 'speaking'];
/** Skip needs an accepted user row to interrupt against; during 'sending' the send itself is still in flight. */
const SKIPPABLE: LocalConversationStatus[] = ['waiting', 'synthesizing', 'speaking'];
const HUE: Record<RailStepId, string> = { listening: 'var(--v-listen)', transcribing: 'var(--v-transcribe)', waiting: 'var(--v-think)', speaking: 'var(--v-speak)' };
const STEP_OF_STATUS: Partial<Record<LocalConversationStatus, RailStepId>> = { listening: 'listening', paused: 'listening', transcribing: 'transcribing', sending: 'waiting', waiting: 'waiting', synthesizing: 'speaking', speaking: 'speaking' };

/** Re-render on a slow clock while the conversation is live so elapsed times tick. */
function useNow(active: boolean, intervalMs = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

export function LocalConversationPanel({ botId, name }: { botId: string; name: string }) {
  const voice = useLocalConversation();
  const level = useVoiceLevel((s) => s.level);
  const history = useVoiceLevel((s) => s.history);
  const bot = useStore((s) => s.bots.find((b) => b.id === botId));
  const live = voice.botId === botId && voice.status !== 'off' && voice.status !== 'error';
  const now = useNow(live);
  return <LocalConversationView botId={botId} name={name} voice={voice} level={level} history={history} now={now} bot={bot} />;
}

export interface LocalConversationViewProps {
  botId: string;
  name: string;
  voice: LocalConversationState;
  /** Latest published level 0..1 and its recent history (newest last); drives the meter strip. */
  level?: number;
  history?: number[];
  /** Wall clock for live elapsed times; injected for deterministic tests. */
  now?: number;
  bot?: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'>;
}

export function LocalConversationView({ botId, name, voice, level = 0, history = [], now = Date.now(), bot }: LocalConversationViewProps) {
  const active = voice.status !== 'off' && voice.status !== 'error';
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') endLocalConversation(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [active]);
  if (voice.status === 'off' || (voice.botId && voice.botId !== botId)) return null;

  const working = WORKING.includes(voice.status);
  const step = STEP_OF_STATUS[voice.status];
  const hue = voice.status === 'error' ? 'var(--color-danger-text)' : step ? HUE[step] : 'var(--color-text-quaternary)';
  const status: Record<LocalConversationStatus, [string, string?]> = {
    off: [''],
    starting: ['Opening microphone…'],
    listening: ['Listening', 'pause ~1s to send'],
    paused: ['Listening paused'],
    transcribing: ['Transcribing locally…'],
    sending: [`Waiting for ${name}`, 'tools may take a while'],
    waiting: [`Waiting for ${name}`, 'tools may take a while'],
    synthesizing: ['Preparing speech…'],
    speaking: [`${name} is speaking`, 'mic paused until she finishes'],
    error: [voice.error || 'Local voice unavailable'],
  };
  const [primary, secondary] = status[voice.status];
  const steps = railSteps(voice, now);
  const labels: Record<RailStepId, string> = { listening: 'Listening', transcribing: 'Transcribing locally', waiting: `Waiting for ${name}`, speaking: `${name} is speaking` };
  const output = voice.status === 'speaking' || voice.status === 'synthesizing';
  const input = voice.status === 'listening';
  const bars = Array.from({ length: VOICE_LEVEL_BARS }, (_, i) => history[history.length - VOICE_LEVEL_BARS + i] ?? 0);
  const meterLabel = output ? `Output · ${name}` : voice.status === 'paused' ? 'Input · paused' : 'Input · you';

  return (
    <section className={`voice-panel is-${voice.status}`} style={{ ...(bot ? botVars(bot.avatarColor) : {}), ['--v-state' as string]: hue }} aria-label={`Local voice conversation with ${name}`}>
      <div className="voice-panel__hd">
        <span className="voice-panel__ring" aria-hidden>
          {bot ? <BotAvatarFor bot={bot} size={32} /> : <span className="voice-panel__ring-fallback" />}
        </span>
        <div className="voice-panel__id">
          <div className="voice-panel__ttl">{name}<span className="voice-panel__tag">Local voice</span><span className="voice-panel__tag">Turn-based</span></div>
          <div className="voice-panel__status" role={voice.error ? 'alert' : 'status'}>
            <i className="voice-panel__sdot" aria-hidden />
            <span>{primary}{secondary && <> · <span className="voice-panel__status-muted">{secondary}</span></>}</span>
          </div>
        </div>
        <div className="voice-panel__actions">
          {SKIPPABLE.includes(voice.status) && <button type="button" className="voice-panel__btn voice-panel__btn--ghost" onClick={skipLocalConversationReply} title={`Stop this reply, interrupt ${name}'s turn and keep listening`}>Skip reply</button>}
          {active && <button type="button" className="voice-panel__btn" aria-pressed={voice.muted} onClick={toggleLocalConversationMute}>{voice.muted ? 'Resume listening' : 'Pause listening'}</button>}
          <button type="button" className="voice-panel__btn voice-panel__btn--danger" aria-label="End voice conversation" onClick={endLocalConversation} title="Release the microphone and stop audio. An existing chat reply can continue. (Esc)">{active ? 'End' : 'Dismiss'}</button>
        </div>
      </div>
      {active && (
        <>
          <ol className="voice-panel__rail" aria-label="Voice turn progress">
            {steps.map((s) => (
              <li key={s.id} className={`voice-panel__step is-${s.state}`} style={{ ['--v-step' as string]: HUE[s.id] }} aria-current={s.state === 'on' ? 'step' : undefined}>
                <span className="voice-panel__step-label">{labels[s.id]}</span>
                {s.ms !== undefined && <span className="voice-panel__ms">{formatStepTime(s.ms, s.id === 'speaking' && s.state === 'on' ? 'clock' : 'seconds')}</span>}
              </li>
            ))}
          </ol>
          <div className="voice-panel__wave" aria-hidden style={{ ['--v-level' as string]: level }}>
            <div className="voice-panel__bars">
              {bars.map((v, i) => <i key={i} className="voice-panel__bar" style={{ ['--h' as string]: `${4 + Math.round(v * 28)}px` }} />)}
            </div>
            <span className="voice-panel__wave-lbl">
              {meterLabel}
              {!input && (
                <span className="voice-panel__micoff">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5.5" y="2" width="5" height="8" rx="2.5" /><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14M2 2l12 12" /></svg>
                  mic off
                </span>
              )}
            </span>
          </div>
          <div className="voice-panel__caps">
            <div className="voice-panel__cap">
              <div className="voice-panel__cap-k"><i aria-hidden />You · voice</div>
              <div className={`voice-panel__cap-t${voice.transcript ? '' : ' is-empty'}`}>{voice.transcript ? `“${voice.transcript}”` : 'Say something — it is transcribed on this Mac.'}</div>
            </div>
            <div className="voice-panel__cap voice-panel__cap--bot">
              <div className="voice-panel__cap-k"><i aria-hidden />{name}</div>
              <div className={`voice-panel__cap-t${voice.reply ? '' : ' is-empty'}`}>{voice.reply || (working ? '…' : '—')}</div>
            </div>
          </div>
        </>
      )}
      <div className="voice-panel__foot">Whisper + phonon run on this Mac</div>
    </section>
  );
}
