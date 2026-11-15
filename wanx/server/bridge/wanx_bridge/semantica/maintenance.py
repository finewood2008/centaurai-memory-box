"""Persistent local admission fence for a fixed Semantica migration task.

The updater calls this module as the WANX service user. No network endpoint can
create or remove a fence. Shared request locks drain already admitted requests
before the exclusive acquire persists the fence; it never expires on its own.
"""

from __future__ import annotations

import json
import os
import re
import stat
import time
import uuid
from contextlib import ExitStack, contextmanager
from pathlib import Path

try:
    import fcntl
except ImportError:  # Non-POSIX development Hosts cannot execute box migrations.
    fcntl = None

CAPABILITY = "wanx.semantica-maintenance.v1"
_MARKER = "semantica-maintenance.json"
_LOCK = "semantica-maintenance.lock"
_CONTROL = "semantica-maintenance-control.lock"
_BINDING_FIELDS = {"schemaVersion", "operationId", "attemptGeneration", "planDigest"}


class MaintenanceError(Exception):
    def __init__(self, code="SEMANTICA_MAINTENANCE"):
        self.code = code
        super().__init__(code)


def _need(value, code="SEMANTICA_MAINTENANCE"):
    if not value:
        raise MaintenanceError(code)


def _binding(value):
    _need(isinstance(value, dict) and set(value) == _BINDING_FIELDS)
    _need(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    _need(
        type(value["attemptGeneration"]) is int
        and 1 <= value["attemptGeneration"] <= 9007199254740991
    )
    _need(
        isinstance(value["operationId"], str)
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value["operationId"])
    )
    _need(
        isinstance(value["planDigest"], str) and re.fullmatch(r"[a-f0-9]{64}", value["planDigest"])
    )
    return dict(value)


def _root(home):
    _need(fcntl is not None, "SEMANTICA_MAINTENANCE_PLATFORM_UNSUPPORTED")
    root = Path(os.path.abspath(home))
    for path in (root, *root.parents):
        info = path.lstat()
        _need(not stat.S_ISLNK(info.st_mode))
    info = root.lstat()
    _need(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o022)
    return root


def _private(info):
    _need(
        stat.S_ISREG(info.st_mode)
        and info.st_uid == os.geteuid()
        and stat.S_IMODE(info.st_mode) == 0o600
        and info.st_nlink == 1
    )


def _sync(root):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _pairs(items):
    result = {}
    for key, value in items:
        _need(key not in result)
        result[key] = value
    return result


def _read(root):
    try:
        fd = os.open(root / _MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        _private(os.fstat(fd))
        raw = os.read(fd, 4097)
        _need(len(raw) <= 4096)
        return _binding(json.loads(raw, object_pairs_hook=_pairs))
    finally:
        os.close(fd)


def read(home, binding=None):
    try:
        value = _read(_root(home))
        if binding is not None and value is not None:
            _need(value == _binding(binding), "SEMANTICA_MAINTENANCE_CONFLICT")
        return (
            {"schemaVersion": 1, "status": "held", "binding": value}
            if value
            else {"schemaVersion": 1, "status": "idle"}
        )
    except MaintenanceError:
        raise
    except (OSError, ValueError, TypeError):
        raise MaintenanceError() from None


@contextmanager
def _lock(root, *, exclusive=False, timeout=0, control=False):
    fd = os.open(
        root / (_CONTROL if control else _LOCK),
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
        0o600,
    )
    try:
        _private(os.fstat(fd))
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                _need(time.monotonic() < deadline, "SEMANTICA_MAINTENANCE_BUSY")
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        yield
    finally:
        os.close(fd)


def acquire(home, binding, *, timeout=310):
    try:
        binding, root = _binding(binding), _root(home)
        _need(type(timeout) in (int, float) and 0 <= timeout <= 310)
        deadline = time.monotonic() + timeout
        with _lock(root, exclusive=True, timeout=timeout, control=True):
            current = _read(root)
            if current is not None:
                _need(current == binding, "SEMANTICA_MAINTENANCE_CONFLICT")
            else:
                temporary = root / (".semantica-maintenance-" + uuid.uuid4().hex + ".tmp")
                try:
                    fd = os.open(
                        temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
                    )
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(
                            json.dumps(binding, sort_keys=True, separators=(",", ":")).encode()
                        )
                        stream.flush()
                        os.fsync(stream.fileno())
                    # All authorized writers hold the control mutex. Rename
                    # leaves one link even if the process dies before cleanup.
                    _need(not (root / _MARKER).exists() and not (root / _MARKER).is_symlink())
                    os.rename(temporary, root / _MARKER)
                finally:
                    temporary.unlink(missing_ok=True)
                _sync(root)
            _sync(root)  # Replay also durably adopts a prior publish-before-fsync cut.
            # Publish first so continuous polling cannot starve the exclusive
            # drain. Existing admitted requests retain their shared locks.
            # A timeout deliberately leaves the persistent fence closed.
            with _lock(root, exclusive=True, timeout=max(0, deadline - time.monotonic())):
                _need(_read(root) == binding, "SEMANTICA_MAINTENANCE_CONFLICT")
            return {"schemaVersion": 1, "status": "held", "binding": binding}
    except MaintenanceError:
        raise
    except (OSError, ValueError, TypeError):
        raise MaintenanceError() from None


def release(home, binding):
    try:
        binding, root = _binding(binding), _root(home)
        with _lock(root, exclusive=True, control=True):
            current = _read(root)
            if current is not None:
                _need(current == binding, "SEMANTICA_MAINTENANCE_CONFLICT")
                (root / _MARKER).unlink()
                _sync(root)
        return {"schemaVersion": 1, "status": "released"}
    except MaintenanceError:
        raise
    except (OSError, ValueError, TypeError):
        raise MaintenanceError() from None


def migration_maintenance(home, binding, action):
    _need(action in {"acquire", "read", "release"})
    return {"acquire": acquire, "read": read, "release": release}[action](home, binding)


@contextmanager
def request_guard(home, method, path):
    readonly_probe = method == "GET" and path in {"/capabilities", "/api/integration/capabilities"}
    existing_job = method == "POST" and path == "/api/integration/processing/authorize"
    if readonly_probe or existing_job:
        # The latter only authorizes an existing running job. Keeping it live
        # lets admitted work finish before the updater's subsequent idle check.
        yield
        return
    if fcntl is None:
        root = Path(home) if home is not None else Path.home() / ".octop"
        _need(not (root / _MARKER).exists() and not (root / _MARKER).is_symlink())
        yield
        return
    stack = ExitStack()
    try:
        if home is None:
            # Hand-built clients have a read-only fallback. All production
            # config-file/desktop/model/MCP callers supply their actual root.
            root = Path.home() / ".octop"
            if root.exists() or root.is_symlink():
                _need(read(root)["status"] == "idle")
        elif Path(home).exists() or Path(home).is_symlink():
            root = Path(home)
            if os.geteuid() == 0 and root.lstat().st_uid != 0:
                # An independently installed root gateway may read the WANX
                # service user's fence but must not create root-owned locks
                # there. Such a split-UID installation is not migration-ready;
                # preserve ordinary traffic when no migration is in progress.
                _need(not root.is_symlink())
                _need(not (root / _MARKER).exists() and not (root / _MARKER).is_symlink())
            else:
                root = _root(home)
                _need(_read(root) is None)
                stack.enter_context(_lock(root))
                _need(_read(root) is None)
        # An unconfigured Host has no root/fence to consult. Migration acquire
        # requires an existing protected root and therefore cannot proceed yet.
    except MaintenanceError:
        stack.close()
        raise
    except (OSError, ValueError, TypeError):
        stack.close()
        raise MaintenanceError() from None
    try:
        yield
    finally:
        # Exceptions from an admitted business request retain their own type;
        # only admission failures are translated to a maintenance response.
        stack.close()


class SemanticaMaintenanceMiddleware:
    """Pure ASGI wrapper keeps the drain lock through upload and response close."""

    def __init__(self, app, *, home):
        self.app, self.home = app, home

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not (
            path == "/api/semantica" or path.startswith("/api/semantica/")
        ):
            return await self.app(scope, receive, send)
        target = "/api/integration" + path.removeprefix("/api/semantica")
        guard = request_guard(self.home, scope["method"], target)
        try:
            guard.__enter__()
        except MaintenanceError:
            body = b'{"code":"SEMANTICA_MAINTENANCE","message":null}'
            await send(
                {
                    "type": "http.response.start",
                    "status": 503,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"cache-control", b"no-store"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        try:
            return await self.app(scope, receive, send)
        finally:
            guard.__exit__(None, None, None)
