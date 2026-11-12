"""Offline STT regressions.

Run: python3 tests/local-stt-test.py --managed-runtime -v
Set LOCAL_STT_INTEGRATION=1 for real cached-model silence/noise tests.
Set LOCAL_STT_PHRASE_WAV to a locally synthesized WAV of:
  Please check the local microphone. Keep the first word and the last word. Finish.
to include normal/quiet/multi-window phrase inference. No models are downloaded.
Only generated audio is used, never a physical microphone.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import types
import unittest
import wave
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'server/src/local-stt.py'
spec = importlib.util.spec_from_file_location('local_stt', SCRIPT)
assert spec is not None and spec.loader is not None
stt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stt)


def write_wav(path, seconds, rate=16000):
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b'\x00\x00' * round(seconds * rate))


def run_helper(path, language='en'):
    output = io.StringIO()
    with patch('sys.argv', [str(SCRIPT), str(path), language]), contextlib.redirect_stdout(output):
        stt.main()
    return json.loads(output.getvalue())


class DecoderContractTests(unittest.TestCase):
    """Replace only inference; exercise the real helper, PyAV and WAV frames."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='stt-contract-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.snapshot = self.root / 'models--Systran--faster-whisper-small.en/snapshots/cached'
        self.snapshot.mkdir(parents=True)
        (self.snapshot / 'model.bin').touch()
        (self.snapshot / 'config.json').write_text('{}')
        self.wav = self.root / 'audio.wav'
        write_wav(self.wav, 0.5)
        self.constructor_calls = []
        self.transcribe_calls = []
        constructor_calls = self.constructor_calls
        transcribe_calls = self.transcribe_calls

        class Decoder:
            def __init__(self, *args, **kwargs):
                constructor_calls.append((args, kwargs))

            def transcribe(self, *args, **kwargs):
                transcribe_calls.append((args, kwargs))
                return iter([types.SimpleNamespace(text=' First word.'), types.SimpleNamespace(text=' Last word. ')]), None

        self.addCleanup(patch.stopall)
        patch.dict('sys.modules', {'faster_whisper': types.SimpleNamespace(WhisperModel=Decoder)}).start()
        patch.dict(os.environ, {'HF_HUB_CACHE': str(self.root), 'LOCAL_STT_MODEL': 'small.en', 'HF_HUB_OFFLINE': '1'}).start()

    def test_decoding_does_not_reuse_previous_window_text(self):
        run_helper(self.wav)
        self.assertFalse(self.transcribe_calls[0][1].get('condition_on_previous_text', True))

    def test_vad_preserves_edge_padding_and_brief_replies(self):
        run_helper(self.wav)
        options = self.transcribe_calls[0][1]
        self.assertIs(options['vad_filter'], True)
        self.assertEqual(options['vad_parameters']['speech_pad_ms'], 400)
        self.assertEqual(options['vad_parameters']['min_speech_duration_ms'], 0)
        # No unmeasured higher threshold, fixed energy gate or custom duration
        # cropping: leave Silero's default speech threshold and pause tolerance.
        self.assertNotIn('threshold', options['vad_parameters'])
        self.assertNotIn('clip_timestamps', options)
        self.assertNotIn('max_new_tokens', options)
        self.assertEqual(options['beam_size'], 3)

    def test_collects_every_yielded_segment_in_order(self):
        self.assertEqual(run_helper(self.wav)['text'], 'First word. Last word.')

    def test_model_constructor_is_offline_cpu_int8_local_snapshot(self):
        run_helper(self.wav)
        args, kwargs = self.constructor_calls[0]
        self.assertEqual(args, (str(self.snapshot),))
        self.assertEqual(kwargs, {'device': 'cpu', 'compute_type': 'int8', 'local_files_only': True})

    def test_missing_cache_fails_honestly_without_model_or_network_fallback(self):
        (self.snapshot / 'model.bin').unlink()
        with self.assertRaisesRegex(RuntimeError, 'No cached local Whisper model.*No download or cloud fallback'):
            run_helper(self.wav)
        self.assertEqual(self.constructor_calls, [])
        self.assertEqual(self.transcribe_calls, [])

    def test_model_name_outside_cached_allowlist_is_rejected(self):
        with patch.dict(os.environ, {'LOCAL_STT_MODEL': 'large-v3'}):
            with self.assertRaisesRegex(ValueError, 'installed small.en or base'):
                run_helper(self.wav)
        self.assertEqual(self.constructor_calls, [])

    def test_overlong_source_is_rejected_before_vad_or_model_loading(self):
        write_wav(self.wav, 121)
        with self.assertRaisesRegex(ValueError, 'at most 120 seconds'):
            run_helper(self.wav)
        self.assertEqual(self.constructor_calls, [])

    def test_full_120_seconds_is_accepted_without_cropping(self):
        write_wav(self.wav, 120)
        self.assertEqual(run_helper(self.wav)['text'], 'First word. Last word.')
        self.assertEqual(self.transcribe_calls[0][0], (str(self.wav),))

    def test_empty_audio_stream_is_rejected(self):
        write_wav(self.wav, 0)
        with self.assertRaisesRegex(ValueError, 'contains no audio'):
            run_helper(self.wav)
        self.assertEqual(self.constructor_calls, [])

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg required for streaming WebM fixture')
    def test_webm_without_duration_header_uses_decoded_samples(self):
        import av
        encoded = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(self.wav), '-c:a', 'libopus', '-f', 'webm', 'pipe:1'])
        webm = self.root / 'recording.webm'
        webm.write_bytes(encoded)
        with av.open(str(webm)) as source:
            self.assertIsNone(source.duration)
        self.assertEqual(run_helper(webm)['text'], 'First word. Last word.')

    def test_auto_language_is_passed_as_model_default(self):
        run_helper(self.wav, 'auto')
        self.assertIsNone(self.transcribe_calls[0][1]['language'])


@unittest.skipUnless(os.environ.get('LOCAL_STT_INTEGRATION') == '1', 'Opt-in cached model inference')
class CachedWhisperAudioTests(unittest.TestCase):
    def test_real_silence_returns_no_invented_words(self):
        with tempfile.TemporaryDirectory(prefix='stt-audio-') as directory:
            path = Path(directory) / 'silence.wav'
            write_wav(path, 3)
            self.assertEqual(run_helper(path)['text'], '')

    def test_real_seeded_noise_returns_no_invented_words(self):
        rng = random.Random(714)
        with tempfile.TemporaryDirectory(prefix='stt-noise-') as directory:
            path = Path(directory) / 'noise.wav'
            with wave.open(str(path), 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(struct.pack('<48000h', *(round(rng.gauss(0, 0.008) * 32767) for _ in range(48000))))
            self.assertEqual(run_helper(path)['text'], '')

    @unittest.skipUnless(os.environ.get('LOCAL_STT_PHRASE_WAV'), 'Provide locally generated phonon phrase fixture')
    def test_real_phrase_keeps_quiet_first_and_last_words(self):
        import numpy as np
        from faster_whisper.audio import decode_audio
        source = np.asarray(decode_audio(os.environ['LOCAL_STT_PHRASE_WAV'], sampling_rate=16000, split_stereo=False))
        expected = 'please check the local microphone. keep the first word and the last word. finish.'
        with tempfile.TemporaryDirectory(prefix='stt-phrase-') as directory:
            path = Path(directory) / 'phrase.wav'
            # Include a >30s speech case to exercise independent Whisper windows,
            # not merely repeated phrases that still fit inside one window.
            for name, audio, repetitions in (
                ('normal', source, 1),
                ('quiet with silence', np.concatenate([np.zeros(48000), source * 0.08, np.zeros(48000)]), 1),
                ('multiple windows', np.tile(np.concatenate([source, np.zeros(48000)]), 7), 7),
            ):
                with self.subTest(audio=name):
                    with wave.open(str(path), 'wb') as output:
                        output.setnchannels(1)
                        output.setsampwidth(2)
                        output.setframerate(16000)
                        output.writeframes((np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes())
                    text = run_helper(path)['text'].lower()
                    self.assertEqual(text, ' '.join([expected] * repetitions))


if __name__ == '__main__':
    if '--managed-runtime' in sys.argv:
        # Match the app's bootstrap without changing live Hermes configuration.
        sys.argv.remove('--managed-runtime')
        runtime = json.loads(subprocess.check_output(['hermes', '--print-runtime-command'], text=True))
        marker = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"
        if len(runtime) != 4 or runtime[1:3] != ['-I', '-c'] or not runtime[3].endswith(marker):
            raise RuntimeError('Unsupported Hermes runtime command')
        code = runtime[3][:-len(marker)] + "sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')"
        os.execve(runtime[0], [*runtime[:3], code, str(Path(__file__).resolve()), *sys.argv[1:]], {**os.environ, 'HF_HUB_OFFLINE': '1'})
    unittest.main()
