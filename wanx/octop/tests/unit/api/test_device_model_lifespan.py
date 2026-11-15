"""Required-model composition keeps manual providers and closes its resources."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from centuarai_local_data_gate import GateConfig
from centuarai_local_data_gate.protocol import DataProtocolError, public_jwk, public_key_thumbprint
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI

from octop.api.device_models import device_model_lifespan


def context(tmp_path: Path) -> tuple[FastAPI, Any, GateConfig]:
    key = public_jwk(ec.generate_private_key(ec.SECP256R1()))
    gate = GateConfig(
        audience="octop",
        gateway_id="gateway",
        gateway_key=key,
        box_id="box-native",
        box_key_thumbprint=public_key_thumbprint(key),
        broker_socket=str(tmp_path / "broker.sock"),
        staging_directory=tmp_path / "staging",
    )
    app = FastAPI()
    app.state.local_data_required = True
    app.state.local_data_gate_config = gate
    app.state.local_data_required_policy = {"boxId": gate.box_id}

    async def changed(**_event: Any) -> None:
        pass

    server = SimpleNamespace(
        database_bound=True,
        services=SimpleNamespace(paths=SimpleNamespace(root=tmp_path)),
        app_runtime=SimpleNamespace(agent_registry=SimpleNamespace(on_provider_changed=changed)),
    )
    return app, server, gate


async def test_manual_provider_required_relay_is_composed_and_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from wanx_bridge import native_model_service as native
    from wanx_bridge.model_provider_catalog import ModelProviderConfig

    app, server, gate = context(tmp_path)
    filename = tmp_path / "semantica.json"
    filename.write_text("{}")
    monkeypatch.setattr(ModelProviderConfig, "from_env", lambda: None)
    calls = []
    closed = []

    @asynccontextmanager
    async def service(config: Any, projection: Any, **kwargs: Any):
        calls.append((config, projection, kwargs))
        try:
            yield None
        finally:
            closed.append(True)

    monkeypatch.setattr(native, "native_model_service", service)
    with pytest.raises(ValueError, match="synthetic caller failure"):
        async with device_model_lifespan(app, server):
            assert len(calls) == 1
            assert calls[0][0] is None
            assert calls[0][2] == {
                "gate_config": gate,
                "semantica_config_file": filename,
                "semantica_state_dir": tmp_path,
            }
            assert app.state.device_model_runtime is None
            raise ValueError("synthetic caller failure")
    assert closed == [True]
    assert app.state.device_model_runtime is None


async def test_managed_provider_keeps_runtime_tracking_and_context_cleanup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from wanx_bridge import native_model_service as native
    from wanx_bridge.model_provider_catalog import ModelProviderConfig

    app, server, gate = context(tmp_path)
    config = SimpleNamespace(identity_device_id=gate.box_id)
    runtime = object()
    seen = []
    closed = []
    monkeypatch.setattr(ModelProviderConfig, "from_env", lambda: config)

    @asynccontextmanager
    async def service(value: Any, _projection: Any, **kwargs: Any):
        seen.append((value, kwargs))
        try:
            yield runtime
        finally:
            closed.append(True)

    monkeypatch.setattr(native, "native_model_service", service)
    async with device_model_lifespan(app, server):
        assert app.state.device_model_runtime is runtime
        assert seen == [
            (
                config,
                {
                    "gate_config": gate,
                    "semantica_config_file": tmp_path / "semantica.json",
                    "semantica_state_dir": tmp_path,
                },
            )
        ]
    assert closed == [True]
    assert app.state.device_model_runtime is None


@pytest.mark.parametrize("disabled", ["legacy", "unbound", "missing-gate"])
async def test_no_private_listener_without_required_native_gate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    disabled: str,
) -> None:
    from wanx_bridge.model_provider_catalog import ModelProviderConfig

    app, server, _gate = context(tmp_path)
    if disabled == "legacy":
        app.state.local_data_required = False
    elif disabled == "unbound":
        server.database_bound = False
    else:
        del app.state.local_data_gate_config

    def unexpected():
        raise AssertionError("provider config must not be read without native gate")

    monkeypatch.setattr(ModelProviderConfig, "from_env", unexpected)
    async with device_model_lifespan(app, server):
        pass


async def test_no_manual_listener_when_semantica_is_not_configured(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from wanx_bridge import native_model_service as native
    from wanx_bridge.model_provider_catalog import ModelProviderConfig

    app, server, _gate = context(tmp_path)
    monkeypatch.setattr(ModelProviderConfig, "from_env", lambda: None)

    @asynccontextmanager
    async def unexpected(*_args: Any, **_kwargs: Any):
        raise AssertionError("no model service is configured")
        yield

    monkeypatch.setattr(native, "native_model_service", unexpected)
    async with device_model_lifespan(app, server):
        assert app.state.device_model_runtime is None


async def test_managed_provider_keeps_root_policy_identity_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from wanx_bridge import native_model_service as native
    from wanx_bridge.model_provider_catalog import ModelProviderConfig

    app, server, _gate = context(tmp_path)
    monkeypatch.setattr(
        ModelProviderConfig, "from_env", lambda: SimpleNamespace(identity_device_id="other-box")
    )
    entered = []

    @asynccontextmanager
    async def service(*_args: Any, **_kwargs: Any):
        entered.append(True)
        yield object()

    monkeypatch.setattr(native, "native_model_service", service)
    async with device_model_lifespan(app, server):
        assert app.state.device_model_runtime is None
    assert entered == []
    assert "MODEL_PROVIDER_DEVICE_IDENTITY_MISMATCH" in caplog.text


@pytest.mark.parametrize(
    "error", [RuntimeError("synthetic-provider-secret"), DataProtocolError("LOCAL_DATA_REQUIRED")]
)
async def test_private_model_start_failure_preserves_native_application(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
) -> None:
    from wanx_bridge import native_model_service as native
    from wanx_bridge.model_provider_catalog import ModelProviderConfig

    app, server, _gate = context(tmp_path)
    (tmp_path / "semantica.json").write_text("{}")
    monkeypatch.setattr(ModelProviderConfig, "from_env", lambda: None)

    @asynccontextmanager
    async def failed(*_args: Any, **_kwargs: Any):
        raise error
        yield

    monkeypatch.setattr(native, "native_model_service", failed)
    async with device_model_lifespan(app, server):
        assert app.state.device_model_runtime is None
    assert caplog.text
    assert "synthetic-provider-secret" not in caplog.text
