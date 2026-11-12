// Composer dictation: hold the mic to talk (or tap to start, tap again to stop). Records with MediaRecorder,
// transcribes through the server's STT proxy, and hands the text back to the composer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceApi } from './api';
import { micErrorMessage, openMic } from './audio';

export type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing';

const HOLD_MS = 350;
const MAX_MS = 120_000;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return undefined;
}

export function useDictation(onText: (text: string) => void, onError: (msg: string) => void, language?: string, botId?: string) {
  const [state, setState] = useState<DictationState>('idle');
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; downAt: number; cancelled: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const starting = useRef(false);
  const generation = useRef(0);
  const toggleMode = useRef(false);
  const pointerDownAt = useRef<number | null>(null);
  const cb = useRef({ onText, onError, language });
  cb.current = { onText, onError, language };

  const finish = useCallback((cancel = false) => {
    if (cancel) {
      generation.current++;
      starting.current = false;
      toggleMode.current = false;
      setState('idle');
    }
    const r = rec.current;
    if (!r) return;
    r.cancelled = cancel;
    clearTimeout(r.timer);
    if (r.mr.state !== 'inactive') r.mr.stop();
    else r.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const begin = useCallback(async () => {
    if (rec.current || starting.current) return;
    if (typeof MediaRecorder === 'undefined') { cb.current.onError('Dictation isn’t supported in this browser.'); return; }
    starting.current = true;
    setState('starting');
    const token = generation.current;
    const downAt = Date.now();
    let stream: MediaStream | undefined;
    try {
      const options = await voiceApi.options();
      if (token !== generation.current) return;
      if (!options.capabilities.stt) throw new Error('Local transcription is unavailable. An installed Whisper model is required.');
      stream = await openMic();
      if (token !== generation.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      const mime = pickMime();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const r = { mr, stream, chunks: [] as Blob[], downAt, cancelled: false, timer: setTimeout(() => finish(), MAX_MS) };
      rec.current = r;
      mr.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
      mr.onerror = (e) => {
        if (token !== generation.current) return;
        finish(true);
        cb.current.onError(micErrorMessage((e as Event & { error?: Error }).error ?? new Error('Microphone recording failed.')));
      };
      mr.onstop = async () => {
        r.stream.getTracks().forEach((t) => t.stop());
        rec.current = null;
        toggleMode.current = false;
        // Keep complete short utterances too; stop's final dataavailable is already included.
        if (r.cancelled || !r.chunks.length) { setState('idle'); return; }
        setState('transcribing');
        try {
          const text = await voiceApi.transcribe(new Blob(r.chunks, { type: mr.mimeType || mime || 'audio/webm' }), cb.current.language);
          if (token === generation.current && text) cb.current.onText(text);
        } catch (e) {
          if (token === generation.current) cb.current.onError((e as Error).message || 'Transcription failed');
        } finally {
          if (token === generation.current) setState('idle');
        }
      };
      mr.start(250);
      setState('recording');
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      if (token !== generation.current) return;
      finish(true);
      cb.current.onError(micErrorMessage(e));
      setState('idle');
    } finally {
      if (token === generation.current) starting.current = false;
    }
  }, [finish]);

  // Pointer handlers: press-and-hold records until release; a quick tap toggles recording on, tap again stops.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (toggleMode.current && (rec.current || starting.current)) { finish(starting.current); return; }
    pointerDownAt.current = Date.now();
    void begin();
  }, [begin, finish]);

  const onPointerUp = useCallback(() => {
    if (pointerDownAt.current === null) return;
    const held = Date.now() - pointerDownAt.current >= HOLD_MS;
    pointerDownAt.current = null;
    const r = rec.current;
    if (!r) {
      if (starting.current) {
        if (held) finish(true);
        else toggleMode.current = true;
      }
      return;
    }
    if (toggleMode.current) return;
    if (!held) toggleMode.current = true; // tap: keep recording
    else finish();
  }, [finish]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (rec.current) finish();
    else { toggleMode.current = true; void begin(); }
  }, [begin, finish]);

  const onPointerCancel = useCallback(() => {
    pointerDownAt.current = null;
    finish(true);
  }, [finish]);

  // Esc cancels; unmount stops.
  useEffect(() => {
    if (state !== 'recording' && state !== 'starting') return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [state, finish]);
  // A recording/transcription belongs to one draft, including while permission is pending.
  useEffect(() => () => finish(true), [finish, botId]);

  return { state, onPointerDown, onPointerUp, onPointerCancel, onKeyDown, cancel: () => finish(true) };
}
