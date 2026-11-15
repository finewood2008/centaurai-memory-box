import hashlib
import hmac
import json
import time
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from wanx_bridge.semantica import models
from wanx_bridge.semantica.client import SemanticaError


@pytest.fixture
def fixture(tmp_path):
    config = {
        "service_token": "s" * 48,
        "box_id": "box",
        "application_id": "app",
        "service_url": "http://127.0.0.1:8090",
    }
    (tmp_path / "semantica.json").write_text(json.dumps(config))
    row = SimpleNamespace(
        id=1,
        name="fixture",
        kind="openai",
        base_url="http://127.0.0.1:11434/v1",
        api_key="fixture-key",
        extra_json=None,
        enabled=True,
        get_models=lambda: [{"id": "fixture-model", "enabled": True}],
    )
    services = SimpleNamespace(
        settings_repo=SimpleNamespace(get=lambda _: None, get_active_model=lambda: ("", "")),
        paths=SimpleNamespace(root=tmp_path),
        provider_repo=SimpleNamespace(list_all=lambda: [row]),
        user_repo=SimpleNamespace(
            get=lambda _: SimpleNamespace(
                username="fixture", disabled=False, role="admin", permissions=[]
            )
        ),
        audit_repo=SimpleNamespace(write=Mock()),
    )

    def signed(action="catalog", **extra):
        raw = json.dumps(
            {"action": action, "owner": json.dumps(["box", "app", "wanx:1"]), **extra}
        ).encode()
        stamp = str(int(time.time()))
        nonce = uuid.uuid4().hex
        signature = hmac.new(
            config["service_token"].encode(),
            stamp.encode() + b"." + nonce.encode() + b"." + raw,
            hashlib.sha256,
        ).hexdigest()
        return raw, {
            "x-starklink-time": stamp,
            "x-starklink-nonce": nonce,
            "x-starklink-signature": signature,
        }

    return services, row, signed


@pytest.mark.asyncio
@pytest.mark.parametrize("team", [False, True])
async def test_standalone_without_service_token_and_replay(fixture, team):
    services, _, signed = fixture
    extra = {"owner": json.dumps(["box", "app", "team:wanx"]), "actor_id": "wanx:1"} if team else {}
    raw, headers = signed(**extra)
    del headers["x-starklink-signature"]
    path = services.paths.root / "semantica.json"
    config = json.loads(path.read_text())
    del config["service_token"]
    path.write_text(json.dumps(config))
    result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["items"]
    with pytest.raises(SemanticaError, match="MODEL_REPLAY_DENIED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid", ["origin", "expired", "nonce", "owner", "disabled", "team_member"]
)
async def test_standalone_preserves_authorization(fixture, invalid):
    services, _, signed = fixture
    extra = {}
    if invalid == "owner":
        extra["owner"] = json.dumps(["other-box", "app", "wanx:1"])
    if invalid == "team_member":
        extra = {"owner": json.dumps(["box", "app", "team:wanx"]), "actor_id": "wanx:1"}
    raw, headers = signed(**extra)
    del headers["x-starklink-signature"]
    if invalid == "origin":
        headers["origin"] = "http://localhost:5173"
    if invalid == "expired":
        headers["x-starklink-time"] = str(int(time.time()) - 120)
    if invalid == "nonce":
        headers["x-starklink-nonce"] = "z" * 32
    if invalid in {"disabled", "team_member"}:
        services.user_repo.get = lambda _: SimpleNamespace(
            disabled=invalid == "disabled", role="user", permissions=["knowledge_bases"]
        )
    with pytest.raises(SemanticaError, match="MODEL_AUTH_REQUIRED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))


@pytest.mark.asyncio
async def test_admin_starlink_default_is_external_despite_loopback_proxy(fixture):
    services, row, signed = fixture
    row.name = "admin-managed-company"
    row.note = "wanx-admin-model-provider-v1:box"
    row.base_url = "http://127.0.0.1:18089/model-providers/company/v1"
    services.provider_repo.get_by_name = lambda name: row if name == row.name else None
    services.settings_repo.get = lambda _: json.dumps(
        {
            "managed": True,
            "revision": "1",
            "defaults": {
                "starlink": {"provider_name": row.name, "model": "fixture-model"},
            },
        }
    )
    raw, headers = signed()
    result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["managed"] is True
    assert result["default"] == result["items"][0]
    assert result["default"]["location"] == "external"
    from octop.infra.agents.providers.resolved import list_resolved_models

    entry = list_resolved_models([row])[0]
    previous_revision = hashlib.sha256(
        models._json(
            [
                row.id,
                row.kind,
                row.base_url,
                row.api_key,
                row.extra_json,
                entry,
            ]
        ).encode()
    ).hexdigest()
    assert result["default"]["revision"] != previous_revision
    old_selection = {**result["default"], "revision": previous_revision, "location": "local"}
    raw, headers = signed("check", selection=old_selection)
    with pytest.raises(SemanticaError, match="MODEL_CONFIG_CHANGED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    row.enabled = False
    raw, headers = signed()
    result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["managed"] is True and result["default"] is None


@pytest.mark.asyncio
async def test_starlink_follows_wanx_active_model_without_app_override(fixture):
    services, row, signed = fixture
    services.settings_repo.get_active_model = lambda: (row.name, "fixture-model")
    raw, headers = signed()
    result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["default"] == result["items"][0]
    assert result["default_source"] == "wanx_active"
    services.settings_repo.get_active_model = lambda: (row.name, "missing")
    raw, headers = signed()
    result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["default"] is None
    assert result["default_error"] == "MODEL_DEFAULT_UNAVAILABLE"


def test_admin_lease_rotation_keeps_model_identity_but_configuration_changes_do_not(fixture):
    services, row, _ = fixture
    row.name = "admin-managed-company"
    row.note = "wanx-admin-model-provider-v1:box"
    row.base_url = "http://127.0.0.1:18089/model-providers/company/v1"
    first = models._catalog(services)[0][0]["revision"]
    row.api_key = "rotated-lease"
    assert models._catalog(services)[0][0]["revision"] == first
    row.base_url = "http://127.0.0.1:18090/model-providers/company/v1"
    assert models._catalog(services)[0][0]["revision"] != first
    row.name = "manual"
    manual = models._catalog(services)[0][0]["revision"]
    row.api_key = "manual-key-change"
    assert models._catalog(services)[0][0]["revision"] != manual


@pytest.mark.asyncio
async def test_catalog_no_keys_and_replay_denied(fixture):
    services, row, signed = fixture
    raw, headers = signed()
    result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["items"][0]["location"] == "local"
    assert row.api_key not in json.dumps(result)
    with pytest.raises(SemanticaError, match="MODEL_REPLAY_DENIED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))


@pytest.mark.asyncio
async def test_revision_change_prevents_inference(fixture, monkeypatch):
    services, row, signed = fixture
    selected = models._catalog(services)[0][0]
    row.base_url = "https://changed.example/v1"
    generate = AsyncMock()
    monkeypatch.setattr(models, "_generate", generate)
    raw, headers = signed("check", selection=selected)
    with pytest.raises(SemanticaError, match="MODEL_CONFIG_CHANGED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    generate.assert_not_called()


@pytest.mark.asyncio
async def test_disabled_user_and_bad_signature(fixture):
    services, row, signed = fixture
    raw, headers = signed()
    headers["x-starklink-signature"] = "0" * 64
    with pytest.raises(SemanticaError, match="MODEL_AUTH_REQUIRED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    services.user_repo.get = lambda _: None
    raw, headers = signed()
    with pytest.raises(SemanticaError, match="MODEL_AUTH_REQUIRED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))


@pytest.mark.asyncio
async def test_team_callback_requires_a_real_wanx_administrator(fixture):
    services, _, signed = fixture
    owner = json.dumps(["box", "app", "team:wanx"])
    raw, headers = signed(owner=owner, actor_id="wanx:1")
    assert (await models.internal(raw, headers, services, AsyncMock(return_value=False)))["items"]
    for actor in ("", "access-key:key-1", "semantica:1"):
        raw, headers = signed(owner=owner, actor_id=actor)
        with pytest.raises(SemanticaError, match="MODEL_AUTH_REQUIRED"):
            await models.internal(raw, headers, services, AsyncMock(return_value=False))
    services.user_repo.get = lambda _: SimpleNamespace(
        username="member", disabled=False, role="user", permissions=["knowledge_bases"]
    )
    raw, headers = signed(owner=owner, actor_id="wanx:1")
    with pytest.raises(SemanticaError, match="MODEL_AUTH_REQUIRED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "grants", [[{}], [{"authorized": False}], [{"authorized": True}, {"authorized": False}]]
)
async def test_team_inference_stops_when_task_authorization_is_denied(fixture, monkeypatch, grants):
    services, _, signed = fixture
    selected = models._catalog(services)[0][0]
    authorize = AsyncMock(side_effect=grants)
    generate = AsyncMock(return_value={"text": "{}", "usage": None})
    monkeypatch.setattr(models.SemanticaClient, "request", authorize)
    monkeypatch.setattr(models, "_generate", generate)
    raw, headers = signed(
        "infer",
        owner=json.dumps(["box", "app", "team:wanx"]),
        actor_id="wanx:1",
        selection=selected,
        job_id="team-job",
        purpose="extraction",
        text="synthetic",
        schema={},
    )
    with pytest.raises(SemanticaError, match="MODEL_TASK_REVOKED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    generate.assert_not_called()
    assert authorize.await_count == len(grants)


@pytest.mark.asyncio
async def test_check_only_synthetic_text_and_unknown_usage_preserved(fixture, monkeypatch):
    services, row, signed = fixture
    selected = models._catalog(services)[0][0]

    async def generate(row, selection, text, schema, record):
        assert "合成" in text and "private text" not in text
        await record(None)
        return {"text": '{"ok":true}', "usage": None}

    monkeypatch.setattr(models, "_generate", generate)
    raw, headers = signed("check", selection=selected, text="private text")
    result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["usage"] is None
    payload = json.loads(services.audit_repo.write.call_args.kwargs["payload"])
    assert payload["accounting"] == "not_returned" and payload["usage"] is None
    assert "private text" not in json.dumps(payload)


@pytest.mark.parametrize(
    "address,local",
    [
        ("http://localhost:11434/v1", True),
        ("http://127.0.0.1:11434/v1", True),
        ("http://192.168.1.2/v1", False),
        ("https://api.example/v1", False),
    ],
)
def test_location_uses_endpoint_not_model_name(address, local):
    assert models._local(address) == local
