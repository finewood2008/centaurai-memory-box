"""Exercise the signed relay and inspect the final provider HTTP request."""

import hashlib
import hmac
import json
import time
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from langchain_openai import ChatOpenAI
from wanx_bridge.semantica import models
from wanx_bridge.semantica.client import SemanticaError


def setup_relay(tmp_path, *, adapter="thinking", toggle=True):
    config = {
        "service_token": "s" * 48,
        "box_id": "box",
        "application_id": "app",
        "service_url": "http://127.0.0.1:8090",
    }
    (tmp_path / "semantica.json").write_text(json.dumps(config))
    capability = {
        "supported": True,
        "adapter": adapter,
        "toggle": toggle,
        "default_mode": "auto",
        "efforts": ["high"],
        "default_effort": "high",
    }
    row = SimpleNamespace(
        id=1,
        name="fixture",
        kind="openai",
        base_url="https://fixture.invalid/v1",
        api_key="synthetic",
        extra_json=None,
        enabled=True,
        get_models=lambda: [
            {"id": "fixture-model", "enabled": True, "reasoning_config": capability}
        ],
    )
    services = SimpleNamespace(
        paths=SimpleNamespace(root=tmp_path),
        provider_repo=SimpleNamespace(list_all=lambda: [row]),
        user_repo=SimpleNamespace(
            get=lambda _: SimpleNamespace(
                username="fixture", disabled=False, role="admin", permissions=[]
            )
        ),
        audit_repo=SimpleNamespace(write=Mock()),
    )

    def signed(action, mode="off", **extra):
        selection = models._catalog(services)[0][0]
        raw = json.dumps(
            {
                "action": action,
                "owner": json.dumps(["box", "app", "wanx:1"]),
                "selection": selection,
                "inference_options": {"thinking_mode": mode},
                **extra,
            }
        ).encode()
        stamp, nonce = str(int(time.time())), uuid.uuid4().hex
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

    return row, services, signed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "adapter,mode,expected",
    [
        ("thinking", "off", {"thinking": {"type": "disabled"}}),
        ("thinking", "on", {"thinking": {"type": "enabled"}, "reasoning_effort": "high"}),
        ("thinking_nested_effort", "off", {"thinking": {"type": "disabled"}}),
        (
            "thinking_nested_effort",
            "on",
            {"thinking": {"type": "enabled", "reasoning_effort": "high"}},
        ),
        ("dashscope", "off", {"enable_thinking": False}),
        ("openai_reasoning_effort", "on", {"reasoning_effort": "high"}),
        ("openai_reasoning_effort", "off", {"reasoning_effort": "none"}),
        ("thinking", "auto", {}),
    ],
)
async def test_signed_check_sends_thinking_to_provider(
    tmp_path, monkeypatch, adapter, mode, expected
):
    row, services, signed = setup_relay(tmp_path, adapter=adapter)
    captured = []

    def respond(request):
        captured.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "synthetic",
                "object": "chat.completion",
                "created": 1,
                "model": "fixture-model",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": '{"ok":true}'},
                    }
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        monkeypatch.setattr(
            models,
            "build_probe_chat_model",
            lambda *a, **kw: ChatOpenAI(
                model="fixture-model",
                api_key="synthetic",
                base_url=row.base_url,
                http_async_client=client,
            ),
        )
        raw, headers = signed("check", mode)
        result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert result["inference_options"] == {"thinking_mode": mode}
    sent = captured[0]
    assert {
        k: sent[k] for k in ("thinking", "enable_thinking", "reasoning_effort") if k in sent
    } == expected
    assert json.loads(services.audit_repo.write.call_args.kwargs["payload"])[
        "inference_options"
    ] == {"thinking_mode": mode}


@pytest.mark.asyncio
async def test_unsupported_mode_never_calls_provider(tmp_path, monkeypatch):
    _, services, signed = setup_relay(tmp_path, adapter="status_only", toggle=False)
    generate = AsyncMock()
    monkeypatch.setattr(models, "_generate", generate)
    raw, headers = signed("check", "off")
    with pytest.raises(SemanticaError, match="MODEL_THINKING_UNSUPPORTED"):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    generate.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode,thinking,effort", [("auto", False, "none"), ("off", False, "none"), ("on", True, "high")]
)
async def test_local_ollama_explicit_mode_overrides_legacy_default(
    tmp_path, monkeypatch, mode, thinking, effort
):
    row, services, signed = setup_relay(tmp_path)
    row.base_url = "http://127.0.0.1:11434/v1"
    captured = []

    def respond(request):
        captured.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "fixture",
                "model": "fixture-model",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": '{"ok":true}'},
                    }
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        monkeypatch.setattr(
            models,
            "build_probe_chat_model",
            lambda *a, **kw: ChatOpenAI(
                model="fixture-model",
                api_key="synthetic",
                base_url=row.base_url,
                http_async_client=client,
            ),
        )
        raw, headers = signed("check", mode)
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert captured[0]["think"] is thinking
    assert captured[0]["reasoning_effort"] == effort


@pytest.mark.asyncio
@pytest.mark.parametrize("grant_mode", [None, "on", "off"])
async def test_infer_authorization_binds_options_twice(tmp_path, monkeypatch, grant_mode):
    _, services, signed = setup_relay(tmp_path)
    grant = {"authorized": True}
    if grant_mode:
        grant["inference_options"] = {"thinking_mode": grant_mode}
    authorize = AsyncMock(return_value=grant)
    monkeypatch.setattr(models.SemanticaClient, "request", authorize)
    generate = AsyncMock(return_value={"text": '{"ok":true}'})
    monkeypatch.setattr(models, "_generate", generate)
    raw, headers = signed(
        "infer", "off", job_id="synthetic-job", purpose="extraction", text="synthetic", schema={}
    )
    if grant_mode != "off":
        with pytest.raises(SemanticaError, match="MODEL_TASK_REVOKED"):
            await models.internal(raw, headers, services, AsyncMock(return_value=False))
        generate.assert_not_called()
    else:
        result = await models.internal(raw, headers, services, AsyncMock(return_value=False))
        assert result["inference_options"] == {"thinking_mode": "off"}
        assert authorize.await_count == 2
        for call in authorize.call_args_list:
            assert call.kwargs["payload"]["inference_options"] == {"thinking_mode": "off"}


@pytest.mark.parametrize(
    "options", [None, [], {"thinking_mode": "invalid"}, {"extra_body": {"api_key": "ignored"}}]
)
def test_options_are_closed(options):
    with pytest.raises(SemanticaError, match="MODEL_OPTIONS_INVALID"):
        models._inference_options({"inference_options": options})
