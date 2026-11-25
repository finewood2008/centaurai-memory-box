"""Read-only browsing of USB filesystems mounted for the box's desktop user."""
import base64
import io
import json
import os
import pwd
import stat
import subprocess
import volume_text
from contextlib import contextmanager
from pathlib import Path

PAGE = 100


def mounted_volumes():
    columns = "NAME,TRAN,TYPE,UUID,LABEL,MOUNTPOINTS,MAJ:MIN"
    output = subprocess.check_output(["lsblk", "-J", "-e", "7", "-o", columns], timeout=4)
    owner = pwd.getpwuid(os.getuid()).pw_name
    roots = (Path("/run/media") / owner, Path("/media") / owner)
    volumes = {}
    for disk in json.loads(output)["blockdevices"]:
        if disk["tran"] != "usb":
            continue
        for device in [disk, *disk.get("children", [])]:
            for target in device.get("mountpoints") or []:
                if not target or Path(target).parent not in roots:
                    continue
                major, minor = map(int, device["maj:min"].split(":"))
                volume_id = f'{device["uuid"] or device["name"]}@{major}-{minor}'
                volumes[volume_id] = (device["label"] or Path(target).name, target, os.makedev(major, minor))
    return volumes


@contextmanager
def open_item(mount, device, path, *, directory):
    if not isinstance(path, str) or len(path) > 4096:
        raise ValueError("路径无效")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(mount, flags | os.O_DIRECTORY)
    try:
        parts = path.split("/") if path else []
        for i, part in enumerate(parts):
            if not part or part.startswith(".") or os.fstat(fd).st_dev != device:
                raise ValueError("路径不属于此硬盘")
            next_fd = os.open(part, flags | (os.O_DIRECTORY if directory or i < len(parts)-1 else 0), dir_fd=fd)
            os.close(fd)
            fd = next_fd
        st = os.fstat(fd)
        if st.st_dev != device or not (stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode)):
            raise ValueError("硬盘或文件已变化")
        yield fd
    finally:
        os.close(fd)


def handle(op, data):
    volumes = mounted_volumes()
    if op == "volumes":
        return [{"id": key, "name": value[0]} for key, value in volumes.items()]
    if op not in ("folder", "preview", "text-open", "text-save"):
        raise ValueError("无效的读取操作")
    volume = volumes.get(data.get("volume"))
    if not volume:
        raise ValueError("SPACE_VOLUME_OFFLINE")
    _, mount, device = volume
    if op in ("text-open", "text-save"):
        return volume_text.edit(open_item, mount, device, op, data)
    path = data.get("path", "")
    with open_item(mount, device, path, directory=op == "folder") as fd:
        if op == "folder":
            rows = []
            with os.scandir(fd) as entries:
                for entry in entries:
                    if entry.name.startswith("."):
                        continue
                    try:
                        st = entry.stat(follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    if st.st_dev == device and (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                        rows.append({"name": entry.name, "folder": stat.S_ISDIR(st.st_mode), "size": st.st_size})
            rows.sort(key=lambda row: (not row["folder"], row["name"].casefold(), row["name"]))
            offset = max(0, int(data.get("offset", 0)))
            return {"items": rows[offset:offset+PAGE], "total": len(rows), "pageSize": PAGE}
        size = os.fstat(fd).st_size
        suffix = Path(path).suffix.lower()
        if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"} and size <= 40 * 1024**2:
            from PIL import Image, ImageOps
            with os.fdopen(os.dup(fd), "rb") as source, Image.open(source) as im:
                if im.width * im.height > 50_000_000:
                    raise ValueError("图片过大")
                im.thumbnail((1200, 900))
                output = io.BytesIO()
                ImageOps.exif_transpose(im).convert("RGB").save(output, "JPEG", quality=82)
                return {"image": base64.b64encode(output.getvalue()).decode()}
        if suffix in {".txt", ".md", ".json", ".log", ".csv", ".yaml", ".yml"}:
            return {"text": os.read(fd, 65536).decode("utf-8-sig", errors="replace"), "truncated": size > 65536}
        return {"size": size}
