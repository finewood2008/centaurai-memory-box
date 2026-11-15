"""Format generated marketing posters for NSIS; no creative image editing.

Pillow and the SVG renderer are maintainer-only regeneration dependencies. Windows
packaging consumes the checked-in BMP/AVI files without either dependency.
"""

from pathlib import Path
import subprocess
import tempfile
import struct

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "installer"
POSTERS = OUT / "posters"
_rendered = tempfile.TemporaryDirectory(prefix="memobox-installer-")
POSTERS = Path(_rendered.name)
subprocess.run(["node", str(ROOT / "tools" / "render-installer-posters.mjs"), str(POSTERS)], check=True)
OUT.mkdir(parents=True, exist_ok=True)


def place_artwork(image, source, box):
    art = Image.open(source).convert("RGB")
    x, y, width, height = box
    art.thumbnail((width, height), Image.Resampling.LANCZOS)
    image.paste(art, (x + (width - art.width) // 2, y + (height - art.height) // 2))


def save(image, name):
    image.convert("RGB").save(OUT / name, "BMP")


for index, name in enumerate(("memory", "space", "my-ai"), 1):
    card = Image.new("RGB", (720, 400), "#F2EBE2")
    place_artwork(card, POSTERS / f"{name}.png", (12, 12, 696, 376))
    save(card, f"feature-{index}.bmp")

overview = Image.new("RGB", (720, 190), "#FCF9F5")
for n, name in enumerate(("memory", "space", "my-ai")):
    place_artwork(overview, POSTERS / f"{name}.png", (n * 240 + 6, 8, 228, 174))
save(overview, "overview.bmp")

sidebar = Image.new("RGB", (164, 314), "#F2EBE2")
logo = Image.open(ROOT / "resources" / "icon.png").convert("RGBA")
logo.thumbnail((102, 102), Image.Resampling.LANCZOS)
sidebar.paste(logo, ((164 - logo.width) // 2, 22), logo)
for n, name in enumerate(("memory", "space", "my-ai")):
    place_artwork(sidebar, POSTERS / f"{name}.png", (12, 138 + n * 55, 140, 49))
save(sidebar, "sidebar.bmp")

header = Image.new("RGB", (150, 57), "#FCF9F5")
logo.thumbnail((48, 48), Image.Resampling.LANCZOS)
header.paste(logo, (96, 3), logo)
save(header, "header.bmp")

# SysAnimate32 consumes uncompressed DIB AVI. No system video codecs needed.
def chunk(kind, data):
    return kind + struct.pack("<I", len(data)) + data + (b"\0" if len(data) % 2 else b"")


def write_avi(width, height, target):
    frames = []
    stride = ((width * 3 + 3) // 4) * 4
    for index in range(1, 4):
        image = Image.open(OUT / f"feature-{index}.bmp").convert("RGB")
        image = image.resize((width, height), Image.Resampling.LANCZOS)
        raw = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM).tobytes("raw", "BGR")
        frames.append(b"".join(raw[y * width * 3:(y + 1) * width * 3] + b"\0" * (stride - width * 3) for y in range(height)))
    size = len(frames[0])
    avih = struct.pack("<14I", 5_500_000, (size * 2 + 10) // 11, 0, 16, 3, 0, 1, size, width, height, 0, 0, 0, 0)
    strh = struct.pack("<4s4sIHHIIIIIIIIhhhh", b"vids", b"DIB ", 0, 0, 0, 0, 11, 2, 0, 3, size, 0xFFFFFFFF, 0, 0, 0, width, height)
    strf = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, size, 0, 0, 0, 0)
    hdrl = chunk(b"LIST", b"hdrl" + chunk(b"avih", avih) + chunk(b"LIST", b"strl" + chunk(b"strh", strh) + chunk(b"strf", strf)))
    movie, indexes, offset = b"", b"", 4
    for frame in frames:
        frame_chunk = chunk(b"00db", frame)
        indexes += struct.pack("<4sIII", b"00db", 16, offset, len(frame))
        movie += frame_chunk
        offset += len(frame_chunk)
    payload = b"AVI " + hdrl + chunk(b"LIST", b"movi" + movie) + chunk(b"idx1", indexes)
    target.write_bytes(b"RIFF" + struct.pack("<I", len(payload)) + payload)


for density, width, height in [(1, 280, 156), (2, 420, 234), (3, 560, 312)]:
    write_avi(width, height, OUT / f"poster-loop-{density}x.avi")
