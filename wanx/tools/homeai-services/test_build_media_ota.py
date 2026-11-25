import hashlib
import importlib.util
import json
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import build_media_ota as ota


def content(value):
    return {"sizeBytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}


class MediaOtaArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        elf = b"\x7fELF\x02\x01" + b"\0" * 12 + b"\x3e\x00"
        self.assets = {
            "ocr/bin/tesseract": elf,
            "ocr/lib/libstdc++.so.6": elf,
            "ocr/tessdata/chi_sim.traineddata": b"example chinese",
            "ocr/tessdata/eng.traineddata": b"example english",
            "models/whisper/model.bin": b"example weight",
            "wheelhouse/faster_whisper-1.2.1-py3-none-any.whl": b"example wheel",
        }
        for name, data in self.assets.items():
            path = self.root / name
            path.parent.mkdir(exist_ok=True, parents=True)
            path.write_bytes(data)
        self.pins = self.root / "model-pins.json"
        self.pins.write_bytes(ota.encode({
            "whisper": {"files": {"model.bin": content(self.assets["models/whisper/model.bin"])}},
        }))
        manifest = self.root / "ocr-manifest.json"
        manifest.write_bytes(ota.encode({
            "schemaVersion": 1, "platform": ota.PLATFORM, "source": "Ubuntu integration fixture",
            "version": "fixture", "license": "Apache-2.0",
            "files": {name.removeprefix("ocr/"): content(data) for name, data in self.assets.items()
                      if name.startswith("ocr/")},
        }))
        self.args = SimpleNamespace(
            version="0.1.0-rc.1", build_id="media-1", source_commit="a" * 40,
            wheelhouse=self.root / "wheelhouse", models=self.root / "models",
            ocr_root=self.root / "ocr", ocr_manifest=manifest,
            ocr_sha256=content(manifest.read_bytes())["sha256"], output=self.root / "media.tar.gz",
        )
        self.source = {"wanx_media/__main__.py": b"pass\n", "uv.lock": b"test"}
        self.wheels = {
            "faster-whisper": {
                "filename": "faster_whisper-1.2.1-py3-none-any.whl", "version": "1.2.1",
                "archiveFilename": "faster_whisper-1.2.1-py3-none-any.whl",
                **content(self.assets["wheelhouse/faster_whisper-1.2.1-py3-none-any.whl"]),
            },
        }

    def build(self):
        with patch.object(ota, "MODEL_PINS", self.pins):
            return ota.build(self.args, self.source, self.wheels)

    def test_deterministic_ustar_matches_optional_service_index(self):
        offer = self.build()
        previous = self.args.output.read_bytes()
        self.args.output = self.root / "other.tar.gz"
        self.assertEqual(offer, self.build())
        self.assertEqual(previous, self.args.output.read_bytes())
        self.assertEqual(offer["artifact"], {"kind": "service-tar", **content(previous)})
        with tarfile.open(self.args.output) as archive:
            names = archive.getnames()
            self.assertEqual(sorted(names), names)
            self.assertTrue(all(member.isfile() and not member.pax_headers and member.mtime == 0
                                for member in archive))
            self.assertEqual(archive.getmember("ocr/bin/tesseract").mode, 0o755)
            index = json.load(archive.extractfile("files.sha256.json"))
            self.assertEqual(set(index["files"]), set(names) - {"files.sha256.json"})
            for name, record in index["files"].items():
                self.assertEqual(record, {**content(archive.extractfile(name).read()), "mode": archive.getmember(name).mode})
            expected = json.load(archive.extractfile("release.json"))
            self.assertEqual(expected["profile"], ota.PROFILE)
            self.assertEqual(expected["runtime"], {"python": "3.14", "requirements": "runtime-requirements.txt",
                                                   "wheelhouse": "wheelhouse"})
            self.assertEqual(
                archive.extractfile("runtime-requirements.txt").read().decode(),
                f"faster-whisper==1.2.1 --hash=sha256:{self.wheels['faster-whisper']['sha256']}\n",
            )

    def test_same_size_model_damage_leaves_no_archive(self):
        model = self.root / "models/whisper/model.bin"
        model.write_bytes(b"x" * model.stat().st_size)
        with self.assertRaisesRegex(ValueError, "approved digest"):
            self.build()
        self.assertFalse(self.args.output.exists())

    def test_ocr_manifest_pin_and_symlink_reject(self):
        original = self.args.ocr_sha256
        self.args.ocr_sha256 = "0" * 64
        with self.assertRaisesRegex(ValueError, "OCR manifest"):
            self.build()
        self.args.ocr_sha256 = original
        wheel = self.root / "wheelhouse" / self.wheels["faster-whisper"]["filename"]
        other = wheel.with_suffix(".copy")
        wheel.rename(other)
        wheel.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.build()

    @unittest.skipUnless(shutil.which("uv") and importlib.util.find_spec("packaging"),
                         "uv and packaging are required for projecting uv.lock")
    def test_committed_lock_selects_linux_cp314_on_build_host(self):
        commit = subprocess.check_output(["git", "-C", ota.ROOT, "rev-parse", "HEAD"], text=True).strip()
        wheels = ota.locked_wheels(ota.source_files(commit))
        self.assertNotIn("colorama", wheels)
        for name in ("ctranslate2", "numpy", "onnxruntime", "sherpa-onnx"):
            self.assertIn("cp314-cp314-", wheels[name]["filename"])
            self.assertIn("_x86_64", wheels[name]["filename"])
        self.assertIn("manylinux", wheels["av"]["filename"])
        from packaging.utils import parse_wheel_filename

        for wheel in wheels.values():
            self.assertLessEqual(len(wheel["archiveFilename"]), 100)
            self.assertLessEqual(parse_wheel_filename(wheel["archiveFilename"])[3],
                                 parse_wheel_filename(wheel["filename"])[3])


if __name__ == "__main__":
    unittest.main()
