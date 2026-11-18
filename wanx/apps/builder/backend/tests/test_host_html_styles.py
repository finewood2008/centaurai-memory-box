"""Static style/CSP conflicts must fail new standard builds, not ship unstyled."""
import base64
import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from wanx_studio import devkit_build
from wanx_studio.contracts import StudioError

CSS = ".panel { color: rgb(21, 61, 57); }"
HASH = "sha256-" + base64.b64encode(hashlib.sha256(CSS.encode()).digest()).decode()
ROOT = Path(__file__).resolve().parents[2]
ERROR = {"code": "HOST_INLINE_STYLE_BLOCKED", "path": "/app/host.html"}


def meta(policy):
    return '<meta http-equiv="Content-Security-Policy" content="' + policy + '">'


def html(policy, body=None):
    return "<!doctype html><html><head>" + meta(policy) + (body if body is not None else "<style>" + CSS + "</style>") + "</head><body><p class=panel>Example</p></body></html>"


@pytest.fixture
def workspace(tmp_path):
    # Only the existing runtime validation seam is under test here. The real
    # generator/check/build/package paths are exercised separately below.
    (tmp_path / "application.manifest.json").write_text(json.dumps({"protocolVersion": 3, "entrypoint": "shell/main.cjs", "capabilities": []}))
    for relative in ("shell/main.cjs", "shell/host.cjs", "shell/preload.cjs", "app/host.mjs", "app/host.html"):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
    return tmp_path


@pytest.mark.parametrize("source", [
    html("default-src 'self'"),
    html("style-src 'self'"),
    "<html><head><script>/* HEAD_SCRIPT_SENTINEL */</script>" + meta("style-src 'none'") + "<style>" + CSS + "</style></head><body>Example</body></html>",
    html("style-src 'none'"),
    html("style-src"),
    html("style-src 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='"),
    html("style-src 'unsafe-inline' 'nonce-abc'"),
    html("style-src 'unsafe-inline' '" + HASH.replace("sha256-", "sha256-A", 1) + "'"),
    html("style-src 'unsafe-inline'; style-src-elem 'none'"),
    html("style-src 'none'; style-src 'unsafe-inline'"),
    html("style-src 'unsafe-inline'", meta("default-src 'self'") + "<style>" + CSS + "</style>"),
    html("style-src 'nonce-abc'", '<style nonce="other">' + CSS + "</style>"),
    html("style-src 'none'", '<style></style>'),
    "<html><head>" + meta("style-src 'self'") + "<style>" + CSS,
    "<html><head>" + meta("style-src 'none'") + '</head><body><p style="' + CSS + '">Example</p></body></html>',
    "<html><head>" + meta("style-src 'unsafe-inline'; style-src-attr 'none'") + '</head><body><p style="color:red">Example</p></body></html>',
])
def test_static_inline_styles_blocked_by_effective_policy_are_rejected(workspace, source):
    (workspace / "app/host.html").write_text(source)
    assert devkit_build.validate_host_runtime(workspace) == [ERROR]


@pytest.mark.parametrize("source", [
    "<html><head><style>" + CSS + "</style></head><body>Example</body></html>",
    html("script-src 'self'"),
    html("default-src 'self'; style-src 'unsafe-inline'"),
    html("style-src 'self' '" + HASH + "'"),
    html("style-src 'self' '" + HASH.rstrip("=") + "'"),
    html("style-src 'none'; style-src-elem '" + HASH + "'"),
    html("style-src 'nonce-abc'", '<style nonce="abc">' + CSS + "</style>"),
    html("style-src 'NONCE-abc'", '<style nonce="abc">' + CSS + "</style>"),
    html("style-src '" + HASH.replace("sha256-", "SHA256-") + "'"),
    "plain text" + meta("style-src 'none'") + "<style>" + CSS + "</style>",
    html("style-src 'unsafe-inline' 'nonce-abc'", '<style nonce="abc">' + CSS + "</style>"),
    html("style-src 'none'", '<link rel="stylesheet" href="local.css">'),
    html("default-src 'self'", ""),
    "<html><head><style>" + CSS + "</style>" + meta("style-src 'none'") + "</head><body>Example</body></html>",
    "<html><head></head><body>" + meta("style-src 'none'") + "<style>" + CSS + "</style></body></html>",
    html("style-src 'unsafe-inline'", '<!--' + meta("style-src 'none'") + '--><style>' + CSS + "</style>"),
    html("style-src 'unsafe-inline'", '<template>' + meta("style-src 'none'") + '</template><style>' + CSS + "</style>"),
    html("style-src 'none'", '<template><style>' + CSS + '</style></template>'),
    "<html><head></head><body><textarea>" + meta("style-src 'none'") + "<style>" + CSS + "</style></textarea><style>" + CSS + "</style></body></html>",
    "<html><head>" + meta("style-src 'none'; style-src-attr 'unsafe-inline'") + '</head><body><p style="color:red">Example</p></body></html>',
])
def test_compatible_styles_and_non_applying_meta_do_not_regress(workspace, source):
    (workspace / "app/host.html").write_text(source)
    assert devkit_build.validate_host_runtime(workspace) == []


def test_actual_pipeline_blocks_self_rejected_styles_and_preserves_valid_hash_bytes(tmp_path):
    project = {"id": "c" * 32, "name": "Style regression", "appId": "dev.wanx.style-check", "devKit": True, "artifacts": [], "solution": {"capabilities": [], "dependencies": []}}
    root = Path(devkit_build.create_workspace(project, ROOT, tmp_path)["root"])
    bad = html("default-src 'self'; script-src 'self'; connect-src 'none'")
    devkit_build.apply_mutable_files(root, {"app/host.html": bad})
    with pytest.raises(StudioError, match="DEVKIT_HOST_RUNTIME_INVALID"):
        devkit_build.run_pipeline(root)
    fixed = html("default-src 'self'; script-src 'self'; connect-src 'none'; style-src '" + HASH + "'")
    devkit_build.apply_mutable_files(root, {"app/host.html": fixed})
    result = devkit_build.run_pipeline(root)
    package = next((root / "local-packages").glob("*.zip"))
    with zipfile.ZipFile(package) as archive:
        assert archive.read("app/host.html") == fixed.encode()
    assert all(stage["exitCode"] == 0 for stage in result["stages"].values())
