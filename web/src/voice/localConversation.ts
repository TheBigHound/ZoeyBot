import type { Row } from '@shared/types';
import { UtteranceDetector } from './localConversationVad';

export interface LocalConversationSnapshot {
  botId: string | null;
  generation: number;
  loaded: boolean;
  running: boolean;
  rows: Row[];
}
/** Wall-clock marks for one voice turn (Date.now()). *StartedAt = live step start; *Ms = recorded duration once the step ends. */
export interface LocalConversationTurn {
  listeningStartedAt?: number;
  listeningMs?: number;
  transcribingStartedAt?: number;
  transcribingMs?: number;
  waitingStartedAt?: number;
  waitingMs?: number;
  speakingStartedAt?: number;
  speakingMs?: number;
}
export type LocalConversationStatus = 'off' | 'starting' | 'listening' | 'paused' | 'transcribing' | 'sending' | 'waiting' | 'synthesizing' | 'speaking' | 'error';
export interface LocalConversationState {
  botId: string | null;
  status: LocalConversationStatus;
  muted: boolean;
  transcript: string;
  reply: string;
  error: string | null;
  turn: LocalConversationTurn;
}
export const EMPTY_LOCAL_CONVERSATION: LocalConversationState = { botId: null, status: 'off', muted: false, transcript: '', reply: '', error: null, turn: {} };

export type RailStepId = 'listening' | 'transcribing' | 'waiting' | 'speaking';
export interface RailStep { id: RailStepId; state: 'done' | 'on' | 'todo'; ms?: number }
const RAIL: RailStepId[] = ['listening', 'transcribing', 'waiting', 'speaking'];
const STEP_OF: Partial<Record<LocalConversationStatus, number>> = { listening: 0, paused: 0, transcribing: 1, sending: 2, waiting: 2, synthesizing: 3, speaking: 3 };

/** Which of the four loop steps is lit, done (with its recorded time) or still to come. Pure; `now` only feeds the live step. */
export function railSteps(state: LocalConversationState, now = Date.now()): RailStep[] {
  const current = STEP_OF[state.status];
  if (current === undefined) return RAIL.map((id) => ({ id, state: 'todo' }));
  const t = state.turn;
  const starts = [t.listeningStartedAt, t.transcribingStartedAt, t.waitingStartedAt, t.speakingStartedAt];
  const recorded = [t.listeningMs, t.transcribingMs, t.waitingMs, t.speakingMs];
  return RAIL.map((id, i) => {
    const start = starts[i];
    if (i === current) return { id, state: 'on', ms: start === undefined ? undefined : Math.max(0, now - start) };
    // The only loop-back is waiting → speaking → waiting (tool turns); then the speaking step stays done behind it.
    if (i < current || (current === 2 && recorded[i] !== undefined)) return { id, state: 'done', ms: recorded[i] };
    return { id, state: 'todo' };
  });
}

/** '3.2s' for step durations; 'm:ss' for the live speaking counter. */
export function formatStepTime(ms: number, style: 'seconds' | 'clock' = 'seconds'): string {
  if (style === 'clock') { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  return `${(ms / 1000).toFixed(1)}s`;
}

export interface LocalConversationTransport {
  snapshot(): LocalConversationSnapshot;
  activate(onFrame: (pcm: Int16Array) => void): Promise<void>;
  mute(muted: boolean): void;
  transcribe(pcm: Int16Array, signal: AbortSignal): Promise<string>;
  send(botId: string, text: string): Promise<Row>;
  synthesize(botId: string, text: string): Promise<Int16Array>;
  play(pcm: Int16Array): Promise<void>;
  clear(): void;
  close(): void;
  interrupt(botId: string): Promise<void>;
  /** 0..1 — mic input while listening, playback output while speaking; 0 otherwise. */
  level(): number;
}

/** Turn-based only: the mic is disabled from transcription through the actual audio end. */
export class LocalConversation {
  state: LocalConversationState = EMPTY_LOCAL_CONVERSATION;
  private epoch = 0;
  /** Bumped by stop() and skipReply(); invalidates in-flight transcribe/send/synthesize/play continuations without dropping the mic session. */
  private turnEpoch = 0;
  private generation = 0;
  private floor = 0;
  private userFloor = 0;
  private vad = new UtteranceDetector();
  private abort: AbortController | null = null;
  private buffered = new Map<number, Row>();
  private queue: string[] = [];
  private seen = new Set<number>();
  private busy = false;
  private heardReply = false;

  constructor(private io: LocalConversationTransport, private onChange: (state: LocalConversationState) => void = () => {}) {}

  get active() { return this.state.status !== 'off' && this.state.status !== 'error'; }

  private report(patch: Partial<LocalConversationState>) {
    const turn = patch.status !== undefined && patch.status !== this.state.status ? this.advance(this.state.status, patch.status) : this.state.turn;
    this.state = { ...this.state, ...patch, turn };
    this.onChange(this.state);
  }

  /** Stamp the turn clock on real status transitions only (chunk-level synth↔speak flips keep the first mark). */
  private advance(from: LocalConversationStatus, to: LocalConversationStatus): LocalConversationTurn {
    const now = Date.now();
    const t = { ...this.state.turn };
    const elapsed = (since?: number) => (since === undefined ? undefined : Math.max(0, now - since));
    switch (to) {
      case 'listening': case 'paused':
        return from === 'listening' || from === 'paused' ? t : { listeningStartedAt: now };
      case 'transcribing':
        return { ...t, listeningMs: elapsed(t.listeningStartedAt), transcribingStartedAt: now };
      case 'sending':
        return { ...t, transcribingMs: elapsed(t.transcribingStartedAt), waitingStartedAt: now };
      case 'waiting':
        // A reply finished but the bot is still running tools: wait again, keep the speaking step as done.
        if (from === 'speaking' || from === 'synthesizing') return { ...t, speakingMs: elapsed(t.speakingStartedAt), speakingStartedAt: undefined, waitingStartedAt: now, waitingMs: undefined };
        return t;
      case 'synthesizing':
        return t.waitingMs === undefined && t.waitingStartedAt !== undefined ? { ...t, waitingMs: elapsed(t.waitingStartedAt) } : t;
      case 'speaking':
        return t.speakingStartedAt === undefined ? { ...t, speakingStartedAt: now } : t;
      default:
        return {};
    }
  }

  async start() {
    if (this.active) return;
    if (this.busy) { this.report({ status: 'error', error: 'Previous local speech is still finishing. Try again shortly.' }); return; }
    const snapshot = this.io.snapshot();
    if (!snapshot.loaded || !snapshot.botId || snapshot.running) {
      this.report({ status: 'error', error: 'Wait for the selected chat to load and finish its current reply.' });
      return;
    }
    this.floor = Math.max(0, ...snapshot.rows.map((r) => r.seq));
    this.userFloor = this.floor;
    this.generation = snapshot.generation;
    this.seen.clear(); this.buffered.clear(); this.queue = []; this.heardReply = false;
    const epoch = ++this.epoch;
    this.report({ botId: snapshot.botId, status: 'starting', error: null, muted: false, transcript: '', reply: '' });
    try {
      // No await before activation: Web Audio must be unlocked in the original user gesture.
      await this.io.activate((pcm) => { if (epoch === this.epoch) this.frame(pcm); });
      if (epoch !== this.epoch) return;
      this.listen();
    } catch (e) { if (epoch === this.epoch) this.fail(e); }
  }

  toggleMute() {
    if (!this.active) return;
    this.report({ muted: !this.state.muted });
    this.vad.reset();
    if (this.state.status === 'listening' || this.state.status === 'paused') this.listen();
    else this.io.mute(true);
  }

  observe(snapshot: LocalConversationSnapshot) {
    if (!this.active) return;
    if (snapshot.botId !== this.state.botId || snapshot.generation !== this.generation || !snapshot.loaded) { this.stop(); return; }
    // During send, SSE can beat the HTTP response containing our authoritative user row.
    if (this.state.status !== 'sending' && snapshot.rows.some((r) => r.seq > this.userFloor && r.body.type === 'message' && r.body.role === 'user')) { this.stop(); return; }
    if (this.state.status === 'waiting' && this.heardReply && !this.busy && !snapshot.running) this.listen();
  }

  private listen() {
    this.vad.reset();
    this.io.mute(this.state.muted);
    this.report({ status: this.state.muted ? 'paused' : 'listening' });
  }

  private frame(pcm: Int16Array) {
    if (this.state.status !== 'listening') return;
    const utterance = this.vad.push(pcm);
    if (utterance) void this.submit(utterance);
  }

  private async submit(pcm: Int16Array) {
    const epoch = this.epoch; const turn = this.turnEpoch;
    const stale = () => epoch !== this.epoch || turn !== this.turnEpoch;
    this.io.mute(true);
    this.report({ status: 'transcribing' });
    this.abort = new AbortController();
    try {
      const text = (await this.io.transcribe(pcm, this.abort.signal)).trim();
      if (stale()) return;
      if (!text) { this.listen(); return; }
      const snapshot = this.io.snapshot();
      this.floor = Math.max(this.floor, ...snapshot.rows.map((r) => r.seq));
      this.userFloor = this.floor;
      this.heardReply = false; this.buffered.clear();
      this.report({ status: 'sending', transcript: text, reply: '' });
      const row = await this.io.send(this.state.botId!, text);
      if (stale()) return;
      const buffered = [...this.buffered.values()];
      this.buffered.clear();
      if (buffered.some((r) => r.seq > this.userFloor && r.seq !== row.seq && r.body.type === 'message' && r.body.role === 'user')) { this.stop(); return; }
      this.floor = row.seq;
      this.userFloor = row.seq;
      this.report({ status: 'waiting' });
      this.receive(this.state.botId!, this.generation, buffered);
    } catch (e) { if (!stale()) this.fail(e); }
  }

  receive(botId: string, generation: number, rows: Row[]) {
    if (!this.active || botId !== this.state.botId || generation !== this.generation) return;
    if (this.state.status === 'sending') { for (const row of rows) this.buffered.set(row.seq, row); return; }
    if (rows.some((r) => r.seq > this.userFloor && r.body.type === 'message' && r.body.role === 'user')) { this.stop(); return; }
    if (!['waiting', 'synthesizing', 'speaking'].includes(this.state.status)) return;
    for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
      const body = row.body;
      if (row.seq <= this.floor || this.seen.has(row.seq) || body.type !== 'message' || body.role !== 'assistant' || body.streaming || !body.text.trim()) continue;
      this.seen.add(row.seq);
      this.queue.push(body.text);
    }
    if (this.queue.length && !this.busy) void this.speak();
  }

  private async speak() {
    const epoch = this.epoch; const turn = this.turnEpoch;
    const stale = () => epoch !== this.epoch || turn !== this.turnEpoch;
    this.busy = true;
    try {
      while (this.queue.length && !stale()) {
        const text = this.queue.shift()!;
        this.report({ status: 'synthesizing', reply: text });
        let remaining = text.trim();
        while (remaining && !stale()) {
          let end = Math.min(400, remaining.length);
          if (end < remaining.length) {
            const space = remaining.slice(0, end).lastIndexOf(' ');
            if (space > 200) end = space;
            if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
          }
          this.report({ status: 'synthesizing' });
          // Do not abort phonon: HTTP cancellation does not stop server-side inference.
          const pcm = await this.io.synthesize(this.state.botId!, remaining.slice(0, end));
          remaining = remaining.slice(end).trim();
          if (stale()) return;
          this.report({ status: 'speaking' });
          await this.io.play(pcm);
        }
        this.heardReply = true;
      }
    } catch (e) { if (!stale()) this.fail(e); }
    finally {
      this.busy = false;
      if (!stale() && this.active) {
        if (this.io.snapshot().running) this.report({ status: 'waiting' });
        else this.listen();
      } else if (epoch === this.epoch && this.active && this.queue.length && ['waiting', 'synthesizing', 'speaking'].includes(this.state.status)) {
        // A skipped reply's synthesis just finished; drain anything the new turn queued meanwhile.
        void this.speak();
      }
    }
  }

  /**
   * Skip the reply in progress but keep the conversation: drop queued/playing speech, ask the bot to stop its turn,
   * then reopen the mic (or keep waiting while tools are still running). Nothing from the skipped reply is spoken later.
   */
  async skipReply() {
    if (!['waiting', 'synthesizing', 'speaking'].includes(this.state.status)) return;
    const botId = this.state.botId!;
    const epoch = this.epoch; const turn = ++this.turnEpoch;
    this.queue = []; this.buffered.clear();
    this.io.clear();
    this.heardReply = true;
    this.floor = Math.max(this.floor, ...this.io.snapshot().rows.map((r) => r.seq));
    this.report({ status: 'waiting' });
    try { await this.io.interrupt(botId); }
    catch (e) { if (epoch === this.epoch && turn === this.turnEpoch) this.fail(e); return; }
    if (epoch !== this.epoch || turn !== this.turnEpoch || !this.active) return;
    if (this.io.snapshot().running) this.report({ status: 'waiting' });
    else this.listen();
  }

  stop() {
    this.epoch++; this.turnEpoch++;
    this.abort?.abort(); this.abort = null;
    this.vad.reset(); this.queue = []; this.buffered.clear();
    this.io.mute(true); this.io.clear(); this.io.close();
    this.report({ status: 'off' });
  }

  async cancelTurn() {
    const botId = this.state.botId;
    this.stop();
    if (!botId) return;
    try { await this.io.interrupt(botId); }
    catch (e) { this.report({ status: 'error', error: (e as Error)?.message || 'Could not cancel the chat turn.' }); }
  }

  private fail(e: unknown) {
    this.stop();
    this.report({ status: 'error', error: (e as Error)?.message || 'Local voice failed. No cloud fallback was used.' });
  }
}
