from __future__ import annotations

import hashlib
import threading
import time
from typing import Any

import pytest

from octop.infra.personal_space import previews
from octop.infra.personal_space.previews import DocumentPreview
from octop.infra.personal_space.service import SpaceError

PDF = b"%PDF-1.7\nsynthetic preview\n%%EOF"


def entry(raw: bytes = b"office", **changes: Any) -> dict[str, Any]:
    return {
        "id": "a" * 32,
        "version": 1,
        "name": "example.docx",
        "kind": "file",
        "size": len(raw),
        "digest": hashlib.sha256(raw).hexdigest(),
        **changes,
    }


def ready(preview: DocumentPreview) -> dict[str, Any]:
    for _ in range(300):
        status = preview.status()
        if status["state"] == "ready":
            return status
        time.sleep(0.01)
    raise AssertionError("preview did not finish")


def test_same_version_coalesces_conversion_and_cache_is_version_scoped(tmp_path, monkeypatch):
    release = threading.Event()
    calls = []

    def convert(raw, suffix, destination):
        calls.append((raw, suffix))
        assert release.wait(5)
        destination.write_bytes(PDF)

    monkeypatch.setattr(previews, "convert_pdf", convert)
    first = DocumentPreview(tmp_path, entry())
    assert first.prepare(lambda o, n: b"office"[o : o + n])["state"] == "processing"
    second = DocumentPreview(tmp_path, entry())
    assert second.prepare(lambda o, n: pytest.fail("duplicate read"))["state"] == "processing"
    release.set()
    assert ready(first)["digest"] == hashlib.sha256(PDF).hexdigest()
    assert first.content(0, 5) == b"%PDF-"
    assert second.prepare(lambda o, n: pytest.fail("cached source read"))["state"] == "ready"
    assert len(calls) == 1
    changed = DocumentPreview(tmp_path, entry(version=2))
    assert changed.path != first.path
    assert changed.status()["state"] == "missing"


def test_changed_source_fails_and_manual_retry_can_recover(tmp_path, monkeypatch):
    monkeypatch.setattr(
        previews, "convert_pdf", lambda raw, suffix, target: target.write_bytes(PDF)
    )
    preview = DocumentPreview(tmp_path, entry())
    preview.prepare(lambda o, n: b"changed")
    with pytest.raises(SpaceError, match="REMOTE_FILE_CHANGED"):
        ready(preview)
    preview.prepare(lambda o, n: b"office"[o : o + n])
    assert ready(preview)["state"] == "ready"


def test_private_cache_and_input_boundaries(tmp_path):
    first = DocumentPreview(tmp_path, entry())
    (tmp_path / "other").mkdir()
    other = DocumentPreview(tmp_path / "other", entry())
    assert other.path != first.path
    with pytest.raises(SpaceError, match="TOO_LARGE"):
        DocumentPreview(tmp_path, entry(size=previews.MAX_BYTES + 1))
    with pytest.raises(SpaceError, match="PREVIEW_DOWNLOAD"):
        DocumentPreview(tmp_path, entry(name="program.exe"))
    with pytest.raises(SpaceError, match="NOT_READY"):
        first.content(0, 10)


def test_missing_converter_and_sandbox_have_no_unsafe_fallback(monkeypatch, tmp_path):
    monkeypatch.delenv("WANX_PREVIEW_SOFFICE", raising=False)
    monkeypatch.setattr(previews.shutil, "which", lambda _: None)
    monkeypatch.setattr(previews.sys, "platform", "linux")
    with pytest.raises(SpaceError, match="CONVERTER_UNAVAILABLE"):
        previews.converter()
    with pytest.raises(SpaceError, match="SANDBOX_UNAVAILABLE"):
        previews._command("/usr/bin/soffice", tmp_path, ".pptx")


def test_cache_symlink_rejected(tmp_path):
    (tmp_path / "destination").mkdir()
    (tmp_path / ".document-previews").symlink_to(tmp_path / "destination", target_is_directory=True)
    with pytest.raises(SpaceError, match="UNSAFE_STORAGE"):
        DocumentPreview(tmp_path, entry())
