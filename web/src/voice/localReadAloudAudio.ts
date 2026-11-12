import { voiceApi } from './api';
import { createAudioContext, PcmPlayer } from './audio';
import type { ReadAloudAudio } from './readAloud';

/** Local phonon playback plus a live output level for the voice meter. */
export interface LocalReadAloudAudio extends ReadAloudAudio {
  /** RMS 0..1 of the chunk currently playing (AnalyserNode behind the PCM player); 0 when idle. */
  level(): number;
}

/** Uses the existing local phonon route and PCM player. Never creates a realtime call/session. */
export function createLocalReadAloudAudio(): LocalReadAloudAudio {
  let ctx: AudioContext | null = null;
  let player: PcmPlayer | null = null;
  const requireLocal = async () => {
    const options = await voiceApi.options();
    if (options.provider !== 'local' || !options.capabilities.tts) throw new Error('Local read-aloud is unavailable. No cloud voice was used.');
  };
  return {
    async activate() {
      // This must precede all awaits/network requests to retain the real click/keyboard gesture.
      ctx = createAudioContext();
      const context = ctx;
      player = new PcmPlayer(context);
      await context.resume();
      if (context.state !== 'running') throw new Error('Audio is blocked. Enable local voice again to allow playback.');
      await requireLocal();
    },
    async synthesize(botId, text) {
      await requireLocal();
      return voiceApi.preview({ botId, text });
    },
    play(pcm) {
      if (!player || ctx?.state !== 'running') return Promise.reject(new Error('Audio was suspended. Enable local voice again to resume playback.'));
      if (!pcm.length) return Promise.reject(new Error('Local speech returned empty audio.'));
      const current = player;
      return new Promise<void>((resolve, reject) => {
        current.onIdle = () => { current.onIdle = null; resolve(); };
        try { current.push(pcm); } catch (e) { current.onIdle = null; reject(e); }
      });
    },
    clear() { player?.clear(); },
    level() {
      try { return player?.level() ?? 0; } catch { return 0; }
    },
    close() {
      player?.dispose();
      player = null;
      if (ctx) void ctx.close().catch(() => {});
      ctx = null;
    },
  };
}
