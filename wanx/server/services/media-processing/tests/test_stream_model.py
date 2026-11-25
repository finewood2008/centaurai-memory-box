import hashlib
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest

from wanx_media import stream_model


@pytest.fixture
def recognizers(monkeypatch, tmp_path):
    recognizer = Mock()
    recognizer.is_ready.return_value = False
    recognizer.is_endpoint.return_value = False
    recognizer.get_result.return_value = "请带上相机"
    punctuation = Mock()
    punctuation.add_punctuation.return_value = "请带上相机。"
    sherpa = SimpleNamespace(
        OnlineRecognizer=SimpleNamespace(from_paraformer=Mock(return_value=recognizer)),
        OfflinePunctuation=Mock(return_value=punctuation),
        OfflinePunctuationConfig=Mock(),
        OfflinePunctuationModelConfig=Mock(),
    )
    monkeypatch.setitem(sys.modules, "sherpa_onnx", sherpa)
    monkeypatch.setitem(sys.modules, "numpy", MagicMock())
    monkeypatch.setenv("WANX_MEDIA_STREAMING_MODEL", str(tmp_path))
    monkeypatch.setattr(stream_model.StreamingModel, "configured", lambda self: True)
    return sherpa, recognizer, punctuation


def local_punctuation_model(monkeypatch, tmp_path):
    model = tmp_path / "model.int8.onnx"
    model.write_bytes(b"pinned punctuation model fixture")
    monkeypatch.setenv("WANX_MEDIA_STREAMING_PUNCTUATION_MODEL", str(model))
    monkeypatch.setattr(
        stream_model, "PUNCTUATION_SHA256", hashlib.sha256(model.read_bytes()).hexdigest(),
        raising=False,
    )
    return model


def test_streaming_keeps_partial_text_and_punctuates_only_final(
    recognizers, monkeypatch, tmp_path,
):
    sherpa, recognizer, punctuation = recognizers
    local_punctuation_model(monkeypatch, tmp_path)
    model = stream_model.StreamingModel()
    stream = model.open()
    assert sherpa.OnlineRecognizer.from_paraformer.call_args.kwargs[
        "rule2_min_trailing_silence"
    ] == 0.9
    assert stream.accept(b"\0\0") == [
        {"type": "partial", "segmentId": 0, "text": "请带上相机"}
    ]
    sherpa.OfflinePunctuation.assert_not_called()
    recognizer.is_endpoint.return_value = True
    assert stream.accept(b"\0\0") == [
        {"type": "final", "segmentId": 0, "text": "请带上相机。"}
    ]
    assert stream.accept(b"\0\0") == [
        {"type": "final", "segmentId": 1, "text": "请带上相机。"}
    ]
    sherpa.OfflinePunctuation.assert_called_once()
    assert punctuation.add_punctuation.call_count == 2


@pytest.mark.parametrize("failure", ["missing", "wrong-digest", "initialization", "inference"])
def test_punctuation_failure_keeps_plain_final_and_continues(
    failure, recognizers, monkeypatch, tmp_path,
):
    sherpa, recognizer, punctuation = recognizers
    path = local_punctuation_model(monkeypatch, tmp_path)
    if failure == "missing":
        path.unlink()
    elif failure == "wrong-digest":
        path.write_bytes(b"wrong ONNX fixture")
    elif failure == "initialization":
        sherpa.OfflinePunctuation.side_effect = RuntimeError("cannot initialize")
    else:
        punctuation.add_punctuation.side_effect = RuntimeError("cannot punctuate")
    recognizer.is_endpoint.return_value = True
    stream = stream_model.StreamingModel().open()
    assert stream.accept(b"\0\0") == [
        {"type": "final", "segmentId": 0, "text": "请带上相机"}
    ]
    assert stream.accept(b"\0\0") == [
        {"type": "final", "segmentId": 1, "text": "请带上相机"}
    ]
    assert sherpa.OfflinePunctuation.call_count == int(failure in {"initialization", "inference"})
    assert punctuation.add_punctuation.call_count == int(failure == "inference")


@pytest.mark.parametrize(("text", "candidate"), [
    ("换到 ASR 2.0", "换到 ASR 2 . 0。"),
    ("请用 ASR", "请用 A，SR。"),
    ("请带上相机。", "请带上相机。。"),
])
def test_punctuation_cannot_rewrite_recognized_text(
    text, candidate, recognizers, monkeypatch, tmp_path,
):
    _, recognizer, punctuation = recognizers
    local_punctuation_model(monkeypatch, tmp_path)
    recognizer.get_result.return_value = text
    recognizer.is_endpoint.return_value = True
    punctuation.add_punctuation.return_value = candidate
    stream = stream_model.StreamingModel().open()
    assert stream.accept(b"\0\0") == [
        {"type": "final", "segmentId": 0, "text": text}
    ]
