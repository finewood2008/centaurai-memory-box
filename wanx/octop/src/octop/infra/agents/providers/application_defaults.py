"""Non-secret application defaults projected from the device's Admin lease."""

from __future__ import annotations

import json
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

from octop.infra.agents.providers.store import ProviderStore

APPLICATION_DEFAULTS_KEY = "device_application_defaults"
Application = Literal["starlink", "dialogue", "kaiwu"]


class ApplicationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    provider_name: str = Field(pattern=r"^admin-managed-[a-z][a-z0-9-]{0,63}$")
    model: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$")


class ApplicationDefaultsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    managed: bool
    revision: str = Field(pattern=r"^(0|[1-9][0-9]{0,15})$")
    defaults: dict[Application, ApplicationModel] = Field(default_factory=dict)
    ready: bool = True


class ApplicationDefaultStatus(ApplicationModel):
    model_ref: str
    available: bool


class ApplicationDefaultsStatus(BaseModel):
    managed: bool
    revision: str
    defaults: dict[Application, ApplicationDefaultStatus]


def managed_provider(row: Any) -> bool:
    """Only a device-leased local inference proxy may supply Admin defaults."""
    name = getattr(row, "name", "")
    if not name.startswith("admin-managed-") or not (getattr(row, "note", None) or "").startswith(
        "wanx-admin-model-provider-v1:"
    ):
        return False
    try:
        url = urlsplit(row.base_url or "")
        _ = url.port
    except ValueError:
        return False
    return bool(
        url.scheme == "http"
        and url.hostname in {"localhost", "127.0.0.1", "::1"}
        and not (url.username or url.password or url.query or url.fragment)
        and url.path == f"/model-providers/{name.removeprefix('admin-managed-')}/v1"
    )


def write_application_defaults(services: Any, value: dict[str, Any]) -> None:
    config = ApplicationDefaultsConfig.model_validate(value)
    encoded = json.dumps(config.model_dump(), sort_keys=True, separators=(",", ":"))
    if services.settings_repo.get(APPLICATION_DEFAULTS_KEY) != encoded:
        services.settings_repo.set(APPLICATION_DEFAULTS_KEY, encoded)


def read_application_defaults(services: Any) -> dict[str, Any]:
    raw = services.settings_repo.get(APPLICATION_DEFAULTS_KEY)
    config = (
        ApplicationDefaultsConfig.model_validate_json(raw)
        if raw
        else ApplicationDefaultsConfig(managed=False, revision="0")
    )
    store = ProviderStore(services.provider_repo)
    defaults: dict[str, Any] = {}
    for application, selection in config.defaults.items():
        ref = f"{selection.provider_name}/{selection.model}"
        row = services.provider_repo.get_by_name(selection.provider_name)
        defaults[application] = {
            **selection.model_dump(),
            "model_ref": ref,
            "available": bool(
                config.managed
                and config.ready
                and row
                and managed_provider(row)
                and store.is_model_ref_usable(ref)
            ),
        }
    return {"managed": config.managed, "revision": config.revision, "defaults": defaults}


def resolve_application_default(services: Any, application: str) -> str | None:
    status = read_application_defaults(services)
    selected = status["defaults"].get(application)
    return str(selected["model_ref"]) if selected and selected["available"] else None
