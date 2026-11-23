"""Operations inside the operator-selected disk folder. All paths are descriptor-relative."""

import base64
import ctypes
import errno
import io
import json
import os
import stat
import time
import uuid
from contextlib import contextmanager

TRASH = ".memobox-trash"
LIMIT = 200 * 1024 * 1024


def name(value):
    if (
        not isinstance(value, str)
        or not value
        or value.endswith((" ", "."))
        or value.startswith(".")
        or len(value.encode()) > 230
        or any(ord(c) < 32 or c in '/\\:*?"<>|' for c in value)
    ):
        raise ValueError("名称无效")
    return value


@contextmanager
def folder(root, rel):
    if not isinstance(rel, str) or len(rel) > 2048:
        raise ValueError("目录无效")
    fd = os.dup(root)
    try:
        for child in rel.split("/") if rel else []:
            name(child)
            sub = os.open(
                child, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
            )
            os.close(fd)
            fd = sub
        yield fd
    finally:
        os.close(fd)


def separate(rel):
    parent, _, leaf = rel.rpartition("/")
    return parent, name(leaf)


def row(rel, st):
    return dict(
        path=rel,
        name=rel.rsplit("/", 1)[-1],
        kind="folder" if stat.S_ISDIR(st.st_mode) else "file",
        size=st.st_size,
        modified=int(st.st_mtime),
        version=f"{st.st_size}-{st.st_mtime_ns}",
    )


def check(fd, leaf, requested):
    st = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
    if (
        not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode))
        or requested != row(leaf, st)["version"]
    ):
        raise ValueError("文件已变化，请刷新。")
    return st


def move(src, old, dst, new):
    # Linux RENAME_NOREPLACE also protects against collisions with other disk clients.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(src, os.fsencode(old), dst, os.fsencode(new), 1):
        err = ctypes.get_errno()
        if err == errno.EEXIST:
            raise ValueError("目标中已有同名文件")
        raise OSError(err, os.strerror(err))


@contextmanager
def opened(root, ref):
    parent, leaf = separate(ref["path"])
    with folder(root, parent) as fd:
        file = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(file, "rb") as stream:
        st = os.fstat(file)
        if not stat.S_ISREG(st.st_mode) or row(leaf, st)["version"] != ref["version"]:
            raise ValueError("文件已变化，请刷新。")
        yield stream, st.st_size


def receive(root, parent, filename, source, size):
    name(filename)
    if not 0 <= size <= LIMIT:
        raise ValueError("单文件最大 200 MB")
    with folder(root, parent) as fd:
        tmp = ".memobox-upload-" + uuid.uuid4().hex
        out = os.open(
            tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd
        )
        try:
            with os.fdopen(out, "wb") as target:
                remaining = size
                while remaining:
                    chunk = source.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise ValueError("文件传输中断")
                    target.write(chunk)
                    remaining -= len(chunk)
                target.flush()
                os.fsync(target.fileno())
            move(fd, tmp, fd, filename)
        finally:
            try:
                os.unlink(tmp, dir_fd=fd)
            except FileNotFoundError:
                pass
    return {"name": filename}


def preview(root, ref):
    from PIL import Image, ImageOps

    with opened(root, ref) as (source, size):
        if size > 40 * 1024 * 1024:
            raise ValueError("图片过大，可下载查看")
        with Image.open(source) as im:
            if im.width * im.height > 50_000_000:
                raise ValueError("图片像素过大，可下载查看")
            width, height = im.size
            im.draft("RGB", (1000, 800))
            im.thumbnail((1000, 800))
            output = io.BytesIO()
            ImageOps.exif_transpose(im).convert("RGB").save(output, "JPEG", quality=80)
        return {
            "image": base64.b64encode(output.getvalue()).decode(),
            "width": width,
            "height": height,
        }


def trashdir(root, create=False):
    if create:
        try:
            os.mkdir(TRASH, 0o700, dir_fd=root)
        except FileExistsError:
            pass
    return os.open(TRASH, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)


def handle(root, op, p):
    parent = p.get("parent", "")
    if op == "disk-list":
        with folder(root, parent) as fd:
            rows = []
            query = p.get("query", "").casefold()
            with os.scandir(fd) as entries:
                for f in entries:
                    if f.name.startswith(".") or query not in f.name.casefold():
                        continue
                    st = f.stat(follow_symlinks=False)
                    if stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode):
                        rows.append(row("/".join(filter(None, (parent, f.name))), st))
            rows.sort(key=lambda f: (f["kind"] != "folder", f["name"].casefold()))
            offset = max(0, int(p.get("offset", 0)))
            usage = os.fstatvfs(fd)
            return {
                "items": rows[offset : offset + 100],
                "total": len(rows),
                "free": usage.f_bavail * usage.f_frsize,
                "capacity": usage.f_blocks * usage.f_frsize,
            }
    if op == "disk-mkdir":
        with folder(root, parent) as fd:
            os.mkdir(name(p["name"]), 0o700, dir_fd=fd)
        return {"ok": True}
    if op == "disk-image":
        return preview(root, p["ref"])
    if op == "disk-trash-list" or op == "disk-restore":
        try:
            trash = trashdir(root)
        except FileNotFoundError:
            if op == "disk-trash-list":
                return {"items": []}
            raise
        try:

            def entry(ident):
                if len(ident) != 32 or any(c not in "0123456789abcdef" for c in ident):
                    raise ValueError("项目无效")
                with os.fdopen(
                    os.open(ident + ".json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=trash)
                ) as info:
                    return json.load(info)

            if op == "disk-trash-list":
                files = set(os.listdir(trash))
                return {
                    "items": [
                        entry(f[:-5])
                        for f in sorted(files)
                        if f.endswith(".json") and f[:-5] in files
                    ]
                }
            item = entry(p["id"])
            parent, leaf = separate(item["path"])
            with folder(root, parent) as fd:
                move(trash, p["id"], fd, leaf)
            os.unlink(p["id"] + ".json", dir_fd=trash)
            return {"ok": True}
        finally:
            os.close(trash)
    ref = p["ref"]
    parent, leaf = separate(ref["path"])
    with folder(root, parent) as fd:
        check(fd, leaf, ref["version"])
        if op == "disk-rename":
            move(fd, leaf, fd, name(p["name"]))
        elif op == "disk-move":
            with folder(root, p["to"]) as dest:
                move(fd, leaf, dest, leaf)
        elif op == "disk-trash":
            trash = trashdir(root, True)
            ident = uuid.uuid4().hex
            try:
                info = dict(id=ident, path=ref["path"], time=int(time.time()))
                with os.fdopen(
                    os.open(
                        ident + ".json",
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600,
                        dir_fd=trash,
                    ),
                    "w",
                ) as out:
                    json.dump(info, out)
                    out.flush()
                    os.fsync(out.fileno())
                move(fd, leaf, trash, ident)
            finally:
                os.close(trash)
        else:
            raise ValueError("未知操作")
    return {"ok": True}
