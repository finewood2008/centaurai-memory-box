from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from centuarai_local_data_gate.native_policy import classify_octop
from centuarai_local_data_gate.protocol import DataProtocolError
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from wanx_bridge.memory_models import create_memory_model_router


@dataclass
class Model:
    id: str
    name: str
    max_output_tokens: int = 128
    native_tool_search: bool = True


def test_memory_completion_uses_current_box_model_and_authenticated_host():
    chosen = ["first"]
    invocations = []
    provider = SimpleNamespace(id="provider", name="Test", models=[Model("first", "First"), Model("second", "Second")])
    services = SimpleNamespace(
        settings_repo=SimpleNamespace(get_active_model=lambda: ("provider", chosen[0])),
        provider_repo=object(),
    )

    def current_user(request: Request):
        identity = request.headers.get("authorization")
        if not identity:
            raise HTTPException(401)
        return identity

    def build_chat_model(_provider, model):
        assert _provider is provider
        assert not model.native_tool_search

        async def invoke(messages, **options):
            invocations.append((model.id, messages, options))
            return SimpleNamespace(content='{"value": 1}', response_metadata={"finish_reason": "stop"},
                                   usage_metadata={"input_tokens": 5, "output_tokens": 4})

        return SimpleNamespace(ainvoke=invoke)

    async def close(_llm):
        pass

    app = FastAPI()
    app.include_router(create_memory_model_router(
        current_user=current_user,
        get_server=lambda: SimpleNamespace(services=services),
        application_id=lambda identity: identity,
        providers=lambda _: SimpleNamespace(build_harness_configs=lambda: [provider]),
        build_chat_model=build_chat_model,
        close_clients=close,
        text_content=lambda reply: reply.content,
    ))
    client = TestClient(app)
    route = "/api/wanx/memory-model"
    headers = {"authorization": "wanx"}
    assert client.get(route).status_code == 401
    assert client.get(route, headers={"authorization": "another-app"}).status_code == 403
    assert client.get(route, headers=headers).json() == {"model": "first", "name": "First", "provider": "Test"}
    chosen[0] = "second"
    payload = {"messages": [{"role": "user", "content": "synthetic prompt"}], "max_tokens": 4096, "json_mode": True}
    result = client.post(route + "/complete", headers=headers, json=payload)
    assert result.status_code == 200
    assert result.json() == {"text": '{"value": 1}', "model": "second", "finishReason": "stop",
                             "usage": {"input_tokens": 5, "output_tokens": 4}}
    assert invocations == [
        ("second", [("system", "Return only a valid JSON object, without Markdown fences."),
                    ("user", "synthetic prompt")], {"max_tokens": 128})
    ]
    assert client.post(route + "/complete", headers=headers, json={**payload, "model": "first"}).status_code == 422
    chosen[0] = "missing"
    assert client.post(route + "/complete", headers=headers, json=payload).status_code == 409
    assert len(invocations) == 1


def test_memory_model_local_trust_routes_are_host_only():
    route = "/api/wanx/memory-model"
    assert classify_octop("GET", route, "http", "wanx-host")["resourceId"] == "wanx"
    assert classify_octop("POST", route + "/complete", "http", "wanx-host")["action"] == "execute"
    with pytest.raises(DataProtocolError):
        classify_octop("POST", route + "/complete", "http", "centaurai.wanx.dialogue")
    with pytest.raises(DataProtocolError):
        classify_octop("GET", route + "?model=other", "http", "wanx-host")
