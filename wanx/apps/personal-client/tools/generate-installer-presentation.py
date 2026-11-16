"""Regenerate the static MemoBox installer artwork with Pillow.

These assets are checked in. Packaging does not need Python or system fonts.
The DMG background deliberately leaves room for Finder's real app and
Applications icons; neither icon is drawn into the background.
"""

from argparse import ArgumentParser
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "installer" / "redesign"
BG = "#FCF9F5"
TEXT = "#302C28"
SECONDARY = "#756B61"
LINE = "#E4D7C7"
ACCENT = "#715A45"
SOFT = "#F3ECE3"


def font_faces(override):
    candidates = [Path(override)] if override else [
        Path("/System/Library/Fonts/PingFang.ttc"),
        *sorted(Path("/System/Library/AssetsV2").glob("com_apple_MobileAsset_Font*/*/AssetData/PingFang.ttc")),
        Path("/System/Library/Fonts/STHeiti Light.ttc"),
        Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
    ]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        faces = []
        for index in range(32):
            try:
                face = ImageFont.truetype(str(candidate), 16, index=index)
                family, style = face.getname()
                faces.append((index, family, style))
            except OSError:
                break
        if not faces:
            continue
        simplified = [face for face in faces if face[1] in ("PingFang SC", "Heiti SC")]
        faces = simplified or faces
        regular = next((face[0] for face in faces if face[2] == "Regular"), faces[0][0])
        medium = next((face[0] for face in faces if face[2] == "Medium"), regular)
        return candidate, regular, medium
    raise SystemExit("A Chinese font is required. Supply --font /path/to/font.ttf or a PingFang SC font collection.")


def generate(font_path, regular_index, medium_index):
    OUT.mkdir(parents=True, exist_ok=True)
    logo = Image.open(ROOT / "resources" / "icon.png").convert("RGBA")

    def font(size, scale=1, medium=False):
        return ImageFont.truetype(str(font_path), round(size * scale), index=medium_index if medium else regular_index)

    def mark(canvas, box):
        x, y, width, height = box
        art = logo.copy()
        art.thumbnail((round(width), round(height)), Image.Resampling.LANCZOS)
        canvas.paste(art, (round(x + (width - art.width) / 2), round(y + (height - art.height) / 2)), art)

    def text(draw, point, value, size, color=TEXT, scale=1, medium=False, anchor="lt"):
        draw.text(tuple(round(n * scale) for n in point), value, font=font(size, scale, medium), fill=color, anchor=anchor)

    def save_bmp(canvas, filename):
        canvas.convert("RGB").save(OUT / filename, "BMP")

    # Small, clean brand images for native NSIS controls. No slides or video.
    canvas = Image.new("RGB", (320, 320), BG)
    mark(canvas, (36, 32, 248, 248))
    save_bmp(canvas.resize((160, 160), Image.Resampling.LANCZOS), "windows-mark.bmp")

    canvas = Image.new("RGB", (300, 114), BG)
    mark(canvas, (208, 10, 88, 88))
    save_bmp(canvas.resize((150, 57), Image.Resampling.LANCZOS), "windows-header.bmp")

    scale = 2
    canvas = Image.new("RGB", (164 * scale, 314 * scale), SOFT)
    draw = ImageDraw.Draw(canvas)
    draw.ellipse((24 * scale, 28 * scale, 140 * scale, 144 * scale), fill="#EDE3D6")
    mark(canvas, (38 * scale, 38 * scale, 88 * scale, 104 * scale))
    text(draw, (82, 174), "半人马AI", 18, scale=scale, medium=True, anchor="mt")
    text(draw, (82, 203), "记忆盒子", 18, scale=scale, medium=True, anchor="mt")
    text(draw, (82, 242), "CENTAURAI", 10, SECONDARY, scale=scale, anchor="mt")
    draw.line((48 * scale, 266 * scale, 116 * scale, 266 * scale), fill=LINE, width=scale)
    text(draw, (82, 285), "powered by wanx", 9, SECONDARY, scale=scale, anchor="mt")
    save_bmp(canvas.resize((164, 314), Image.Resampling.LANCZOS), "windows-sidebar.bmp")

    # Render once at Retina resolution; the 1x asset is a precise downsample.
    scale = 2
    canvas = Image.new("RGB", (760 * scale, 480 * scale), BG)
    draw = ImageDraw.Draw(canvas)
    mark(canvas, (56 * scale, 33 * scale, 30 * scale, 34 * scale))
    text(draw, (100, 40), "半人马AI记忆盒子", 16, ACCENT, scale=scale, medium=True)
    text(draw, (56, 103), "把记忆盒子放进应用程序", 29, scale=scale, medium=True)
    text(draw, (56, 151), "拖入后，请从“应用程序”打开。", 15, SECONDARY, scale=scale)

    # Finder will place the actual 96 px icons at these centers. Soft surfaces
    # indicate the drag targets without duplicating app or folder graphics.
    for center_x in (204, 556):
        radius = 65
        draw.ellipse(((center_x - radius) * scale, (270 - radius) * scale,
                      (center_x + radius) * scale, (270 + radius) * scale), fill=SOFT)
    arrow = "#B5A28C"
    draw.line((349 * scale, 270 * scale, 411 * scale, 270 * scale), fill=arrow, width=2 * scale)
    draw.line((401 * scale, 260 * scale, 411 * scale, 270 * scale, 401 * scale, 280 * scale),
              fill=arrow, width=2 * scale, joint="curve")
    draw.line((56 * scale, 396 * scale, 704 * scale, 396 * scale), fill=LINE, width=scale)
    text(draw, (704, 426), "powered by wanx", 11, SECONDARY, scale=scale, anchor="rt")
    canvas.save(OUT / "mac-dmg@2x.png", "PNG", optimize=True)
    canvas.resize((760, 480), Image.Resampling.LANCZOS).save(OUT / "mac-dmg.png", "PNG", optimize=True)

    expected = {
        "windows-mark.bmp": (160, 160),
        "windows-header.bmp": (150, 57),
        "windows-sidebar.bmp": (164, 314),
        "mac-dmg.png": (760, 480),
        "mac-dmg@2x.png": (1520, 960),
    }
    for filename, dimensions in expected.items():
        with Image.open(OUT / filename) as image:
            if image.size != dimensions or image.mode != "RGB":
                raise SystemExit(f"Unexpected asset dimensions/mode: {filename}")
        print(f"{filename}: {dimensions[0]} x {dimensions[1]}")


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--font", help="Optional Chinese TTF/OTF/TTC for regeneration on another host")
    arguments = parser.parse_args()
    generate(*font_faces(arguments.font))
