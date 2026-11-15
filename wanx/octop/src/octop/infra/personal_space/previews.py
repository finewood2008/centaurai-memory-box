"""Private, version-bound Office previews. Originals are never modified.

Conversions run without network access or access to the service's data directory.
The HTTP adapter must reauthorize the original before every status/content read.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from .service import CHUNK_SIZE, SpaceError, _safe_file

OFFICE = {".ppt", ".pptx", ".doc", ".docx"}
MAX_BYTES = 64 * 1024 * 1024
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="space-preview")
_lock = threading.Lock()
_jobs: dict[str, Future[tuple[str, int] | None]] = {}


def converter() -> str:
    candidates = [os.environ.get("WANX_PREVIEW_SOFFICE", "")]
    if sys.platform == "darwin":
        candidates.append("/Applications/LibreOffice.app/Contents/MacOS/soffice")
        candidates.append(str(Path.home() / "Applications/LibreOffice.app/Contents/MacOS/soffice"))
    candidates += [shutil.which("libreoffice") or "", shutil.which("soffice") or ""]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            executable = Path(candidate).resolve()
            if sys.platform == "darwin" and executable.suffix == ".sh":
                continue
            return str(executable)
    raise SpaceError("SPACE_PREVIEW_CONVERTER_UNAVAILABLE", 503)


def _command(
    binary: str,
    work: Path,
    suffix: str,
    font_cache: Path | None = None,
    socket_dir: Path | None = None,
) -> list[str]:
    """No unsandboxed fallback for uploaded Office documents."""
    font_cache = font_cache or work / "font-cache"
    socket_dir = socket_dir or work
    base = work if sys.platform == "darwin" else Path("/work")
    args = [
        binary,
        "-env:UserInstallation=" + (base / "profile").as_uri(),
        "-env:OSL_SOCKET_PATH=" + (str(socket_dir) if sys.platform == "darwin" else "/tmp"),
        "--headless",
        "--norestore",
        "--nodefault",
        "--nofirststartwizard",
        "--convert-to",
        "pdf:impress_pdf_Export" if suffix in {".ppt", ".pptx"} else "pdf:writer_pdf_Export",
        "--outdir",
        str(base / "output"),
        str(base / ("input" + suffix)),
    ]
    if sys.platform == "darwin":
        app = next((p for p in Path(binary).parents if p.suffix == ".app"), Path(binary).parent)
        paths = [
            work,
            font_cache,
            socket_dir,
            app,
            Path("/System"),
            Path("/usr"),
            Path("/bin"),
            Path("/private/etc"),
            Path("/Library/Fonts"),
            Path("/private/var/db/dyld"),
            Path("/private/preboot/Cryptexes/OS"),
            Path.home() / "Library/Fonts",
        ]
        import json

        reads = " ".join("(subpath " + json.dumps(str(p.resolve())) + ")" for p in paths)
        # Literal ancestor directories permit path resolution, not their files.
        ancestors = {p for path in (work, font_cache, app) for p in path.parents}
        directories = " ".join("(literal " + json.dumps(str(p)) + ")" for p in ancestors)
        policy = (
            "(version 1)(deny default)(allow process-fork sysctl-read "
            "mach-lookup ipc-posix* signal)(allow file-read-metadata)"
            f"(allow file-read* {directories})"
            f'(allow file-read* {reads})(allow file-read* (literal "/") (literal "/dev/null") '
            '(literal "/dev/urandom") (literal "/dev/random"))'
            f'(allow file-write* (subpath {json.dumps(str(work))}) (subpath {json.dumps(str(font_cache))}) (subpath {json.dumps(str(socket_dir))}) (literal "/dev/null"))'
            f"(allow file-map-executable {reads})(allow process-exec (subpath {json.dumps(str(app))}))"
            f"(allow network-bind network-inbound network-outbound (subpath {json.dumps(str(socket_dir))}))"
        )
        sandbox = shutil.which("sandbox-exec")
        if sandbox:
            return [sandbox, "-p", policy, *args]
    elif sys.platform.startswith("linux"):
        sandbox = shutil.which("bwrap")
        if sandbox:
            mounts = [
                str(p)
                for p in map(
                    Path,
                    ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/fonts", "/etc/ld.so.cache"),
                )
                if p.exists()
            ]
            if not binary.startswith("/usr/"):
                mounts.append(str(Path(binary).parent.parent))
            binds = [v for p in mounts for v in ("--ro-bind", p, p)]
            return [
                sandbox,
                "--unshare-all",
                "--die-with-parent",
                "--new-session",
                *binds,
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--tmpfs",
                "/tmp",
                "--bind",
                str(work),
                "/work",
                "--bind",
                str(font_cache),
                "/font-cache",
                "--chdir",
                "/work",
                *args,
            ]
    raise SpaceError("SPACE_PREVIEW_SANDBOX_UNAVAILABLE", 503)


def convert_pdf(source: bytes, suffix: str, destination: Path) -> None:
    binary = converter()
    font_cache = destination.parent / "font-cache"
    font_cache.mkdir(exist_ok=True, mode=0o700)
    if font_cache.is_symlink():
        raise SpaceError("SPACE_UNSAFE_STORAGE", 409)
    with (
        tempfile.TemporaryDirectory(prefix="office-", dir=destination.parent) as temporary,
        tempfile.TemporaryDirectory(prefix="wx-", dir="/tmp") as sockets,
    ):
        work = Path(temporary).resolve()
        (work / "output").mkdir()
        (work / "profile/user").mkdir(parents=True)
        # Highest macro security; never update linked documents on load.
        (work / "profile/user/registrymodifications.xcu").write_text(
            '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
            '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>'
            '<item oor:path="/org.openoffice.Office.Common/Load">'
            '<prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item>'
            "</oor:items>",
            encoding="utf-8",
        )
        (work / ("input" + suffix)).write_bytes(source)
        home = str(work) if sys.platform == "darwin" else "/work"
        (work / "fonts.conf").write_text(
            '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">'
            "<fontconfig><dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir>"
            "<dir>/usr/share/fonts</dir><cachedir>"
            + escape(str(font_cache) if sys.platform == "darwin" else "/font-cache")
            + "</cachedir></fontconfig>",
            encoding="utf-8",
        )
        environment = {
            k: v for k, v in os.environ.items() if k in {"PATH", "LANG", "LC_ALL", "SYSTEMROOT"}
        }
        environment.update(
            HOME=home,
            TMPDIR=home,
            XDG_CACHE_HOME=home,
            SAL_USE_VCLPLUGIN="svp",
            FONTCONFIG_FILE=home + "/fonts.conf",
        )
        try:
            process = subprocess.Popen(
                _command(binary, work, suffix, font_cache, Path(sockets).resolve()),
                env=environment,
                cwd=work,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            try:
                process.wait(timeout=120)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise SpaceError("SPACE_PREVIEW_TIMEOUT", 504) from None
        except OSError as error:
            raise SpaceError("SPACE_PREVIEW_CONVERTER_UNAVAILABLE", 503) from error
        output = work / "output/input.pdf"
        if process.returncode or not output.is_file():
            raise SpaceError("SPACE_PREVIEW_CONVERSION_FAILED", 422)
        if output.stat().st_size > MAX_BYTES:
            raise SpaceError("SPACE_PREVIEW_TOO_LARGE", 413)
        with output.open("rb") as handle:
            if handle.read(5) != b"%PDF-":
                raise SpaceError("SPACE_PREVIEW_CONVERSION_FAILED", 422)
        os.replace(output, destination)


class DocumentPreview:
    def __init__(self, root: Path, entry: dict[str, Any]):
        self.entry = entry
        self.suffix = Path(entry["name"]).suffix.lower()
        if entry["kind"] != "file" or self.suffix not in OFFICE:
            raise SpaceError("SPACE_PREVIEW_DOWNLOAD", 415)
        if entry["size"] > MAX_BYTES:
            raise SpaceError("SPACE_PREVIEW_TOO_LARGE", 413)
        self.cache = root / ".document-previews"
        self.cache.mkdir(mode=0o700, exist_ok=True)
        if self.cache.is_symlink():
            raise SpaceError("SPACE_UNSAFE_STORAGE", 409)
        identity = f"{entry['id']}:{entry['version']}:{entry['digest']}:{self.suffix}"
        self.path = self.cache / (hashlib.sha256(identity.encode()).hexdigest() + ".pdf")
        _safe_file(self.path, missing=True)

    def _prune(self) -> None:
        # Bounded private cache; original documents never participate in cleanup.
        files = sorted(self.cache.glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True)
        total = 0
        for file in files:
            total += file.stat().st_size
            if file != self.path and (
                total > 512 * 1024 * 1024 or time.time() - file.stat().st_mtime > 7 * 86400
            ):
                file.unlink(missing_ok=True)

    def prepare(self, read: Callable[[int, int], bytes]) -> dict[str, Any]:
        with _lock:
            key = str(self.path)
            for name, job in list(_jobs.items()):
                if job.done() and name != key and len(_jobs) > 64:
                    del _jobs[name]
            if self.path.exists():
                return self.status()
            previous = _jobs.get(key)
            if previous and not previous.done():
                return {"state": "processing"}
            if sum(not job.done() for job in _jobs.values()) >= 4:
                raise SpaceError("SPACE_PREVIEW_BUSY", 429)

            def create() -> tuple[str, int] | None:
                try:
                    raw = b"".join(
                        read(i, min(CHUNK_SIZE, self.entry["size"] - i))
                        for i in range(0, self.entry["size"], CHUNK_SIZE)
                    )
                    if (
                        len(raw) != self.entry["size"]
                        or hashlib.sha256(raw).hexdigest() != self.entry["digest"]
                    ):
                        raise SpaceError("SPACE_REMOTE_FILE_CHANGED", 409)
                    convert_pdf(raw, self.suffix, self.path)
                    self._prune()
                except SpaceError as error:
                    return error.code, error.status
                except OSError:
                    return "SPACE_STORAGE_UNAVAILABLE", 503
                except Exception:
                    return "SPACE_PREVIEW_CONVERSION_FAILED", 422
                # Retain only an error code, never a traceback containing document bytes.
                return None

            _jobs[key] = _pool.submit(create)
        return {"state": "processing"}

    def status(self) -> dict[str, Any]:
        _safe_file(self.path, missing=True)
        if self.path.exists():
            raw = self.path.read_bytes()
            return {
                "state": "ready",
                "type": "application/pdf",
                "size": len(raw),
                "digest": hashlib.sha256(raw).hexdigest(),
                "sourceVersion": self.entry["version"],
            }
        job = _jobs.get(str(self.path))
        if job and job.done():
            error = job.result()
            if error:
                raise SpaceError(*error)
            return {"state": "missing"}
        return {"state": "processing" if job else "missing"}

    def content(self, offset: int, length: int) -> bytes:
        if self.status()["state"] != "ready":
            raise SpaceError("SPACE_PREVIEW_NOT_READY", 409)
        with self.path.open("rb") as handle:
            handle.seek(offset)
            return handle.read(length)
