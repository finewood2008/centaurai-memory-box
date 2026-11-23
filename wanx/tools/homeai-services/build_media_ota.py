#!/usr/bin/env python3
"""Build the offline wanx.media payload consumed by CentaurOS optional-service OTA.

Use a build environment with uv and packaging installed. The wheel-plan command
reports wheels from the committed lock file without downloading them. For build,
stage the actual wheel files, models and a Linux OCR runtime. Supply the OCR
manifest digest from the trusted preparation step. The OCR manifest contains
schemaVersion, platform, source, version, license and a files mapping keyed by
relative path, whose entries contain sizeBytes and sha256.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import tarfile
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
PROJECT = "server/services/media-processing"
PLATFORM = {"os": "linux", "osId": "ubuntu", "osVersion": "26.04", "arch": "x64"}
PROFILE = {
    "profileId": "wanx-media-python314-ubuntu2604-x64",
    "profileVersion": 1,
    "profileDigest": "3a13f93e511058cbd79d51acd2cf1dd77d4e5cc733bcce929c341eb4f95ce780",
}
PYTHON = (3, 14)
TARGET_MARKERS = {
    "implementation_name": "cpython",
    "implementation_version": "3.14.0",
    "os_name": "posix",
    "platform_machine": "x86_64",
    "platform_python_implementation": "CPython",
    "platform_release": "",
    "platform_system": "Linux",
    "platform_version": "",
    "python_full_version": "3.14.0",
    "python_version": "3.14",
    "sys_platform": "linux",
}
LINUX_PLATFORMS = [
    *(f"manylinux_2_{minor}_x86_64" for minor in range(39, 4, -1)),
    "manylinux2014_x86_64",
    "manylinux2010_x86_64",
    "manylinux1_x86_64",
    "linux_x86_64",
]
MAX_ARCHIVE_BYTES = 2 * 1024**3
MAX_PAYLOAD_BYTES = 6 * 1024**3
MAX_FILES = 60_000
SHA = re.compile(r"[0-9a-f]{64}")
BUILD = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")
MODEL_PINS = Path(__file__).with_name("media-ota-models.json")
OCR_BINARY = "bin/tesseract"
OCR_REQUIRED = {OCR_BINARY, "tessdata/chi_sim.traineddata", "tessdata/eng.traineddata"}


def encode(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode()


def command(args, **kwargs):
    done = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if done.returncode:
        raise ValueError(f"{args[0]} failed: {done.stderr.decode(errors='replace').strip()}")
    return done.stdout


def source_files(commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("--source-commit must be a full Git commit SHA")
    if command(["git", "-C", str(ROOT), "cat-file", "-t", commit]).strip() != b"commit":
        raise ValueError("source is not a Git commit")
    raw = command(["git", "-C", str(ROOT), "archive", "--format=tar", f"{commit}:{PROJECT}"])
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for member in archive:
            if member.name in {"pyproject.toml", "uv.lock"} or re.fullmatch(
                r"wanx_media/[a-z0-9_]+\.py", member.name
            ):
                if not member.isfile():
                    raise ValueError(f"unexpected source type: {member.name}")
                files[member.name] = archive.extractfile(member).read()
    if not {"pyproject.toml", "uv.lock", "wanx_media/__main__.py"} <= files.keys():
        raise ValueError("frozen source lacks media project files")
    return files


def locked_wheels(files):
    from packaging.markers import Marker
    from packaging.tags import compatible_tags, cpython_tags
    from packaging.utils import canonicalize_name, parse_wheel_filename

    target_tags = {
        tag: rank
        for rank, tag in enumerate(dict.fromkeys([
            *cpython_tags(PYTHON, abis=["cp314"], platforms=LINUX_PLATFORMS),
            *compatible_tags(PYTHON, interpreter="cp314", platforms=LINUX_PLATFORMS),
        ]))
    }
    with tempfile.TemporaryDirectory(prefix="wanx-media-lock-") as temporary:
        root = Path(temporary)
        for name in ("pyproject.toml", "uv.lock"):
            (root / name).write_bytes(files[name])
        raw = command([
            "uv", "export", "--no-config", "--locked", "--offline", "--no-dev",
            "--extra", "asr", "--extra", "streaming", "--no-emit-project",
            "--format", "pylock.toml",
        ], cwd=root)
    lock = tomllib.loads(raw.decode())
    if lock.get("lock-version") != "1.0":
        raise ValueError("unsupported pylock export version")
    result = {}
    for package in lock["packages"]:
        marker = package.get("marker")
        if marker and not Marker(marker).evaluate(TARGET_MARKERS):
            continue
        name, version = canonicalize_name(package["name"]), package["version"]
        if name in result or not BUILD.fullmatch(version):
            raise ValueError(f"ambiguous or unsupported locked package: {name}")
        candidates = []
        for wheel in package.get("wheels", []):
            url = urlsplit(wheel["url"])
            if (url.scheme != "https" or url.netloc != "files.pythonhosted.org"
                    or url.query or url.fragment):
                raise ValueError(f"unexpected wheel origin for {name}")
            filename = PurePosixPath(url.path).name
            distribution, wheel_version, _, tags = parse_wheel_filename(filename)
            if distribution != name or str(wheel_version) != version:
                raise ValueError(f"wheel differs from locked package: {filename}")
            tag = min((tag for tag in tags if tag in target_tags), key=target_tags.__getitem__, default=None)
            if tag is not None:
                candidates.append((target_tags[tag], filename, wheel, tag))
        if not candidates:
            raise ValueError(f"no Ubuntu x64 CPython 3.14 wheel for {name}")
        _, filename, wheel, tag = min(candidates, key=lambda item: item[:2])
        # USTAR allows at most 100 bytes after the final slash. If the PyPI
        # name lists several platform aliases, keep the selected original tag.
        archive_name = filename
        if len(archive_name) > 100:
            stem = filename.removesuffix(".whl").rsplit("-", 3)[0]
            archive_name = f"{stem}-{tag}.whl"
        if len(archive_name) > 100:
            raise ValueError(f"locked wheel filename does not fit USTAR: {filename}")
        checksum, size = wheel["hashes"]["sha256"], wheel["size"]
        if not SHA.fullmatch(checksum) or type(size) is not int or size < 1:
            raise ValueError(f"wheel lock lacks an exact size and SHA-256: {filename}")
        result[name] = {
            "version": version, "filename": filename, "archiveFilename": archive_name, "url": wheel["url"],
            "sha256": checksum, "sizeBytes": size,
        }
    if not {"faster-whisper", "sherpa-onnx", "sherpa-onnx-core", "websockets"} <= result.keys():
        raise ValueError("export omitted an ASR runtime dependency")
    return result


def input_file(root, name):
    path = PurePosixPath(name)
    if path.is_absolute() or path.as_posix() != name or any(
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.+-]*", part) for part in path.parts
    ):
        raise ValueError(f"invalid input path: {name}")
    current = root
    for part in path.parts:
        current /= part
        if current.is_symlink():
            raise ValueError(f"symlink in asset path: {name}")
    if not stat.S_ISREG(current.stat().st_mode):
        raise ValueError(f"input must be a regular file: {name}")
    return current


@dataclass(frozen=True)
class VerifiedFile:
    path: Path
    size: int
    checksum: str


def verified_file(root, name, entry):
    path = input_file(root, name)
    size, checksum = entry["sizeBytes"], entry["sha256"]
    if (type(size) is not int or not 0 < size <= MAX_PAYLOAD_BYTES
            or not isinstance(checksum, str) or not SHA.fullmatch(checksum)
            or path.stat().st_size != size):
        raise ValueError(f"asset does not match approved digest: {name}")
    return VerifiedFile(path, size, checksum)


def model_assets(root):
    sources = json.loads(MODEL_PINS.read_bytes())
    result = {"models/sources.json": encode(sources)}
    for model, item in sources.items():
        for name, entry in item["files"].items():
            relative = f"{model}/{name}"
            result[f"models/{relative}"] = verified_file(root, relative, entry)
    return result


def ocr_assets(root, manifest, expected_hash):
    with manifest.open("rb") as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError("OCR manifest does not match its approved SHA-256")
    value = json.loads(raw)
    if (value.get("schemaVersion") != 1 or value.get("platform") != PLATFORM
            or not isinstance(value.get("source"), str) or not value["source"].strip()
            or not isinstance(value.get("version"), str) or not value["version"].strip()
            or not isinstance(value.get("license"), str) or not value["license"].strip()
            or not isinstance(value.get("files"), dict) or not OCR_REQUIRED <= value["files"].keys()):
        raise ValueError("OCR manifest is missing approved platform or provenance")
    result = {"ocr/sources.json": encode(value)}
    for name, entry in value["files"].items():
        if name not in OCR_REQUIRED and not re.fullmatch(r"lib/[A-Za-z0-9_.+-]+\.so(?:\.[0-9]+)*", name):
            raise ValueError(f"unexpected OCR payload path: {name}")
        asset = verified_file(root, name, entry)
        if name == OCR_BINARY or name.startswith("lib/"):
            with asset.path.open("rb") as stream:
                header = stream.read(20)
            if header[:6] != b"\x7fELF\x02\x01" or header[18:20] != b"\x3e\x00":
                raise ValueError(f"OCR binary is not Linux x86_64 ELF: {name}")
        result[f"ocr/{name}"] = asset
    return result


class HashingReader:
    def __init__(self, stream):
        self.stream = stream
        self.hash = hashlib.sha256()

    def read(self, size):
        value = self.stream.read(size)
        self.hash.update(value)
        return value


def write_archive(output, files, modes):
    index = {"schemaVersion": 1, "files": {}}
    for name, source in sorted(files.items()):
        size, checksum = (
            (len(source), hashlib.sha256(source).hexdigest())
            if isinstance(source, bytes) else (source.size, source.checksum)
        )
        index["files"][name] = {"sizeBytes": size, "sha256": checksum, "mode": modes.get(name, 0o644)}
    index_bytes = encode(index)
    if (len(files) + 1 > MAX_FILES or len(index_bytes) > 16 * 1024**2 or
            len(index_bytes) + sum(entry["sizeBytes"] for entry in index["files"].values()) > MAX_PAYLOAD_BYTES):
        raise ValueError("archive exceeds CentaurOS payload limits")
    with tempfile.NamedTemporaryFile(prefix=".wanx-media-", dir=output.parent) as temporary:
        with gzip.GzipFile(filename="", mode="wb", fileobj=temporary, mtime=0) as compressed:
            with tarfile.open(mode="w", fileobj=compressed, format=tarfile.USTAR_FORMAT) as archive:
                for name, source in sorted({**files, "files.sha256.json": index_bytes}.items()):
                    entry = index["files"].get(name)
                    item = tarfile.TarInfo(name)
                    item.mode = entry["mode"] if entry else 0o644
                    item.size = entry["sizeBytes"] if entry else len(index_bytes)
                    with (io.BytesIO(source) if isinstance(source, bytes) else source.path.open("rb")) as stream:
                        reader = HashingReader(stream)
                        archive.addfile(item, reader)
                        if entry and (reader.hash.hexdigest() != entry["sha256"] or stream.read(1)):
                            raise ValueError(f"asset does not match approved digest: {name}")
        temporary.flush()
        size = temporary.tell()
        if size > MAX_ARCHIVE_BYTES:
            raise ValueError("compressed archive exceeds CentaurOS artifact limit")
        temporary.seek(0)
        digest = hashlib.file_digest(temporary, "sha256").hexdigest()
        os.link(temporary.name, output)
    return {"sha256": digest, "sizeBytes": size}


def build(args, source, wheels):
    if not VERSION.fullmatch(args.version) or not BUILD.fullmatch(args.build_id):
        raise ValueError("invalid version or build ID")
    metadata = {
        "serviceId": "wanx.media", "version": args.version, "buildId": args.build_id,
        "sourceCommit": args.source_commit, "platform": PLATFORM, "profile": PROFILE,
        "dataPolicy": "backward-compatible",
        "runtime": {"python": "3.14", "requirements": "runtime-requirements.txt", "wheelhouse": "wheelhouse"},
    }
    files = {f"app/{name}": contents for name, contents in source.items() if name.startswith("wanx_media/")}
    files["release.json"] = encode(metadata)
    files["runtime-requirements.txt"] = "".join(
        f"{name}=={wheel['version']} --hash=sha256:{wheel['sha256']}\n"
        for name, wheel in sorted(wheels.items())
    ).encode()
    for entry in wheels.values():
        name = entry["filename"]
        files[f"wheelhouse/{entry['archiveFilename']}"] = verified_file(args.wheelhouse, name, entry)
    files.update(model_assets(args.models))
    files.update(ocr_assets(args.ocr_root, args.ocr_manifest, args.ocr_sha256))
    artifact = write_archive(args.output, files, {f"ocr/{OCR_BINARY}": 0o755})
    return {
        **metadata, "artifact": {"kind": "service-tar", **artifact},
        "serviceProtocol": 1, "bridgeProtocol": 1, "minUpdaterVersion": "1.9.52",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    wheel_plan = commands.add_parser("wheel-plan", help="list the exact locked wheel files to stage")
    package = commands.add_parser("build", help="assemble and hash the offline release payload")
    for subcommand in (wheel_plan, package):
        subcommand.add_argument("--source-commit", required=True)
    package.add_argument("--version", required=True)
    package.add_argument("--build-id", required=True)
    package.add_argument("--wheelhouse", type=Path, required=True)
    package.add_argument("--models", type=Path, required=True)
    package.add_argument("--ocr-root", type=Path, required=True)
    package.add_argument("--ocr-manifest", type=Path, required=True)
    package.add_argument("--ocr-sha256", required=True)
    package.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        source = source_files(args.source_commit)
        wheels = locked_wheels(source)
        print(encode(wheels if args.command == "wheel-plan" else build(args, source, wheels)).decode(), end="")
    except (ImportError, OSError, ValueError, TypeError, KeyError, tarfile.TarError) as exc:
        parser.exit(1, f"wanx.media OTA build failed: {exc}\n")


if __name__ == "__main__":
    main()
