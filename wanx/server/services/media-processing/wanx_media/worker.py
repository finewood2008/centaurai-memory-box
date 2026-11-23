"""One worker per durable store. Each inference runs in a cancellable local process."""

from __future__ import annotations

from collections.abc import Callable
import fcntl
import json
import logging
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

from . import media, query_encoder
from .store import Store

logger = logging.getLogger(__name__)


class Worker:
    def __init__(self, store: Store, pause_requested: Callable[[], bool] | None = None):
        self.store = store
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.lock = None
        self.hot = query_encoder.HotQueries()
        self.pause_requested = pause_requested
        self.activity = threading.Lock()
        self.executing = False

    def idle(self) -> bool:
        with self.activity:
            return not self.executing

    def start(self):
        self.lock = (self.store.directory / "worker.lock").open("a")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise RuntimeError("Only one worker may use this media store") from None
        # Temporary files left by a power failure belong to this dedicated store.
        for path in self.store.directory.glob("inference-*"):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
        self.store.recover()
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join()
        self.hot.close()
        self.lock.close()

    def loop(self):
        while not self.stop.is_set():
            with self.activity:
                job = None if self.pause_requested and self.pause_requested() else self.store.claim()
                self.executing = job is not None
            if not job:
                self.hot.expire()
                self.stop.wait(0.12)
                continue
            try:
                self.execute(job)
            except media.MediaError as exc:
                self.store.finish(job["id"], error=str(exc))
            except Exception:
                # User media, paths, model output and credentials stay out of logs.
                logger.error("Media worker failed for job %s", job["id"])
                self.store.finish(job["id"], error="INFERENCE_FAILED")
            finally:
                with self.activity:
                    self.executing = False

    def execute(self, job):
        revision = query_encoder.stamp() if job["cap"] == "text.embedding" else None
        if job["cap"] != "text.embedding":
            self.hot.close()
        if revision and self.store.reuse_query(job, revision):
            return
        with tempfile.TemporaryDirectory(
            prefix="inference-", dir=self.store.directory
        ) as tmp:
            work = Path(tmp)
            with self.store.db() as db, (work / "input").open("wb") as file:
                for data in self.store.chunks(db, job["id"]):
                    file.write(data)
            (work / "options").write_text(job["execution_options"] or job["options"])
            # Only Linux offers the required /proc RSS supervision. Other targets
            # keep the same scoped result reuse with a disposable cold process.
            if revision and Path("/proc/self/status").is_file():
                message = self.hot.run(
                    work,
                    revision,
                    lambda: self.stop.is_set() or not self.store.live(job["id"]),
                )
                if message is None:
                    return
                if revision != query_encoder.stamp():
                    self.hot.close()
                    self.store.finish(job["id"], error="MODEL_CHANGED")
                    return
                self.store.finish(job["id"], model_stamp=revision, **message)
                return
            proc = subprocess.Popen(
                [sys.executable, "-m", "wanx_media.worker", str(work), job["cap"]],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"},
            )
            try:
                started = time.monotonic()
                while proc.poll() is None:
                    if self.stop.wait(0.25) or not self.store.live(job["id"]):
                        return
                    if time.monotonic() - started > 7200:
                        self.store.finish(job["id"], error="INFERENCE_TIMEOUT")
                        return
                if proc.returncode or not (work / "output").is_file():
                    self.store.finish(job["id"], error="INFERENCE_FAILED")
                    return
                if (work / "output").stat().st_size > 8 * 1024 * 1024:
                    self.store.finish(job["id"], error="RESULT_LIMIT")
                    return
                message = json.loads((work / "output").read_text())
                if revision and revision != query_encoder.stamp():
                    self.store.finish(job["id"], error="MODEL_CHANGED")
                    return
                self.store.finish(job["id"], model_stamp=revision, **message)
            finally:
                if proc.poll() is None:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                proc.wait()


if __name__ == "__main__":
    work = Path(sys.argv[1])
    try:
        output = {
            "result": media.run(
                sys.argv[2], work / "input", json.loads((work / "options").read_text())
            )
        }
    except media.MediaError as exc:
        output = {"error": str(exc)}
    except Exception:
        output = {"error": "INVALID_MEDIA_OR_MODEL"}
    (work / "output").write_text(json.dumps(output, ensure_ascii=False))
