"""Optimistic, atomic updates to existing UTF-8 documents on a mounted volume."""
import hashlib
import json
import os
import re
import stat
import threading
import uuid
from pathlib import Path

LIMIT = 16 * 1024 * 1024
FORMATS = {".txt", ".md", ".csv", ".json", ".log", ".yaml", ".yml"}
SAVE_LOCK = threading.Lock()


def reject_constant(value):
    raise ValueError("Invalid JSON constant: " + value)


def read_text(fd, volume, path):
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_size > LIMIT:
        raise ValueError("SPACE_TEXT_TOO_LARGE")
    with os.fdopen(os.dup(fd), "rb") as source:
        raw = source.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError("SPACE_TEXT_TOO_LARGE")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeError:
        raise ValueError("SPACE_TEXT_INVALID") from None
    if "\x00" in text:
        raise ValueError("SPACE_TEXT_INVALID")
    stamp = (volume, path, st.st_dev, st.st_ino, st.st_ctime_ns, st.st_mtime_ns)
    version = hashlib.sha256(repr(stamp).encode() + raw).hexdigest()
    ending = re.search(r"\r\n|[\r\n]", text)
    return st, {"text": text.replace("\r\n", "\n").replace("\r", "\n"),
                "version": version, "bom": raw.startswith(b"\xef\xbb\xbf"),
                "eol": ending[0] if ending else "\n"}


def edit(open_item, mount, device, op, data):
    path = data["path"]
    if not isinstance(path, str) or Path(path).suffix.lower() not in FORMATS:
        raise ValueError("SPACE_TEXT_UNSUPPORTED")
    parent, _, leaf = path.rpartition("/")
    with open_item(mount, device, parent, directory=True) as directory, SAVE_LOCK:
        if not leaf or leaf.startswith("."):
            raise ValueError("SPACE_TEXT_UNSUPPORTED")
        # Check the original file's write access as well as the directory's.
        flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
        with os.fdopen(os.open(leaf, flags, dir_fd=directory), "rb") as original:
            fd = original.fileno()
            st = os.fstat(fd)
            if st.st_dev != device or not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1:
                raise ValueError("SPACE_TEXT_READ_ONLY")
            st, current = read_text(fd, data["volume"], path)
            if op == "text-open":
                return current
            if data.get("expected") != current["version"]:
                raise ValueError("SPACE_VERSION_CONFLICT")
            text = data.get("text")
            if not isinstance(text, str) or "\x00" in text or "\r" in text:
                raise ValueError("SPACE_TEXT_INVALID")
            if Path(path).suffix.lower() == ".json":
                try:
                    json.loads(text, parse_constant=reject_constant)
                except (ValueError, RecursionError):
                    raise ValueError("SPACE_TEXT_JSON_INVALID") from None
            raw = text.replace("\n", current["eol"]).encode("utf-8")
            if current["bom"]:
                raw = b"\xef\xbb\xbf" + raw
            if len(raw) > LIMIT:
                raise ValueError("SPACE_TEXT_TOO_LARGE")
            tmp = ".memobox-edit-" + uuid.uuid4().hex
            output = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=directory)
            try:
                with os.fdopen(output, "wb") as target:
                    target.write(raw)
                    target.flush()
                    if os.fstat(output).st_gid != st.st_gid:
                        os.fchown(output, -1, st.st_gid)
                    if stat.S_IMODE(os.fstat(output).st_mode) != stat.S_IMODE(st.st_mode):
                        os.fchmod(output, stat.S_IMODE(st.st_mode))
                    for key in os.listxattr(fd):
                        os.setxattr(output, key, os.getxattr(fd, key))
                    os.fsync(output)
                latest = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
                if (latest.st_ino, latest.st_dev, latest.st_ctime_ns) != (st.st_ino, st.st_dev, st.st_ctime_ns):
                    raise ValueError("SPACE_VERSION_CONFLICT")
                os.replace(tmp, leaf, src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                try:
                    os.unlink(tmp, dir_fd=directory)
                except FileNotFoundError:
                    pass
            return {"saved": True}
