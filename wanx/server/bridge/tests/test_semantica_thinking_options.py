"""The private callback binds thinking controls to model capability and live tasks."""

import hashlib
import json
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from test_semantica_model_relay import call, selection, usage_rows
from test_semantica_model_relay import relay as _shared_relay

from wanx_bridge.model_reasoning import verified_reasoning
from wanx_bridge.semantica import models
from wanx_bridge.semantica.model_options import thinking_overrides

relay = _shared_relay


def capable(relay):
    relay.model["reasoning_config"] = verified_reasoning(
        "https://token.qeeshu.com/v1", "deepseek-flash"
    )


@pytest.mark.parametrize("mode", ["off", "on", "auto"])
@pytest.mark.parametrize("action", ["check", "infer"])
async def test_control_reaches_provider_and_is_acknowledged(relay, mode, action):
    capable(relay)
    options = {"thinking_mode": mode}
    relay.authorized = {"authorized": True, "inference_options": options}
    response = await call(relay, action=action, inference_options=options)
    assert response.status_code == 200, response.text
    assert response.json()["inference_options"] == options
    assert usage_rows(relay)[0]["inference_options"] == options
    payload = json.loads(next(r for r in relay.calls if r.url.host == "model").content)
    if mode == "auto":
        assert "thinking" not in payload and "reasoning_effort" not in payload
    else:
        assert payload["thinking"] == {"type": "disabled" if mode == "off" else "enabled"}
        assert payload["reasoning_effort"] == ("none" if mode == "off" else "high")
    grants = [json.loads(r.content) for r in relay.calls if r.url.host == "semantica"]
    assert all(g.get("inference_options", {"thinking_mode": "auto"}) == options for g in grants)


@pytest.mark.parametrize(
    "options,code",
    [
        ({"thinking_mode": "off"}, "MODEL_THINKING_UNSUPPORTED"),
        ({"thinking_mode": "invalid"}, "MODEL_OPTIONS_INVALID"),
        ({"thinking_mode": "off", "arbitrary": True}, "MODEL_OPTIONS_INVALID"),
        (None, "MODEL_OPTIONS_INVALID"),
    ],
)
async def test_invalid_or_unadvertised_mode_never_calls_model(relay, options, code):
    response = await call(relay, inference_options=options)
    assert response.status_code == 422 and response.json()["code"] == code
    assert not any(r.url.host == "model" for r in relay.calls)


@pytest.mark.parametrize(
    "grant",
    [{"authorized": True}, {"authorized": True, "inference_options": {"thinking_mode": "on"}}],
)
async def test_task_must_confirm_explicit_mode(relay, grant):
    capable(relay)
    relay.authorized = grant
    response = await call(relay, inference_options={"thinking_mode": "off"})
    assert response.status_code == 403 and response.json()["code"] == "MODEL_TASK_REVOKED"
    assert not any(r.url.host == "model" for r in relay.calls)


async def test_mode_is_rechecked_after_model_response(relay):
    capable(relay)
    relay.authorized = {"authorized": True, "inference_options": {"thinking_mode": "off"}}

    async def handle(request):
        relay.authorized = {"authorized": True, "inference_options": {"thinking_mode": "on"}}
        return httpx.Response(200, json=relay.output)

    relay.handler = handle
    response = await call(relay, inference_options={"thinking_mode": "off"})
    assert response.status_code == 403 and response.json()["code"] == "MODEL_TASK_REVOKED"


async def test_capability_is_advertised_and_bound_to_revision(relay):
    old = await selection(relay)
    assert old["inference_options"] == {"thinking_modes": ["auto"]}
    capable(relay)
    new = await selection(relay)
    assert new["revision"] != old["revision"]
    assert new["inference_options"] == {"thinking_modes": ["auto", "on", "off"]}
    response = await call(relay, selection=old, inference_options={"thinking_mode": "off"})
    assert response.status_code == 409 and response.json()["code"] == "MODEL_CONFIG_CHANGED"


def test_host_uses_shared_controls_and_existing_parameter_builder(monkeypatch):
    capability = verified_reasoning("https://token.qeeshu.com/v1", "deepseek-flash")
    builder = Mock(
        return_value={"extra_body": {"thinking": {"type": "disabled"}, "reasoning_effort": "none"}}
    )
    monkeypatch.setattr(models, "reasoning_request_parameters", builder)
    result = models._thinking_overrides(
        SimpleNamespace(kind="openai", base_url="http://proxy/v1"),
        {"reasoning_config": capability},
        "off",
    )
    assert result["extra_body"]["reasoning_effort"] == "none"
    assert builder.call_args.kwargs == {"mode": "disabled", "effort": "none"}


async def test_ollama_on_off_control(relay):
    capable(relay)
    relay.provider["kind"] = "ollama"
    relay.output = {"done": True, "message": {"content": '{"ok":true}'}}
    for mode in ("on", "off"):
        relay.authorized = {"authorized": True, "inference_options": {"thinking_mode": mode}}
        response = await call(relay, inference_options={"thinking_mode": mode})
        assert response.status_code == 200, response.text
        payload = json.loads(
            next(r for r in reversed(relay.calls) if r.url.host == "model").content
        )
        assert payload["think"] is (mode == "on")


@pytest.mark.parametrize("fields", [{}, {"inference_options": {"thinking_mode": "auto"}}])
async def test_auto_request_rejects_a_contradictory_task_acknowledgment(relay, fields):
    relay.authorized = {"authorized": True, "inference_options": {"thinking_mode": "off"}}
    response = await call(relay, **fields)
    assert response.status_code == 403
    assert not any(r.url.host == "model" for r in relay.calls)


async def test_unaffected_model_keeps_legacy_revision(relay):
    base = relay.provider["base_url"]
    values = [
        "wanx-model-contract-v2",
        {key: relay.provider.get(key) for key in ("id", "kind", "api_key")},
        base,
        {
            key: relay.model.get(key)
            for key in ("model", "input", "context_window", "max_output_tokens")
        },
        "external",
    ]
    expected = hashlib.sha256(
        json.dumps(values, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    assert (await selection(relay))["revision"] == expected


@pytest.mark.parametrize(
    "adapter",
    ["thinking", "thinking_nested_effort", "openai_reasoning_effort", "dashscope", "openrouter"],
)
def test_explicit_on_does_not_inherit_disabled_effort(adapter):
    cap = {
        "supported": True,
        "toggle": True,
        "adapter": adapter,
        "efforts": ["none", "high"],
        "default_effort": "none",
    }
    result = thinking_overrides(
        {"kind": "openai", "base_url": "http://model/v1"}, {"reasoning_config": cap}, "on"
    )
    assert '"none"' not in json.dumps(result)
    assert "high" in json.dumps(result)


@pytest.mark.parametrize(
    "adapter",
    [
        "thinking",
        "thinking_nested_effort",
        "openai_reasoning_effort",
        "dashscope",
        "openrouter",
        "anthropic_adaptive",
        "anthropic_budget",
    ],
)
@pytest.mark.parametrize("mode", ["on", "off"])
def test_private_and_host_parameter_builders_agree(adapter, mode):
    from octop.infra.agents.providers.reasoning import reasoning_request_parameters

    cap = {
        "supported": True,
        "toggle": True,
        "adapter": adapter,
        "efforts": ["none", "high"],
        "default_effort": "none",
    }
    provider = {"kind": "openai", "base_url": "http://model/v1"}
    private = thinking_overrides(provider, {"reasoning_config": cap}, mode)
    host = thinking_overrides(
        provider, {"reasoning_config": cap}, mode, builder=reasoning_request_parameters
    )
    for key in ("model_fields", "extra_body"):
        assert private.get(key, {}) == host.get(key, {})


def test_explicit_on_preserves_unspecified_effort_for_thinking_adapter():
    cap = {
        "supported": True,
        "toggle": True,
        "adapter": "thinking",
        "efforts": ["low", "high"],
        "default_effort": None,
    }
    result = thinking_overrides(
        {"kind": "openai", "base_url": "http://model/v1"}, {"reasoning_config": cap}, "on"
    )
    assert result["extra_body"] == {"thinking": {"type": "enabled"}}
