import json
import os

import pytest

from wanx_studio.deployment.bootstrap import ensure_target
from wanx_studio.deployment.miniapp_profile import load_target


@pytest.fixture(autouse=True)
def sso(monkeypatch):
    monkeypatch.setenv("WANX_PLATFORM_SSO_ENABLED", "1")
    monkeypatch.setenv("WANX_PLATFORM_DEVICE_ID", "synthetic-box")
    monkeypatch.delenv("OCTOP_LOCAL_DATA_MODE", raising=False)


@pytest.mark.skipif(os.name == "nt", reason="POSIX deployment target policy")
def test_first_boot_creates_usable_private_target_and_upgrade_preserves_policy(
    tmp_path,
):
    assert ensure_target(tmp_path)
    path = tmp_path / "deployment-expert-target.json"
    assert load_target(path, profile="wanx-expert-app-v1")["boxId"] == "synthetic-box"
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
    value = json.loads(path.read_text())
    value["enabled"] = False
    path.write_text(json.dumps(value))
    original = path.read_bytes()
    assert not ensure_target(tmp_path)
    assert path.read_bytes() == original


@pytest.mark.parametrize("mode", ["explicit-local", "environment-local", "no-sso"])
def test_non_sso_modes_never_enable_deployment(tmp_path, monkeypatch, mode):
    if mode == "environment-local":
        monkeypatch.setenv("OCTOP_LOCAL_DATA_MODE", "required")
    if mode == "no-sso":
        monkeypatch.delenv("WANX_PLATFORM_SSO_ENABLED")
    assert not ensure_target(tmp_path, local_required=mode == "explicit-local")
    assert not list(tmp_path.iterdir())


def test_missing_identity_fails_without_creating_target(tmp_path, monkeypatch):
    monkeypatch.delenv("WANX_PLATFORM_DEVICE_ID")
    with pytest.raises(ValueError, match="DEVICE_ID_REQUIRED"):
        ensure_target(tmp_path)
    assert not list(tmp_path.iterdir())


@pytest.mark.skipif(os.name == "nt", reason="POSIX target initialization")
def test_existing_symlink_is_not_followed_or_overwritten(tmp_path):
    external = tmp_path / "policy"
    external.write_text("operator policy")
    (tmp_path / "deployment-expert-target.json").symlink_to(external)
    assert not ensure_target(tmp_path)
    assert external.read_text() == "operator policy"


def test_existing_operator_policy_is_retained_even_without_bootstrap_identity(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("WANX_PLATFORM_DEVICE_ID")
    target = tmp_path / "deployment-expert-target.json"
    target.write_text('{"enabled":false}')
    assert not ensure_target(tmp_path)
    assert target.read_text() == '{"enabled":false}'
