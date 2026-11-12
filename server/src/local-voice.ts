// Local-only speech. No cloud fallback and no imitation realtime session tokens.
import { execFile } from 'node:child_process';
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

export async function synthesizeLocal(text: string, codec: 'wav' | 'pcm' = 'wav'): Promise<Buffer> {
  if (!text.trim() || text.length > 400) throw new Error('Speech text must contain 1 to 400 characters');
  if (speechBusy) throw new Error('Local speech is busy; try again shortly');
  speechBusy = true;
  let dir: string | undefined;
  try {
    const result = await run(process.env.LOCAL_TTS_BIN || 'ollama', ['run', process.env.LOCAL_TTS_MODEL || 'phonon', '--voice', process.env.LOCAL_TTS_VOICE || 'Zoey', '--', text], { encoding: 'buffer', timeout: 120_000, maxBuffer: MAX_AUDIO_BYTES, env: { ...process.env, OLLAMA_NOHISTORY: '1' } });
    const wav = result.stdout;
    validateWav(wav);
    if (codec === 'wav') return wav;
    const root = process.env.LOCAL_VOICE_TMPDIR || join(homedir(), '.cache', 'bot-hq', 'voice');
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
  return settings.VOICE_PROVIDER === 'local' || settings.HQ_VM === '1' ? 'local' : 'xai';
}
const sttScript = fileURLToPath(new URL('../src/local-stt.py', import.meta.url));
let sttRuntime: string[] | undefined;
async function runStt(args: string[]) {
  if (!sttRuntime) {
    const r = await run(process.env.LOCAL_STT_HERMES_BIN || 'hermes', ['--print-runtime-command'], { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const runtime: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(runtime) || runtime.length !== 4 || !runtime.every((v) => typeof v === 'string') || runtime[1] !== '-I' || runtime[2] !== '-c') throw new Error('Unsupported Hermes runtime command');
    const marker = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
    if (!runtime[3].endsWith(marker)) throw new Error('Unsupported Hermes bootstrap command');
    sttRuntime = [runtime[0], '-I', '-c', runtime[3].slice(0, -marker.length) + "sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')"];
  }
  return run(sttRuntime[0], [...sttRuntime.slice(1), sttScript, ...args], { timeout: 120_000, maxBuffer: 1024 * 1024, encoding: 'utf8', env: { ...process.env, HF_HUB_OFFLINE: '1' } });
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
    const root = process.env.LOCAL_VOICE_TMPDIR || join(homedir(), '.cache', 'bot-hq', 'voice');
    await mkdir(root, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(join(root, 'stt-'));
    const input = join(dir, 'recording');
    await writeFile(input, audio, { mode: 0o600 });
    const r = await runStt([input, language.split('-')[0]]);
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
    voices: [{ id: process.env.LOCAL_TTS_VOICE || 'Zoey', name: process.env.LOCAL_TTS_VOICE || 'Zoey', gender: 'female' }],
    languages: [{ code: 'auto', name: 'Model default (English)' }, { code: 'en', name: 'English' }],
    speeds: [1],
    callDisabledReason: 'Local voice supports preview and dictation, not live voice calls. Use the microphone to dictate into chat.',
  };
}
