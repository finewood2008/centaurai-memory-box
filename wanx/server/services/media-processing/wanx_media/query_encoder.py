"""A Linux-only, bounded, cancellable warm text encoder; no user vectors are held here."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from . import media

IDLE_SECONDS = 45
RSS_LIMIT_MIB = 1536


def stamp():
    root = media.model_dir("text.embedding")
    if root is None or not root.is_dir():
        return None
    # The installer's sealed model tree is read-only. Include every model, tokenizer
    # and config file and its resolved inode, size and nanosecond timestamps.
    state = [str(root.resolve()), "query-encoder-v1"]
    for package in ("transformers", "torch", "tokenizers"):
        try:
            state.append(importlib.metadata.version(package))
        except importlib.metadata.PackageNotFoundError:
            return None
    try:
        for path in sorted(root.iterdir()):
            if path.suffix not in (".json", ".txt", ".safetensors", ".model"):
                continue
            info = path.stat()
            state.append(
                (
                    path.name,
                    info.st_dev,
                    info.st_ino,
                    info.st_size,
                    info.st_mtime_ns,
                    info.st_ctime_ns,
                )
            )
    except FileNotFoundError:
        return None
    return hashlib.sha256(json.dumps(state).encode()).hexdigest()


class HotQueries:
    def __init__(self):
        self.proc = None
        self.revision = None
        self.last_used = 0

    def close(self):
        if self.proc is None:
            return
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.proc.wait()
        self.proc.stdin.close()
        self.proc = None
        self.revision = None

    def expire(self):
        if self.proc is not None and time.monotonic() - self.last_used >= IDLE_SECONDS:
            self.close()

    def run(self, work, revision, cancelled):
        if self.proc is not None and (
            self.proc.poll() is not None or self.revision != revision
        ):
            self.close()
        if self.proc is None:
            self.proc = subprocess.Popen(
                [sys.executable, "-m", "wanx_media.query_encoder"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"},
            )
            self.revision = revision
        proc = self.proc
        output = work / "query-result.json"
        try:
            proc.stdin.write((json.dumps(str(work)) + "\n").encode())
            proc.stdin.flush()
            started = time.monotonic()
            while not output.exists():
                if cancelled():
                    self.close()
                    return None
                if proc.poll() is not None:
                    raise media.MediaError("QUERY_ENCODER_FAILED")
                if time.monotonic() - started > 120:
                    raise media.MediaError("INFERENCE_TIMEOUT")
                try:
                    with open(f"/proc/{proc.pid}/status") as handle:
                        for line in handle:
                            if (
                                line.startswith("VmRSS:")
                                and int(line.split()[1]) > RSS_LIMIT_MIB * 1024
                            ):
                                raise media.MediaError("QUERY_MEMORY_LIMIT")
                except FileNotFoundError:
                    raise media.MediaError("QUERY_ENCODER_FAILED") from None
                time.sleep(0.06)
            if output.stat().st_size > 128 * 1024:
                raise media.MediaError("RESULT_LIMIT")
            self.last_used = time.monotonic()
            return json.loads(output.read_text())
        except BaseException:
            self.close()
            raise


def main():
    # One trusted parent supplies managed temporary directories. Keep only model
    # weights/tokenizer between requests; result artifacts belong to the job.
    encode = media.load_query_encoder()
    for line in sys.stdin:
        work = Path(json.loads(line))
        try:
            result = {"result": encode(media.read_query(work / "input"))}
        except media.MediaError as exc:
            result = {"error": str(exc)}
        except Exception:
            result = {"error": "INVALID_MEDIA_OR_MODEL"}
        tmp = work / "query-result.tmp"
        tmp.write_text(json.dumps(result, ensure_ascii=False))
        os.replace(tmp, work / "query-result.json")
        del result


if __name__ == "__main__":
    main()
