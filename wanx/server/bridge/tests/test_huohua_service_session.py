import json

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.service_registry import ServiceRegistry
from wanx_bridge.service_sessions import ServiceSessionVerifier, service_proof_signature


def setup_registry(tmp_path, service_key):
    public = tmp_path / "service.pub"
    public.write_bytes(service_key.public_key().public_bytes_raw())
    public.chmod(0o600)
    path = tmp_path / "services.json"
    path.write_text(json.dumps({"schemaVersion": 1, "services": {"huohua.workbench": {
        "enabled": True, "upstream": "http://127.0.0.1:8093", "uid": 10006,
        "tokenAudience": "wanx-bridge", "protocolVersion": 1, "minWanxVersion": ">=1.0.0",
        "routes": [{"prefix": "/api/huohua/v1", "methods": ["GET", "POST"], "sse": True, "websocket": False}],
        "health": {"liveness": "/healthz", "readiness": "/readyz", "version": "/version"},
        "activation": {"mode": "legacy"}, "servicePublicKeyFile": str(public),
    }}}))
    path.chmod(0o600)
    return ServiceRegistry.load(path)


def test_service_proof_issues_scoped_token_and_rejects_replay(tmp_path):
    service_key = Ed25519PrivateKey.generate()
    verifier = ServiceSessionVerifier(setup_registry(tmp_path, service_key), Ed25519PrivateKey.generate())
    signature = service_proof_signature(service_key, "huohua.workbench", 1, "nonce-1")
    result = verifier.issue("huohua.workbench", protocol_version=1, nonce="nonce-1", signature=signature, user_id="7", space_id="space-a")
    claims = verifier.verify(result["access_token"], service_id="huohua.workbench", required_scope="workbench:read")
    assert claims["userId"] == "7"
    assert claims["spaceId"] == "space-a"
    with pytest.raises(BridgeAuthError, match="SERVICE_PROOF_REPLAY"):
        verifier.issue("huohua.workbench", protocol_version=1, nonce="nonce-1", signature=signature)


def test_service_token_rejects_wrong_audience(tmp_path):
    service_key = Ed25519PrivateKey.generate()
    verifier = ServiceSessionVerifier(setup_registry(tmp_path, service_key), Ed25519PrivateKey.generate())
    token = jwt.encode({"iss": "wanx-bridge", "aud": "other", "serviceId": "huohua.workbench", "boxId": "1", "protocolVersion": 1, "iat": 1, "exp": 9999999999, "jti": "j", "scope": ["workbench:read"]}, verifier.signing_key, algorithm="EdDSA")
    with pytest.raises(BridgeAuthError, match="SERVICE_TOKEN_INVALID"):
        verifier.verify(token)


def test_delegated_token_binds_upstream_credential_without_putting_it_in_jwt(tmp_path):
    service_key = Ed25519PrivateKey.generate()
    verifier = ServiceSessionVerifier(setup_registry(tmp_path, service_key), Ed25519PrivateKey.generate())
    token = verifier.issue_delegated(
        "huohua.workbench",
        protocol_version=1,
        box_id="box-1",
        user_id="7",
        space_id="space-a",
        scope=("workbench:read",),
        upstream_token="octop-secret",
    )
    claims = verifier.verify(token, service_id="huohua.workbench")
    assert "octop-secret" not in token
    assert verifier.delegated_upstream_token(token) == "octop-secret"
    assert claims["userId"] == "7"


def test_task_token_renews_within_bounded_lifetime_and_can_be_revoked(tmp_path):
    service_key = Ed25519PrivateKey.generate()
    verifier = ServiceSessionVerifier(setup_registry(tmp_path, service_key), Ed25519PrivateKey.generate())
    parent = verifier.issue_delegated(
        "huohua.workbench",
        protocol_version=1,
        box_id="box-1",
        user_id="7",
        space_id="space-a",
        scope=("workbench:read", "workbench:browser"),
        upstream_token="octop-secret",
    )
    created = verifier.issue_task(
        parent,
        task_id="browser-task-1",
        ttl_seconds=30,
        scope=("workbench:browser",),
    )
    claims = verifier.verify(
        created["access_token"],
        service_id="huohua.workbench",
        required_scope="workbench:browser",
    )
    assert claims["taskId"] == "browser-task-1"
    renewed = verifier.renew_task(
        created["access_token"], task_id="browser-task-1", ttl_seconds=60
    )
    with pytest.raises(BridgeAuthError, match="TASK_TOKEN_SUPERSEDED"):
        verifier.verify(created["access_token"])
    assert verifier.delegated_upstream_token(renewed["access_token"]) == "octop-secret"
    renewed_again = verifier.renew_task(
        renewed["renewal_token"], task_id="browser-task-1", ttl_seconds=60
    )
    assert renewed_again["taskId"] == "browser-task-1"
    verifier.revoke_task(renewed_again["renewal_token"], task_id="browser-task-1")
    with pytest.raises(BridgeAuthError, match="TASK_REVOKED"):
        verifier.verify(renewed_again["access_token"])
    with pytest.raises(BridgeAuthError, match="TASK_REVOKED"):
        verifier.revoke_task(renewed_again["access_token"], task_id="browser-task-1")
