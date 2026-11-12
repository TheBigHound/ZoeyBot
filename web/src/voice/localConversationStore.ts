import { create } from 'zustand';
import { useStore } from '../store';
import { disableReadAloud } from './readAloudStore';
import { EMPTY_LOCAL_CONVERSATION, LocalConversation, type LocalConversationState } from './localConversation';
import { createLocalConversationTransport } from './localConversationBrowser';
import { bindLocalConversation, localConversationSnapshot } from './localConversationBinding';

export const useLocalConversation = create<LocalConversationState>(() => EMPTY_LOCAL_CONVERSATION);

/** Live audio level for the panel meter: mic input while listening, playback output while speaking. */
export const VOICE_LEVEL_BARS = 40;
export const VOICE_LEVEL_FPS = 15;
export interface VoiceLevelState { level: number; history: number[] }
export const useVoiceLevel = create<VoiceLevelState>(() => ({ level: 0, history: [] }));
export function pushVoiceLevel(level: number) {
  const clamped = Math.max(0, Math.min(1, level || 0));
  useVoiceLevel.setState((s) => ({ level: clamped, history: [...s.history, clamped].slice(-VOICE_LEVEL_BARS) }));
}

let disconnect: (() => void) | null = null;
let meter: ReturnType<typeof setInterval> | null = null;
const transport = createLocalConversationTransport(localConversationSnapshot, () => {
  const s = useStore.getState();
  return s.bots.find((bot) => bot.id === s.selectedBotId)?.voiceLanguage;
});
const controller = new LocalConversation(transport, (state) => {
  useLocalConversation.setState(state);
  const active = state.status !== 'off' && state.status !== 'error';
  if (active && !meter) meter = setInterval(() => pushVoiceLevel(transport.level()), Math.round(1000 / VOICE_LEVEL_FPS));
  if (!active && meter) { clearInterval(meter); meter = null; useVoiceLevel.setState({ level: 0, history: [] }); }
  if (!active && disconnect) {
    const cleanup = disconnect; disconnect = null; cleanup();
  }
});

/** Keep this synchronous in the composer button's click; controller.start unlocks audio before awaiting. */
export function startLocalConversation(botId: string) {
  if (controller.active) return;
  if (useStore.getState().selectedBotId !== botId) return;
  disableReadAloud();
  disconnect = bindLocalConversation(controller);
  const cleanup = disconnect;
  const pagehide = () => endLocalConversation();
  window.addEventListener('pagehide', pagehide);
  disconnect = () => { window.removeEventListener('pagehide', pagehide); cleanup(); };
  void controller.start();
}

export function endLocalConversation() { controller.stop(); }
export function toggleLocalConversationMute() { controller.toggleMute(); }
export function cancelLocalConversationTurn() { void controller.cancelTurn(); }
/** Skip the reply in progress and keep talking (mic reopens once the bot's turn is interrupted). */
export function skipLocalConversationReply() { void controller.skipReply(); }
