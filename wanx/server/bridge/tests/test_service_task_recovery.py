"""Durable leases preserve existing bounds; no desktop token is persisted."""

import time

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from test_huohua_service_session import setup_registry

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.service_sessions import ServiceSessionVerifier


def setup(tmp_path, **kwargs):
    registry = setup_registry(tmp_path, Ed25519PrivateKey.generate())
    key = Ed25519PrivateKey.generate()
    path = tmp_path / "private" / "tasks.enc"

    def reopen():
        return ServiceSessionVerifier(registry, key, state_path=path, **kwargs)

    return reopen, path


def create(verifier, **kwargs):
    parent = verifier.issue_delegated(
        "huohua.workbench",
        protocol_version=1,
        box_id="box-1",
        user_id="7",
        space_id="personal",
        scope=("workbench:read", "workbench:write"),
        upstream_token="private-upstream-value",
        **kwargs,
    )
    return verifier.issue_task(parent, task_id="publish-1")


def test_restart_recovers_rotating_task_and_persists_revocation(tmp_path):
    reopen, path = setup(tmp_path)
    task = create(reopen())
    assert b"private-upstream-value" not in path.read_bytes()
    assert b"publish-1" not in path.read_bytes()
    assert path.stat().st_mode & 0o777 == 0o600
    recovered = reopen()
    renewed = recovered.renew_task(task["renewal_token"], task_id=task["taskId"])
    assert renewed["taskExpiresAt"] == task["taskExpiresAt"]
    assert recovered.delegated_upstream_token(renewed["access_token"]) == "private-upstream-value"
    with pytest.raises(BridgeAuthError):
        reopen().renew_task(task["renewal_token"], task_id=task["taskId"])
    recovered.revoke_task(renewed["renewal_token"], task_id=task["taskId"])
    with pytest.raises(BridgeAuthError, match="TASK_REVOKED"):
        reopen().renew_task(renewed["renewal_token"], task_id=task["taskId"])


def test_recovery_rejects_corruption_and_wrong_key(tmp_path):
    reopen, path = setup(tmp_path)
    create(reopen())
    blob = path.read_bytes()
    path.write_bytes(blob[:-1] + bytes([blob[-1] ^ 1]))
    recovered = reopen()
    assert recovered.recovery_error == "TASK_STATE_INVALID"
    with pytest.raises(BridgeAuthError, match="TASK_STATE_INVALID"):
        create(recovered)


def test_restart_checks_authority_and_upstream_expiry(tmp_path):
    valid = [True]

    def validate(binding):
        if not valid[0] or binding != {"ownership_epoch": 3}:
            raise BridgeAuthError("TASK_AUTHORITY_CHANGED", 403)

    reopen, path = setup(tmp_path, authority_validator=validate)
    task = create(reopen(), authority={"ownership_epoch": 3}, upstream_expires_at=time.time() + 90)
    assert task["taskExpiresAt"] <= time.time() + 90
    valid[0] = False
    with pytest.raises(BridgeAuthError, match="TASK_AUTHORITY_CHANGED"):
        reopen().renew_task(task["renewal_token"], task_id=task["taskId"])


def test_restart_cannot_extend_original_deadline(tmp_path):
    now = [time.time()]
    reopen, path = setup(tmp_path, now=lambda: now[0])
    task = create(reopen())
    now[0] = task["taskExpiresAt"] + 1
    with pytest.raises(BridgeAuthError):
        reopen().renew_task(task["renewal_token"], task_id=task["taskId"])


def test_failed_journal_write_preserves_retryable_credential(tmp_path, monkeypatch):
    reopen, path = setup(tmp_path)
    verifier = reopen()
    task = create(verifier)
    original = verifier._state.write

    def fail(_tasks):
        raise BridgeAuthError("TASK_STATE_UNAVAILABLE", 503)

    monkeypatch.setattr(verifier._state, "write", fail)
    with pytest.raises(BridgeAuthError, match="TASK_STATE_UNAVAILABLE"):
        verifier.renew_task(task["renewal_token"], task_id=task["taskId"])
    monkeypatch.setattr(verifier._state, "write", original)
    renewed = verifier.renew_task(task["renewal_token"], task_id=task["taskId"])
    assert renewed["taskExpiresAt"] == task["taskExpiresAt"]
    assert reopen().delegated_upstream_token(renewed["access_token"]) == "private-upstream-value"
