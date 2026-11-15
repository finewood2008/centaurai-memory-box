"""Application defaults follow device policy without rewriting user selections."""

import json
from unittest.mock import Mock

import pytest

from octop.config import OctopConfig
from octop.infra.agents.providers.application_defaults import (
    read_application_defaults,
    resolve_application_default,
    write_application_defaults,
)
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import build_shared_services
from octop.infra.utils.paths import PathLayout


@pytest.fixture
def services(tmp_path):
    paths = PathLayout(tmp_path)
    db = SqlitePool(paths.db)
    run_migrations(db)
    try:
        yield build_shared_services(db=db, paths=paths, config=OctopConfig())
    finally:
        db.close()


def policy(model="deepseek-chat", revision="1", ready=True):
    return {
        "managed": True,
        "revision": revision,
        "ready": ready,
        "defaults": {"dialogue": {"provider_name": "admin-managed-company", "model": model}},
    }


def provider(services):
    return services.provider_repo.create(
        name="admin-managed-company",
        kind="openai",
        base_url="http://127.0.0.1:18089/model-providers/company/v1",
        api_key="private-token",
        note="wanx-admin-model-provider-v1:box",
        models_json=json.dumps([{"id": "deepseek-chat"}, {"id": "deepseek-next"}]),
    )


def test_late_admin_defaults_and_changes_do_not_overwrite_global_choice(services):
    assert read_application_defaults(services)["managed"] is False
    write_application_defaults(services, {"managed": True, "revision": "0", "defaults": {}})
    assert resolve_application_default(services, "dialogue") is None
    provider(services)
    services.settings_repo.set_active_model("manual", "local-model")
    write_application_defaults(services, policy())
    assert (
        resolve_application_default(services, "dialogue") == "admin-managed-company/deepseek-chat"
    )
    write_application_defaults(services, policy("deepseek-next", "2"))
    assert (
        resolve_application_default(services, "dialogue") == "admin-managed-company/deepseek-next"
    )
    assert services.settings_repo.get_active_model() == ("manual", "local-model")
    assert "private-token" not in json.dumps(read_application_defaults(services))


def test_unavailable_selection_keeps_reference_without_fallback(services):
    ident = provider(services)
    write_application_defaults(services, policy())
    services.provider_repo.update(ident, enabled=False)
    result = read_application_defaults(services)["defaults"]["dialogue"]
    assert result["model_ref"] == "admin-managed-company/deepseek-chat"
    assert result["available"] is False
    assert resolve_application_default(services, "dialogue") is None
    services.provider_repo.update(ident, enabled=True)
    write_application_defaults(services, policy(ready=False))
    assert resolve_application_default(services, "dialogue") is None


def test_identical_configuration_does_not_write_again(services, monkeypatch):
    set_value = Mock(wraps=services.settings_repo.set)
    monkeypatch.setattr(services.settings_repo, "set", set_value)
    write_application_defaults(services, policy())
    write_application_defaults(services, policy())
    assert set_value.call_count == 1


def test_manual_provider_cannot_impersonate_device_default(services):
    ident = provider(services)
    services.provider_repo.update(ident, note="user-created")
    write_application_defaults(services, policy())
    assert resolve_application_default(services, "dialogue") is None


@pytest.mark.parametrize(
    "value",
    [
        {**policy(), "defaults": {"unknown": {"provider_name": "x", "model": "x"}}},
        {**policy(), "revision": "-1"},
        {**policy(), "api_key": "must-not-be-stored"},
    ],
)
def test_invalid_policy_is_not_persisted(services, value):
    with pytest.raises(ValueError):
        write_application_defaults(services, value)
    assert read_application_defaults(services)["managed"] is False
