"""Offline-only ZoeyBot transcription; invoked in Hermes's managed interpreter.
Never reads or changes Hermes voice settings. Never downloads model weights.
"""
import json
import os
import sys
from pathlib import Path


def main():
    from faster_whisper import WhisperModel

    name = os.environ.get('LOCAL_STT_MODEL', 'small.en')
    if name not in ('small.en', 'base'):
        raise ValueError('LOCAL_STT_MODEL must name an installed small.en or base model')
    root = Path(os.environ.get('HF_HUB_CACHE', str(Path.home() / '.cache/huggingface/hub')))
    repo = root / ('models--Systran--faster-whisper-' + name)
    ref = repo / 'refs/main'
    candidates = [repo / 'snapshots' / ref.read_text().strip()] if ref.is_file() else sorted((repo / 'snapshots').glob('*'))
    snapshot = next((p for p in candidates if (p / 'model.bin').is_file() and (p / 'config.json').is_file()), None)
    if not snapshot:
        raise RuntimeError('No cached local Whisper model. No download or cloud fallback attempted.')
    if sys.argv[1:] == ['--check']:
        print(json.dumps({'available': True, 'model': name}))
        return
    import av
    with av.open(sys.argv[1]) as source:
        # MediaRecorder WebM commonly has no duration header. Count decoded
        # samples rather than rejecting valid recordings or trusting metadata.
        duration = 0.0
        for frame in source.decode(audio=0):
            duration += frame.samples / frame.sample_rate
            if duration > 120:
                raise ValueError('Recording must be at most 120 seconds')
        if duration == 0:
            raise ValueError('Recording contains no audio')
    model = WhisperModel(str(snapshot), device='cpu', compute_type='int8', local_files_only=True)
    lang = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != 'auto' else None
    # Without VAD, even digital silence can decode as invented words. Keep
    # conservative 400ms edge padding and accept short speech (no minimum
    # duration gate) so first/last words and brief replies are not trimmed.
    segments, _ = model.transcribe(
        sys.argv[1], language=lang, beam_size=3, vad_filter=True,
        vad_parameters={'speech_pad_ms': 400, 'min_speech_duration_ms': 0},
        # Independent windows avoid feeding an erroneous/silent segment back
        # into later decoding; all yielded segments are still collected below.
        condition_on_previous_text=False,
    )
    text = ' '.join(s.text.strip() for s in segments).strip()
    print(json.dumps({'text': text[:16000]}))


if __name__ == '__main__':
    main()
