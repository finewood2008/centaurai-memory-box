"""Regression tests for file recognition on the original recording timeline."""

import hashlib
from types import SimpleNamespace
from unittest.mock import Mock
import wave

import pytest

from wanx_media.media import MediaError, transcribe


@pytest.fixture
def whisper(tmp_path, monkeypatch):
    pytest.importorskip("av")
    faster_whisper = pytest.importorskip("faster_whisper")
    model = tmp_path / "whisper"
    model.mkdir()
    (model / "model.bin").write_bytes(b"fixture-model")
    monkeypatch.setenv("WANX_MEDIA_ASR_MODEL", str(model))
    recognize = Mock()
    constructor = Mock(return_value=SimpleNamespace(transcribe=recognize))
    monkeypatch.setattr(faster_whisper, "WhisperModel", constructor)
    return constructor, recognize


def write_pcm(path, data):
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(data)


def test_offline_asr_uses_vad_and_preserves_original_timestamps(tmp_path, whisper):
    constructor, recognize = whisper
    path = tmp_path / "meeting.wav"
    original = bytes(10 * 32000) + b"\x00\x40" * 3200
    write_pcm(path, original)
    recognize.return_value = (
        iter([SimpleNamespace(start=10.0, end=10.18, text=" 好 ")]),
        SimpleNamespace(language="zh"),
    )

    result = transcribe(path)

    constructor.assert_called_once_with(
        str(tmp_path / "whisper"),
        device="cpu",
        compute_type="int8",
        local_files_only=True,
    )
    assert recognize.call_args.kwargs["vad_filter"] is True
    samples = recognize.call_args.args[0]
    assert len(samples) == 163200
    assert not samples[:160000].any()
    assert (samples[160000:] == 0.5).all()
    assert result == {
        "model": "whisper",
        "modelSha256": hashlib.sha256(b"fixture-model").hexdigest(),
        "language": "zh",
        "segments": [{"id": "0", "startMs": 10000, "endMs": 10180, "text": "好"}],
        "text": "好",
    }
    with wave.open(str(path), "rb") as audio:
        assert audio.readframes(audio.getnframes()) == original


def test_offline_asr_all_silence_reports_no_speech(tmp_path, whisper):
    _, recognize = whisper
    path = tmp_path / "silent.wav"
    write_pcm(path, bytes(32000))
    recognize.return_value = (iter([]), SimpleNamespace(language="en"))

    with pytest.raises(MediaError, match="^AUDIO_NO_SPEECH$"):
        transcribe(path)


def test_offline_asr_clamps_vad_padding_and_ignores_empty_text(tmp_path, whisper):
    _, recognize = whisper
    path = tmp_path / "padded.wav"
    write_pcm(path, bytes(32000))
    recognize.return_value = (
        iter([
            SimpleNamespace(start=0.2, end=0.3, text=" "),
            SimpleNamespace(start=0.7, end=1.18, text="收到"),
        ]),
        SimpleNamespace(language="zh"),
    )

    assert transcribe(path)["segments"] == [
        {"id": "0", "startMs": 700, "endMs": 1000, "text": "收到"}
    ]
