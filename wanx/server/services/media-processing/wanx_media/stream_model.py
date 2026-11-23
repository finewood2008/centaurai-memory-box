"""CPU-only Paraformer with one incremental recognizer stream per caller."""

from __future__ import annotations

from collections.abc import Callable
from importlib.util import find_spec
import logging
import os
from pathlib import Path
import re
from threading import Lock
from typing import Any

from .media import fingerprint_file


SAMPLE_RATE = 16_000
MODEL_ID = "sherpa-onnx-streaming-paraformer-bilingual-zh-en-int8"
MODEL_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt")
# sherpa-onnx may exit the process when an unrelated ONNX lacks punctuation metadata.
PUNCTUATION_SHA256 = "65a3fb9f5ad7bfb96bf69e0dc4481df97f6ee60513c1d94ce981ba6effd524b1"
PUNCTUATION_MARKS = "，。！？；：、"
REMOVE_PUNCTUATION = str.maketrans("", "", PUNCTUATION_MARKS)
PUNCTUATION_IN_ASCII_WORD = re.compile(rf"[a-zA-Z0-9][{PUNCTUATION_MARKS}]+[a-zA-Z0-9]")
logger = logging.getLogger(__name__)


class StreamingModel:
    def __init__(self) -> None:
        directory = os.environ.get("WANX_MEDIA_STREAMING_MODEL")
        self.directory = Path(directory) if directory else None
        punctuation = os.environ.get("WANX_MEDIA_STREAMING_PUNCTUATION_MODEL")
        self.punctuation_file = Path(punctuation) if punctuation else None
        self.punctuation: Any = None
        self.lock = Lock()
        self.recognizer: Any = None

    def configured(self) -> bool:
        directory = self.directory
        if directory is None:
            return False
        try:
            for name in MODEL_FILES:
                path = directory / name
                if not path.is_file() or path.stat().st_size == 0:
                    return False
        except OSError:
            return False
        return all(find_spec(name) is not None for name in ("numpy", "sherpa_onnx", "websockets"))

    def open(self) -> StreamingRecognizer:
        if self.directory is None or not self.configured():
            raise RuntimeError("Streaming ASR model is unavailable")

        import numpy as np
        import sherpa_onnx

        with self.lock:
            if self.recognizer is None:
                encoder, decoder, tokens = (str(self.directory / name) for name in MODEL_FILES)
                self.recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
                    encoder=encoder,
                    decoder=decoder,
                    tokens=tokens,
                    sample_rate=SAMPLE_RATE,
                    num_threads=1,
                    provider="cpu",
                    enable_endpoint_detection=True,
                    rule2_min_trailing_silence=0.9,
                    rule3_min_utterance_length=30.0,
                )
            return StreamingRecognizer(self.recognizer, self.lock, np, self._punctuate)

    def _punctuate(self, text: str) -> str:
        model = self.punctuation_file
        if model is None:
            return text
        try:
            if self.punctuation is None:
                if (
                    not model.is_absolute()
                    or not model.is_file()
                    or fingerprint_file(model) != PUNCTUATION_SHA256
                ):
                    raise ValueError("Unrecognized streaming punctuation model")
                from sherpa_onnx import (
                    OfflinePunctuation,
                    OfflinePunctuationConfig,
                    OfflinePunctuationModelConfig,
                )

                self.punctuation = OfflinePunctuation(
                    OfflinePunctuationConfig(
                        model=OfflinePunctuationModelConfig(
                            ct_transformer=str(model), num_threads=1, provider="cpu"
                        )
                    )
                )
            candidate = self.punctuation.add_punctuation(text)
            # Keep the recognized words and their spacing, particularly acronyms and numbers.
            if (
                candidate.translate(REMOVE_PUNCTUATION) == text
                and not PUNCTUATION_IN_ASCII_WORD.search(candidate)
            ):
                return candidate
            return text
        except (ImportError, OSError, RuntimeError, ValueError):
            logger.warning("Streaming punctuation unavailable; continuing with plain subtitles")
            self.punctuation_file = None
            self.punctuation = None
            return text


class StreamingRecognizer:
    def __init__(
        self, recognizer: Any, lock: Any, numpy: Any, punctuate: Callable[[str], str]
    ) -> None:
        self.recognizer = recognizer
        self.lock = lock
        self.numpy = numpy
        self.punctuate = punctuate
        self.stream = recognizer.create_stream()
        self.segment_id = 0
        self.partial = ""
        self.has_audio = False
        self.finished = False

    def accept(self, pcm: bytes) -> list[dict]:
        if self.finished or not pcm:
            return []
        self.has_audio = True
        samples = self.numpy.frombuffer(pcm, dtype="<i2").astype(self.numpy.float32)
        samples *= 1 / 32768
        with self.lock:
            self.stream.accept_waveform(SAMPLE_RATE, samples)
            self._decode()
            if self.recognizer.is_endpoint(self.stream):
                result = self._final()
                self.recognizer.reset(self.stream)
                self.has_audio = False
                return result
            text = self.recognizer.get_result(self.stream)
        if text == self.partial:
            return []
        self.partial = text
        return [{"type": "partial", "segmentId": self.segment_id, "text": text}]

    def finish(self) -> list[dict]:
        if self.finished:
            return []
        self.finished = True
        if not self.has_audio:
            return []
        with self.lock:
            return self._final(end_of_input=True)

    def _decode(self) -> None:
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)

    def _final(self, *, end_of_input: bool = False) -> list[dict]:
        # Paraformer needs right context to commit the last tokens. Match the
        # upstream online microphone example by padding at an utterance boundary.
        silence = self.numpy.zeros(SAMPLE_RATE, dtype=self.numpy.float32)
        self.stream.accept_waveform(SAMPLE_RATE, silence)
        if end_of_input:
            self.stream.input_finished()
        self._decode()
        text = self.recognizer.get_result(self.stream)
        had_partial = bool(self.partial)
        self.partial = ""
        if not text:
            return [{"type": "partial", "segmentId": self.segment_id, "text": ""}] if had_partial else []
        event = {"type": "final", "segmentId": self.segment_id, "text": self.punctuate(text)}
        self.segment_id += 1
        return [event]
