import type { Row } from '@shared/types';

export interface ReadAloudSnapshot {
  botId: string | null;
  generation: number;
  loaded: boolean;
  rows: Row[];
}

export interface ReadAloudState {
  enabled: boolean;
  status: 'off' | 'enabling' | 'ready' | 'synthesizing' | 'speaking';
  error: string | null;
}

export interface ReadAloudAudio {
  /** Called synchronously by enable(), while the user gesture is still active. */
  activate(): Promise<void>;
  synthesize(botId: string, text: string): Promise<Int16Array>;
  play(pcm: Int16Array): Promise<void>;
  clear(): void;
  close(): void;
}

function speechChunks(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    let end = Math.min(400, remaining.length);
    if (end < remaining.length) {
      const boundary = remaining.slice(0, end).lastIndexOf(' ');
      if (boundary > 200) end = boundary;
      // The backend cap is measured in UTF-16 code units, not code points.
      if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    }
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  return chunks;
}

/** Only live row events enter this queue; REST history snapshots never trigger speech. */
export class LocalReadAloud {
  enabled = false;
  private botId: string | null = null;
  private generation = 0;
  private floor = 0;
  private seen = new Set<number>();
  private queue: string[] = [];
  private busy = false;
  private epoch = 0;

  constructor(private audio: ReadAloudAudio, private onChange: (state: ReadAloudState) => void = () => {}) {}

  private report(status: ReadAloudState['status'], error: string | null = null) {
    this.onChange({ enabled: this.enabled, status, error });
  }

  private baseline(snapshot: ReadAloudSnapshot) {
    this.botId = snapshot.botId;
    this.generation = snapshot.generation;
    this.floor = Math.max(0, ...snapshot.rows.map((r) => r.seq));
    this.seen.clear();
  }

  async enable(snapshot: ReadAloudSnapshot, confirmation?: string) {
    if (!snapshot.loaded || !snapshot.botId) { this.report('off', 'Wait for the chat to load before enabling local voice.'); return; }
    this.baseline(snapshot);
    const epoch = ++this.epoch;
    this.report('enabling');
    try {
      await this.audio.activate();
      if (epoch !== this.epoch) return;
      this.enabled = true;
      this.report('ready');
      if (confirmation?.trim()) {
        this.queue.push(...speechChunks(confirmation));
        void this.drain();
      }
    } catch (e) {
      if (epoch === this.epoch) this.fail(e);
    }
  }

  /** Drop obsolete audio immediately. Pending local inference settles before the next request. */
  cancel() {
    this.epoch++;
    this.queue = [];
    this.audio.clear();
    this.report(this.enabled ? 'ready' : 'off');
  }

  disable() {
    this.enabled = false;
    this.cancel();
    this.audio.close();
  }

  observe(snapshot: ReadAloudSnapshot) {
    if (snapshot.botId !== this.botId) { this.disable(); return; }
    if (snapshot.generation !== this.generation) {
      this.cancel();
      this.baseline(snapshot);
    }
  }

  receive(botId: string, generation: number, rows: Row[]) {
    if (!this.enabled || botId !== this.botId || generation !== this.generation) return;
    const newestUser = Math.max(0, ...rows.filter((r) => r.body.type === 'message' && r.body.role === 'user').map((r) => r.seq));
    if (newestUser > this.floor) {
      this.floor = newestUser;
      this.cancel();
    }
    for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
      const b = row.body;
      if (row.seq <= this.floor || this.seen.has(row.seq) || b.type !== 'message' || b.role !== 'assistant' || b.streaming) continue;
      this.seen.add(row.seq);
      if (b.text.trim()) this.queue.push(...speechChunks(b.text));
    }
    void this.drain();
  }

  private fail(e: unknown) {
    this.disable();
    this.report('off', (e as Error)?.message || 'Local speech failed. No cloud fallback was used.');
  }

  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.enabled && this.queue.length) {
        const epoch = this.epoch;
        this.report('synthesizing');
        try {
          // Do not abort the HTTP request: disconnecting does not cancel server-side phonon.
          // Await its completion, discard obsolete audio, then start the next request serially.
          const pcm = await this.audio.synthesize(this.botId!, this.queue.shift()!);
          if (!this.enabled || epoch !== this.epoch) continue;
          this.report('speaking');
          await this.audio.play(pcm);
        } catch (e) {
          if (this.enabled && epoch === this.epoch) this.fail(e);
        }
      }
    } finally {
      this.busy = false;
      if (this.enabled) this.report('ready');
    }
  }
}
