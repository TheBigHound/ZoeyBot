"""Offline-only ZoeyBot transcription; invoked in Hermes's managed interpreter.
Never reads or changes Hermes voice settings. Never downloads model weights.
"""
import json
import os
import sys
from pathlib import Path


def find_snapshot():
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
    return name, snapshot


def load_model(snapshot):
    from faster_whisper import WhisperModel
    return WhisperModel(str(snapshot), device='cpu', compute_type='int8', local_files_only=True)


def check_duration(path):
    import av
    with av.open(path) as source:
        # MediaRecorder WebM commonly has no duration header. Count decoded
        # samples rather than rejecting valid recordings or trusting metadata.
        duration = 0.0
        for frame in source.decode(audio=0):
            duration += frame.samples / frame.sample_rate
            if duration > 120:
                raise ValueError('Recording must be at most 120 seconds')
        if duration == 0:
            raise ValueError('Recording contains no audio')


def transcribe(model, path, language=None):
    lang = language if language and language != 'auto' else None
    # Without VAD, even digital silence can decode as invented words. Keep
    # conservative 400ms edge padding and accept short speech (no minimum
    # duration gate) so first/last words and brief replies are not trimmed.
    segments, _ = model.transcribe(
        path, language=lang, beam_size=3, vad_filter=True,
        vad_parameters={'speech_pad_ms': 400, 'min_speech_duration_ms': 0},
        # Independent windows avoid feeding an erroneous/silent segment back
        # into later decoding; all yielded segments are still collected below.
        condition_on_previous_text=False,
    )
    return ' '.join(s.text.strip() for s in segments).strip()[:16000]


def serve(snapshot):
    """Keep the model loaded: one JSON request per stdin line, one JSON reply per stdout line.

    Loading Whisper costs several seconds; a process per recording paid that on every voice turn.
    """
    model = load_model(snapshot)
    out = sys.stdout
    out.write(json.dumps({'ready': True}) + '\n')
    out.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
            check_duration(request['path'])
            reply = {'id': request_id, 'text': transcribe(model, request['path'], request.get('language'))}
        except Exception as error:  # one bad recording must not end the worker
            reply = {'id': request_id, 'error': str(error) or error.__class__.__name__}
        out.write(json.dumps(reply) + '\n')
        out.flush()


def main():
    name, snapshot = find_snapshot()
    if sys.argv[1:] == ['--check']:
        print(json.dumps({'available': True, 'model': name}))
        return
    if sys.argv[1:] == ['--serve']:
        serve(snapshot)
        return
    check_duration(sys.argv[1])
    model = load_model(snapshot)
    print(json.dumps({'text': transcribe(model, sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)}))


if __name__ == '__main__':
    main()
