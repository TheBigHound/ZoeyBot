// Local-only speech. No cloud fallback and no imitation realtime session tokens.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
// Ollama consumes piped stdin even when a prompt argument is supplied.
const run: typeof exec = ((...args: Parameters<typeof exec>) => {
  const pending = exec(...args);
  pending.child.stdin?.end();
  return pending;
}) as typeof exec;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
let speechBusy = false;

export function validateWav(wav: Buffer): void {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV output from local speech model');
  let hasFormat = false;
  let hasAudio = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'fmt ' && size >= 16 && at + 24 <= wav.length) hasFormat = wav.readUInt16LE(at + 10) > 0 && wav.readUInt32LE(at + 12) > 0;
    if (id === 'data' && size > 0 && at + 8 < wav.length) hasAudio = true;
    at += 8 + size + (size % 2);
  }
  if (!hasFormat || !hasAudio) throw new Error('Invalid WAV format or missing audio data');
}

const defaultVoice = () => process.env.LOCAL_TTS_VOICE || 'Zoey';

// Voices the local speech model ships with (`ollama show <model>` lists them under "Voices"). Cached for an hour;
// an unreadable listing leaves only the default voice available rather than failing the options call.
let voiceList: { at: number; voices: string[] } | undefined;
export async function localVoices(): Promise<string[]> {
  if (voiceList && Date.now() - voiceList.at < 3600_000) return voiceList.voices;
  let voices = [defaultVoice()];
  try {
    const r = await run(process.env.LOCAL_TTS_BIN || 'ollama', ['show', process.env.LOCAL_TTS_MODEL || 'phonon'], { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const lines = String(r.stdout).split('\n');
    const start = lines.findIndex((l) => l.trim() === 'Voices');
    if (start >= 0) {
      const found: string[] = [];
      for (const l of lines.slice(start + 1)) {
        if (!l.trim()) break;
        found.push(l.trim());
      }
      if (found.length) voices = found.includes(defaultVoice()) ? [defaultVoice(), ...found.filter((v) => v !== defaultVoice())] : [defaultVoice(), ...found];
    }
  } catch { /* listing unavailable: default voice only */ }
  voiceList = { at: Date.now(), voices };
  return voices;
}

/** The bot's chosen voice when the local model has it, else the default. Cloud voice ids (luna, rex...) fall back. */
export async function resolveLocalVoice(voice: string | null | undefined): Promise<string> {
  const voices = await localVoices();
  return voice && voices.includes(voice) ? voice : defaultVoice();
}

export async function synthesizeLocal(text: string, codec: 'wav' | 'pcm' = 'wav', voice?: string): Promise<Buffer> {
  if (!text.trim() || text.length > 400) throw new Error('Speech text must contain 1 to 400 characters');
  if (speechBusy) throw new Error('Local speech is busy; try again shortly');
  speechBusy = true;
  let dir: string | undefined;
  try {
    const result = await run(process.env.LOCAL_TTS_BIN || 'ollama', ['run', process.env.LOCAL_TTS_MODEL || 'phonon', '--voice', await resolveLocalVoice(voice), '--', text], { encoding: 'buffer', timeout: 120_000, maxBuffer: MAX_AUDIO_BYTES, env: { ...process.env, OLLAMA_NOHISTORY: '1' } });
    const wav = result.stdout;
    validateWav(wav);
    if (codec === 'wav') return wav;
    const root = process.env.LOCAL_VOICE_TMPDIR || join(homedir(), '.cache', 'zoeybot', 'voice');
    await mkdir(root, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(join(root, 'tts-'));
    const input = join(dir, 'speech.wav');
    await writeFile(input, wav, { mode: 0o600 });
    const pcm = await run(process.env.LOCAL_FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-i', input, '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', timeout: 30_000, maxBuffer: MAX_AUDIO_BYTES });
    if (!pcm.stdout.length || pcm.stdout.length % 2) throw new Error('Invalid PCM output');
    return pcm.stdout;
  } finally {
    speechBusy = false;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
export function voiceMode(settings: NodeJS.ProcessEnv = process.env): 'local' | 'xai' {
  return settings.VOICE_PROVIDER === 'local' || settings.HQ_HOST === '1' ? 'local' : 'xai';
}
const sttScript = fileURLToPath(new URL('../src/local-stt.py', import.meta.url));
let sttRuntime: string[] | undefined;
async function sttCommand(): Promise<string[]> {
  if (!sttRuntime) {
    const r = await run(process.env.LOCAL_STT_HERMES_BIN || 'hermes', ['--print-runtime-command'], { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const runtime: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(runtime) || runtime.length !== 4 || !runtime.every((v) => typeof v === 'string') || runtime[1] !== '-I' || runtime[2] !== '-c') throw new Error('Unsupported Hermes runtime command');
    const marker = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
    if (!runtime[3].endsWith(marker)) throw new Error('Unsupported Hermes bootstrap command');
    sttRuntime = [runtime[0], '-I', '-c', runtime[3].slice(0, -marker.length) + "sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')"];
  }
  return sttRuntime;
}
async function runStt(args: string[]) {
  const command = await sttCommand();
  return run(command[0], [...command.slice(1), sttScript, ...args], { timeout: 120_000, maxBuffer: 1024 * 1024, encoding: 'utf8', env: { ...process.env, HF_HUB_OFFLINE: '1' } });
}

// One long-lived Whisper process. Loading the model costs seconds, and a process per recording paid that on
// every voice turn. Requests are one JSON line each; replies come back in order (callers are already serial).
type SttWorker = { child: ChildProcessWithoutNullStreams; ready: Promise<void>; pending: Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }> };
let sttWorker: SttWorker | undefined;
let sttRequest = 0;
async function startSttWorker(): Promise<SttWorker> {
  const command = await sttCommand();
  const child = spawn(command[0], [...command.slice(1), sttScript, '--serve'], { env: { ...process.env, HF_HUB_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  // Do not hold a short-lived process (tests, scripts) open; an in-flight request keeps it alive through its timer.
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
  const pending: SttWorker['pending'] = new Map();
  let stderr = '';
  let announce: (() => void) | undefined;
  let refuse: ((e: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => { announce = resolve; refuse = reject; });
  ready.catch(() => {});
  const worker: SttWorker = { child, ready, pending };
  const fail = (e: Error) => {
    if (sttWorker === worker) sttWorker = undefined;
    refuse?.(e);
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
  child.on('error', (e) => fail(e));
  child.on('exit', (code) => fail(new Error(`Local transcription worker stopped (${code ?? 'signal'}). ${stderr.trim().split('\n').pop() ?? ''}`.trim())));
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: { ready?: boolean; id?: number; text?: string; error?: string };
    try { message = JSON.parse(line); } catch { return; }
    if (message.ready) { announce?.(); return; }
    const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id as number);
    if (typeof message.text === 'string') waiter.resolve(message.text);
    else waiter.reject(new Error(message.error || 'Invalid local transcription response'));
  });
  return worker;
}
/** Start loading the model now so the first voice turn does not wait for it. Never throws. */
export function warmLocalStt(): void {
  if (sttWorker || process.env.LOCAL_STT_WORKER === '0') return;
  void startSttWorker().then((w) => { sttWorker ??= w; if (sttWorker !== w) w.child.kill(); }).catch(() => {});
}
/** Stop the worker (tests, shutdown). */
export function stopLocalStt(): void {
  sttWorker?.child.kill();
  sttWorker = undefined;
}
async function transcribeWithWorker(path: string, language: string): Promise<string> {
  // The deadline timer is created first: it is what keeps a short-lived process alive while the model loads.
  let worker: SttWorker | undefined;
  let expire: ((e: Error) => void) | undefined;
  const expired = new Promise<never>((_, reject) => { expire = reject; });
  expired.catch(() => {});
  const timer = setTimeout(() => { worker?.child.kill(); expire?.(new Error('Local transcription timed out')); }, 120_000);
  try {
    sttWorker ??= await startSttWorker();
    worker = sttWorker;
    await Promise.race([worker.ready, expired]);
    const id = ++sttRequest;
    const active = worker;
    const reply = new Promise<string>((resolve, reject) => { active.pending.set(id, { resolve, reject }); });
    active.child.stdin.write(JSON.stringify({ id, path, language }) + '\n');
    return await Promise.race([reply, expired]);
  } finally {
    clearTimeout(timer);
  }
}
let sttCheck: { at: number; available: boolean } | undefined;
let transcriptionBusy = false;
async function localSttAvailable(): Promise<boolean> {
  if (sttCheck && Date.now() - sttCheck.at < 60_000) return sttCheck.available;
  let available = false;
  try {
    const r = await runStt(['--check']);
    available = JSON.parse(r.stdout).available === true;
  } catch { /* Missing installed runtime/weights: explicitly unavailable, never cloud fallback. */ }
  sttCheck = { at: Date.now(), available };
  if (available) warmLocalStt();
  return available;
}

export async function transcribeLocal(audio: Buffer, language = 'auto'): Promise<string> {
  if (!audio.length) throw new Error('Recording is empty');
  if (audio.length > MAX_AUDIO_BYTES) throw new Error('Recording too long');
  if (language !== 'auto' && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) throw new Error('Invalid language');
  if (transcriptionBusy) throw new Error('Local transcription is busy; try again shortly');
  transcriptionBusy = true;
  let dir: string | undefined;
  try {
    if (!(await localSttAvailable())) throw new Error('Local transcription unavailable: installed Hermes runtime and cached Whisper model required');
    const root = process.env.LOCAL_VOICE_TMPDIR || join(homedir(), '.cache', 'zoeybot', 'voice');
    await mkdir(root, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(join(root, 'stt-'));
    const input = join(dir, 'recording');
    await writeFile(input, audio, { mode: 0o600 });
    const lang = language.split('-')[0];
    if (process.env.LOCAL_STT_WORKER !== '0') return await transcribeWithWorker(input, lang);
    const r = await runStt([input, lang]);
    const output = JSON.parse(r.stdout) as { text?: string };
    if (typeof output.text !== 'string') throw new Error('Invalid local transcription response');
    return output.text;
  } finally {
    transcriptionBusy = false;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

export async function localVoiceOptions() {
  return {
    provider: 'local',
    capabilities: { tts: true, stt: await localSttAvailable(), realtime: false, calls: false },
    voices: (await localVoices()).map((id) => ({ id, name: id, gender: id === defaultVoice() ? 'female' : 'unknown' })),
    languages: [{ code: 'auto', name: 'Model default (English)' }, { code: 'en', name: 'English' }],
    speeds: [1],
    callDisabledReason: 'Realtime (interruptible) calls are not available locally. Use the turn-based voice conversation: the waveform button in the message box.',
  };
}
