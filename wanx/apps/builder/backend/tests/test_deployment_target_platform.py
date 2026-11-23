"""Optional protected deployment profiles must not break unsupported hosts."""
import json
import os
from types import SimpleNamespace

import pytest
from wanx_studio.deployment import miniapp_profile


@pytest.mark.parametrize('missing', [('O_NOFOLLOW',), ('geteuid',), ('O_NOFOLLOW', 'geteuid')])
def test_missing_protection_disables_profile_without_opening(monkeypatch, tmp_path, missing):
    def unexpected_open(*args, **kwargs):
        pytest.fail('An unsupported host must not open a deployment target')
    attributes = dict(O_RDONLY=0, O_NOFOLLOW=1, geteuid=lambda: 0, open=unexpected_open)
    for name in missing:
        attributes.pop(name)
    monkeypatch.setattr(miniapp_profile, 'os', SimpleNamespace(**attributes))
    assert miniapp_profile.load_target(tmp_path / 'deployment-target.json') is None
    assert miniapp_profile.load_target(tmp_path / 'deployment-expert-target.json', profile='wanx-expert-app-v1') is None


def test_missing_target_does_not_prevent_startup(tmp_path):
    assert miniapp_profile.load_target(tmp_path / 'deployment-target.json') is None


@pytest.mark.skipif(not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'geteuid'), reason='Requires POSIX protected file semantics')
def test_supported_host_retains_protected_target_checks(tmp_path, monkeypatch):
    monkeypatch.delenv('WANX_PLATFORM_DEVICE_ID', raising=False)
    target = tmp_path / 'target.json'
    expected = dict(schemaVersion=1, enabled=True, profile=miniapp_profile.PROFILE, boxId='test-box', authorityMode='sso')
    target.write_text(json.dumps(expected), encoding='utf-8')
    target.chmod(0o600)
    assert miniapp_profile.load_target(target) == expected
    link = tmp_path / 'linked.json'
    link.symlink_to(target)
    assert miniapp_profile.load_target(link) is None
    target.chmod(0o666)
    assert miniapp_profile.load_target(target) is None
