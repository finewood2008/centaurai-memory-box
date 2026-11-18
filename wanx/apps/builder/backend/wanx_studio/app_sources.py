"""Editable standard renderer sources; platform files are never model output."""

import re
import shutil
import tempfile
from pathlib import Path

from .contracts import StudioError

MAX_FILES = 64
MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024
SOURCE_PATH = re.compile(
    r"app/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:html|mjs|js|css|json|svg|txt)"
)
RESERVED = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.IGNORECASE)


def source_path(name: str) -> bool:
    return (
        isinstance(name, str)
        and len(name) <= 180
        and bool(SOURCE_PATH.fullmatch(name))
        and not any(RESERVED.match(part) for part in name.split("/"))
    )


def validate_sources(files: dict[str, str]) -> None:
    if not isinstance(files, dict) or len(files) > MAX_FILES:
        raise StudioError("DEVKIT_SOURCE_LIMIT", 422)
    portable = set()
    total = 0
    for name, content in files.items():
        if not source_path(name) or name.lower() in portable:
            raise StudioError("DEVKIT_SOURCE_PATH_DENIED", 422)
        portable.add(name.lower())
        if not isinstance(content, str) or len(content.encode()) > MAX_FILE_BYTES:
            raise StudioError("DEVKIT_SOURCE_LIMIT", 422)
        total += len(content.encode())
    if total > MAX_TOTAL_BYTES:
        raise StudioError("DEVKIT_SOURCE_LIMIT", 422)


def read_sources(workspace: Path) -> dict[str, str]:
    app = workspace / "app"
    if app.is_symlink() or not app.is_dir():
        raise StudioError("DEVKIT_SOURCE_PATH_DENIED", 422)
    files = {}
    for path in sorted(app.rglob("*")):
        if path.is_symlink():
            raise StudioError("DEVKIT_SOURCE_PATH_DENIED", 422)
        if path.is_file() and source_path(path.relative_to(workspace).as_posix()):
            if path.stat().st_size > MAX_FILE_BYTES:
                raise StudioError("DEVKIT_SOURCE_LIMIT", 422)
            files[path.relative_to(workspace).as_posix()] = path.read_text(
                encoding="utf-8"
            )
    validate_sources(files)
    return files


def apply_sources(
    workspace: Path, files: dict[str, str], *, replace: bool = False
) -> None:
    validate_sources(files)
    existing = read_sources(workspace)
    final = files if replace else existing | files
    validate_sources(final)
    if not {"app/host.html", "app/host.mjs"} <= final.keys():
        raise StudioError("DEVKIT_SOURCE_REQUIRED", 422)
    # Stage a complete tree before swapping it in. This also makes case-only
    # file/directory renames portable on case-insensitive desktops.
    opaque = {
        path.relative_to(workspace).as_posix(): path
        for path in (workspace / "app").rglob("*")
        if path.is_file() and not source_path(path.relative_to(workspace).as_posix())
    }
    names = {}
    for name in [*opaque, *final]:
        parts = name.split("/")
        for index in range(1, len(parts) + 1):
            prefix = "/".join(parts[:index])
            previous = names.setdefault(prefix.lower(), prefix)
            if previous != prefix:
                raise StudioError("DEVKIT_SOURCE_PATH_DENIED", 422)
    with tempfile.TemporaryDirectory(prefix=".renderer-", dir=workspace) as directory:
        staged = Path(directory) / "new"
        staged.mkdir()
        for name, source in opaque.items():
            target = staged / name.removeprefix("app/")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        for name, content in final.items():
            target = staged / name.removeprefix("app/")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        backup = Path(directory) / "old"
        (workspace / "app").rename(backup)
        try:
            staged.rename(workspace / "app")
        except BaseException:
            backup.rename(workspace / "app")
            raise
