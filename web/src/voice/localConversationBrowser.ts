import { api } from '../lib/api';
import { voiceApi, type VoiceOptions } from './api';
import { createAudioContext, MicCapture, micErrorMessage, openMic } from './audio';
import { createLocalReadAloudAudio } from './localReadAloudAudio';
import type { LocalConversationSnapshot, LocalConversationTransport } from './localConversation';

export function supportsLocalConversation(options: VoiceOptions | null): boolean {
  return options?.provider === 'local' && options.capabilities.tts && options.capabilities.stt;
}

function wav(pcm: Int16Array): Blob {
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, pcm.byteLength, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([buffer], { type: 'audio/wav' });
}

type Session = {
  ctx: AudioContext;
  output: ReturnType<typeof createLocalReadAloudAudio>;
  stream: MediaStream | null;
  capture: MicCapture | null;
  closed: boolean;
};

/** Local /stt + ordinary bot chat + local /preview. No realtime token/session endpoints. */
export function createLocalConversationTransport(snapshot: () => LocalConversationSnapshot, language: () => string | undefined = () => undefined): LocalConversationTransport {
  let current: Session | null = null;
  const requireLocal = async () => {
    if (!supportsLocalConversation(await voiceApi.options())) throw new Error('Local voice conversation requires local Whisper and phonon. No cloud voice was used.');
  };
  const dispose = (s: Session) => {
    s.closed = true;
    s.capture?.stop(); s.capture = null;
    for (const track of s.stream?.getTracks() ?? []) track.stop();
    s.stream = null;
    s.output.close();
    if (s.ctx.state !== 'closed') void s.ctx.close().catch(() => {});
  };
  return {
    snapshot,
    async activate(onFrame) {
      // Both contexts must be constructed/resumed before the first await, in the real click.
      const s: Session = { ctx: createAudioContext(), output: createLocalReadAloudAudio(), stream: null, capture: null, closed: false };
      current = s;
      try {
        await Promise.all([s.output.activate(), requireLocal()]);
        if (s.closed || current !== s) return;
        s.stream = await openMic();
        if (s.closed || current !== s) { dispose(s); return; }
        if (s.ctx.state !== 'running') throw new Error('Microphone audio is suspended. Start local voice again to allow audio.');
        s.capture = new MicCapture(s.ctx, s.stream, onFrame);
        s.capture.muted = true;
        const capture = s.capture;
        await capture.start();
        if (s.closed || current !== s) { capture.stop(); dispose(s); }
      } catch (e) {
        dispose(s);
        if (current === s) current = null;
        throw new Error(micErrorMessage(e));
      }
    },
    mute(muted) { if (current?.capture) current.capture.muted = muted; },
    async transcribe(pcm, signal) {
      await requireLocal();
      signal.throwIfAborted();
      const body = new FormData();
      const lang = language();
      if (lang) body.append('language', lang);
      body.append('file', wav(pcm), 'voice-turn.wav');
      const response = await fetch('/api/voice/stt', { method: 'POST', credentials: 'include', body, signal });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(error.error || 'Local transcription failed. No cloud fallback was used.');
      }
      const result = await response.json() as { text?: string };
      return result.text ?? '';
    },
    async send(botId, text) { return (await api.send(botId, text)).row; },
    async synthesize(botId, text) {
      await requireLocal();
      if (!current || current.closed) throw new Error('Local conversation ended.');
      const s = current;
      // An opt-in read-aloud request may still be finishing server-side after disable().
      // Retry only local unavailability; never abort and overlap a running inference.
      for (let attempt = 0; ; attempt++) {
        if (s.closed || current !== s) throw new Error('Local conversation ended.');
        try { return await s.output.synthesize(botId, text); }
        catch (e) {
          if (attempt >= 4 || !/local speech.*(?:busy|unavailable)/i.test((e as Error)?.message ?? '')) throw e;
          await new Promise<void>((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
    },
    play(pcm) {
      if (!current || current.closed) return Promise.reject(new Error('Local conversation ended.'));
      return current.output.play(pcm);
    },
    clear() { current?.output.clear(); },
    level() {
      if (!current || current.closed) return 0;
      // Output wins while a chunk is playing; otherwise the (possibly muted → 0) mic level.
      const out = current.output.level();
      return out > 0 ? out : Math.min(1, current.capture?.level ?? 0);
    },
    close() { if (current) dispose(current); current = null; },
    async interrupt(botId) { await api.interrupt(botId); },
  };
}
