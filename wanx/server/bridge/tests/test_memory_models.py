"""Memory uses the production host registration seam and existing leased relay."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI, Header, HTTPException, Request
from wanx_bridge.semantica.host_routes import create_host_routers
from wanx_bridge.server import _allowed


def test_octop_bootstrap_registers_memory_models_once(tmp_path):
    from octop.api.app import build_app
    from octop.infra.server import OctopServer
    from wanx_bridge.memory_models import create_memory_model_router

    with patch("wanx_bridge.memory_models.create_memory_model_router",
               wraps=create_memory_model_router) as register:
        app = build_app(OctopServer(home=tmp_path))
    assert register.call_count == 1
    paths = app.openapi()["paths"]
    for path, method in [
        ("/api/wanx/memory-model", "GET"),
        ("/api/wanx/memory-model/complete", "POST"),
    ]:
        assert method.lower() in paths[path]


@pytest.fixture
async def memory_host():
    state = SimpleNamespace(allowed=True, app="wanx", enabled=True, calls=[], closed=[], slow=False,
                            cancelled=False, build_rows=[])
    rows = [SimpleNamespace(id=1, name="test", base_url="https://byok.example/v1"),
            SimpleNamespace(id=2, name="admin-managed-qeetoken",
                            base_url="http://127.0.0.1:18089/model-providers/qeetoken/v1")]
    items = [
        {"provider_id": 1, "provider_name": "test", "model": "summary",
         "name": "Summary", "input": ["text"], "max_output_tokens": 64},
        {"provider_id": 2, "provider_name": "admin-managed-qeetoken", "model": "evolution",
         "name": "Evolution", "input": ["text"]},
    ]
    state.active = ("test", "summary")
    services = SimpleNamespace(
        provider_repo=SimpleNamespace(list_all=lambda: rows),
        settings_repo=SimpleNamespace(get_active_model=lambda: state.active),
    )

    async def current(request: Request, authorization: str | None = Header(None),
                      server=None, access_token=None):
        if authorization != "Bearer synthetic-native" or not state.allowed:
            raise HTTPException(401)
        return SimpleNamespace(id=7, application_id=state.app)

    # Keep FastAPI's dependency surface finite; manual revalidation uses current.
    async def dependency(request: Request, authorization: str | None = Header(None)):
        return await current(request, authorization)

    class Model:
        max_retries = 3

        async def ainvoke(self, messages, **kwargs):
            state.calls.append((messages, kwargs))
            if state.slow:
                try:
                    await asyncio.sleep(10)
                except asyncio.CancelledError:
                    state.cancelled = True
                    raise
            return SimpleNamespace(content='{"ok":true}', response_metadata={"finish_reason": "stop"},
                                   usage_metadata={"input_tokens": 10, "output_tokens": 5})

    def builder(row, *, model_id):
        state.build_rows.append((row, model_id))
        return Model()

    async def close(model):
        state.closed.append(model)

    host = SimpleNamespace(
        list_resolved_models=lambda rows: items if state.enabled else [],
        managed_provider=lambda row: row.base_url.startswith("http://127.0.0.1:18089/model-providers/"),
        build_probe_chat_model=builder, aclose_session_http_clients=close,
        llm_text_content=lambda result: result.content,
    )
    public, root = create_host_routers(
        current_user=current, get_server=lambda: SimpleNamespace(services=services),
        require_permission=lambda key: dependency,
        application_id=lambda user: user.application_id, model_host=host,
    )
    app = FastAPI()
    app.include_router(public, prefix="/api")
    app.include_router(root)
    app.dependency_overrides[current] = dependency
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://local",
                                headers={"authorization": "Bearer synthetic-native"}) as client:
        yield state, client, host, app


def completion(**changes):
    return {"messages": [{"role": "user", "content": "Synthetic import"}],
            "max_tokens": 256, "json_mode": True, **changes}


async def test_production_host_registers_memory_routes(memory_host):
    state, client, _, app = memory_host
    result = await client.get("/api/wanx/memory-model")
    assert result.status_code == 200, result.text
    assert result.json()["model"] == "summary"
    assert result.json()["capabilities"]["memory_summary"]["defaultRef"] == "test/summary"
    assert result.json()["capabilities"]["memory_evolution"]["models"][1]["provider_name"] == "admin-managed-qeetoken"
    assert "base_url" not in result.text and "api_key" not in result.text
    assert "/api/wanx/memory-model/complete" in app.openapi()["paths"]
    assert _allowed("/api/wanx/memory-model", "GET")
    assert _allowed("/api/wanx/memory-model/complete", "POST")


async def test_media_catalog_has_no_text_model_requirement(memory_host):
    state, client, host, _ = memory_host
    state.active = (None, None)
    host.memory_model_inventory = lambda _: {
        "asr": {"model": "fixture-audio"},
        "image_generation": {"models": [], "defaultRef": None},
    }
    reply = await client.get("/api/wanx/memory-model")
    assert reply.status_code == 200
    data = reply.json()
    assert data["model"] is None
    assert data["capabilities"]["asr"]["model"] == "fixture-audio"
    assert data["capabilities"]["memory_summary"]["defaultRef"] is None


async def test_native_auth_and_application_scope_are_enforced(memory_host):
    state, client, _, _ = memory_host
    assert (await client.get("/api/wanx/memory-model", headers={"authorization": "bad"})).status_code == 401
    state.app = "other-app"
    assert (await client.get("/api/wanx/memory-model")).status_code == 403
    assert (await client.post("/api/wanx/memory-model/complete", json=completion())).status_code == 403
    assert not state.calls


async def test_roles_select_current_enabled_provider_and_preserve_local_managed_relay(memory_host):
    state, client, _, _ = memory_host
    response = await client.post("/api/wanx/memory-model/complete", json=completion())
    assert response.status_code == 200, response.text
    assert state.calls[-1][1]["max_tokens"] == 64
    assert state.calls[-1][0][0][0] == "system"
    selected = completion(role="memory_evolution", model_ref="admin-managed-qeetoken/evolution")
    response = await client.post("/api/wanx/memory-model/complete", json=selected)
    assert response.status_code == 200, response.text
    row, model = state.build_rows[-1]
    assert row.base_url == "http://127.0.0.1:18089/model-providers/qeetoken/v1"
    assert model == "evolution"
    assert response.json()["usage"] == {"input_tokens": 10, "output_tokens": 5}
    state.enabled = False
    assert (await client.post("/api/wanx/memory-model/complete", json=selected)).status_code == 409
    assert len(state.calls) == 2
    assert len(state.closed) == 2


@pytest.mark.parametrize("changes", [
    {"role": "agent"}, {"model_ref": "test/summary"}, {"max_tokens": True},
    {"max_tokens": 0}, {"endpoint": "https://untrusted.example"},
])
async def test_invalid_selection_cannot_reach_model(memory_host, changes):
    state, client, _, _ = memory_host
    response = await client.post("/api/wanx/memory-model/complete", json=completion(**changes))
    assert response.status_code == 422
    assert not state.calls


async def test_unknown_or_unbound_managed_reference_is_denied(memory_host):
    state, client, host, _ = memory_host
    payload = completion(role="memory_summary", model_ref="test/missing")
    assert (await client.post("/api/wanx/memory-model/complete", json=payload)).status_code == 409
    host.managed_provider = lambda row: False
    payload["model_ref"] = "admin-managed-qeetoken/evolution"
    assert (await client.post("/api/wanx/memory-model/complete", json=payload)).status_code == 409
    assert not state.calls


async def test_native_identity_revocation_cancels_inference(memory_host):
    state, client, _, _ = memory_host
    state.slow = True
    pending = asyncio.create_task(client.post("/api/wanx/memory-model/complete", json=completion()))
    while not state.calls:
        await asyncio.sleep(0.01)
    state.allowed = False
    response = await pending
    assert response.status_code == 401
    assert state.cancelled
    assert len(state.closed) == 1


async def test_cleanup_errors_preserve_completion_result_or_original_failure(memory_host):
    state, client, host, _ = memory_host

    async def close(model):
        state.closed.append(model)
        raise RuntimeError("synthetic cleanup failure")

    host.aclose_session_http_clients = close
    response = await client.post("/api/wanx/memory-model/complete", json=completion())
    assert response.status_code == 200, response.text
    assert response.json()["text"] == '{"ok":true}'
    assert len(state.closed) == 1

    class Broken:
        max_retries = 0

        async def ainvoke(self, *_args, **_kwargs):
            raise ValueError("synthetic upstream failure")

    host.build_probe_chat_model = lambda row, model_id: Broken()
    state.closed.clear()
    response = await client.post("/api/wanx/memory-model/complete", json=completion())
    assert response.status_code == 502
    assert len(state.closed) == 1


async def test_managed_completion_enters_existing_authorized_cloud_relay(memory_host):
    # The same ModelProviderRuntime used by installed boxes owns cloud credentials
    # and checks live leases. The memory route receives only its opaque local row.
    from test_model_provider_runtime import runtime

    upstream = []

    async def billed_provider(request):
        upstream.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok":true}'}}],
                                        "usage": {"prompt_tokens": 9, "completion_tokens": 4}})

    rt, catalog, admin = runtime(billed_provider)
    await rt.reconcile()
    relay = FastAPI()
    rt.register_routes(relay)
    local_client = httpx.AsyncClient(transport=httpx.ASGITransport(relay), base_url="http://127.0.0.1:18089")
    state, client, host, _ = memory_host
    projected = admin.rows[0]
    # Use the actual projected relay credential; no cloud key enters host routing.
    state.enabled = True
    host.list_resolved_models = lambda rows: [{"provider_id": 2, "model": "chat-model", "input": ["text"]}]

    class LeasedModel:
        max_retries = 0

        async def ainvoke(self, messages, **kwargs):
            result = await local_client.post(projected["base_url"] + "/chat/completions",
                headers={"authorization": "Bearer " + projected["api_key"]},
                json={"model": "chat-model", "messages": [{"role": role, "content": text}
                      for role, text in messages], **kwargs})
            result.raise_for_status()
            value = result.json()
            return SimpleNamespace(content=value["choices"][0]["message"]["content"],
                response_metadata={}, usage_metadata=value["usage"])

    host.build_probe_chat_model = lambda row, model_id: LeasedModel()
    payload = completion(role="memory_summary", model_ref="admin-managed-qeetoken/chat-model")
    try:
        response = await client.post("/api/wanx/memory-model/complete", json=payload)
        assert response.status_code == 200, response.text
        assert len(upstream) == 1
        assert upstream[0].url == "https://models.example.com/v1/chat/completions"
        assert upstream[0].headers["authorization"] == "Bearer supplier-secret-never-persist"
        assert projected["api_key"] != catalog.value["providers"][0]["apiKey"]
        assert json.loads(upstream[0].content)["model"] == "chat-model"
        catalog.expired = True
        assert (await client.post("/api/wanx/memory-model/complete", json=payload)).status_code == 502
        assert len(upstream) == 1
    finally:
        await local_client.aclose()
        await rt.close()


async def test_invalid_active_default_keeps_catalog_available_for_explicit_selection(memory_host):
    state, client, _, _ = memory_host
    state.active = ("missing", "old-model")
    response = await client.get("/api/wanx/memory-model")
    assert response.status_code == 200
    catalog = response.json()
    assert catalog["model"] is None
    assert catalog["capabilities"]["memory_summary"]["defaultRef"] is None
    assert len(catalog["capabilities"]["memory_summary"]["models"]) == 2
    assert (await client.post("/api/wanx/memory-model/complete", json=completion())).status_code == 409
    explicit = completion(role="memory_summary", model_ref="test/summary")
    assert (await client.post("/api/wanx/memory-model/complete", json=explicit)).status_code == 200
