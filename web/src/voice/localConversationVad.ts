/** PCM16 mono at 24kHz. Silence-only and sub-200ms noises never become chat messages. */
export class UtteranceDetector {
  private pre: Int16Array[] = [];
  private frames: Int16Array[] = [];
  private samples = 0;
  private voiced = 0;
  private silent = 0;

  reset() {
    this.pre = []; this.frames = [];
    this.samples = this.voiced = this.silent = 0;
  }

  push(pcm: Int16Array): Int16Array | null {
    if (!pcm.length) return null;
    let sum = 0;
    for (const sample of pcm) sum += (sample / 32768) ** 2;
    const voice = Math.sqrt(sum / pcm.length) >= 0.012;
    if (!this.frames.length && !voice) {
      this.pre.push(pcm.slice());
      while (this.pre.reduce((n, frame) => n + frame.length, 0) > 5760) this.pre.shift();
      return null;
    }
    if (!this.frames.length) {
      this.frames = this.pre;
      this.pre = [];
      this.samples = this.frames.reduce((n, frame) => n + frame.length, 0);
    }
    this.frames.push(pcm.slice());
    this.samples += pcm.length;
    if (voice) { this.voiced += pcm.length; this.silent = 0; }
    else this.silent += pcm.length;
    if (this.silent < 24000 && this.samples < 480000) return null;
    let result: Int16Array | null = null;
    if (this.voiced >= 4800) {
      result = new Int16Array(Math.min(this.samples, 480000));
      let offset = 0;
      for (const frame of this.frames) {
        const slice = frame.subarray(0, result.length - offset);
        result.set(slice, offset); offset += slice.length;
      }
    }
    this.reset();
    return result;
  }
}
