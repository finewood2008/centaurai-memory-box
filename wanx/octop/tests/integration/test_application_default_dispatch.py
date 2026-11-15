"""Admin lease → native WANX selection → real SDK → recorded supplier HTTP.

Only the remote Admin/supplier transports use synthetic responses. Real catalog
validation, SQLite projection, private listener, application selectors and model
SDKs run. The always-on Codex assertion covers its resolved launch configuration
and Responses request; an explicit native binary also qualifies a real controlled
app-server turn. Neither is customer inference or real supplier billing.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import hmac
import json
import os
import time
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from wanx_bridge.semantica import models as starlink

from octop.config import OctopConfig
from octop.infra.agents.providers.application_defaults import read_application_defaults
from octop.infra.agents.providers.device_projection import DeviceProviderProjection
from octop.infra.agents.providers.resolved import list_resolved_models
from octop.infra.agents.providers.store import ProviderStore
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import build_shared_services
from octop.infra.utils.paths import PathLayout

FLASH = "deepseek-flash"
CODING = "gpt-6.1-sol"
NEXT = "deepseek-v4-flash"
PROVIDER = "admin-managed-qeetoken"


def stamp(value):
    return datetime.fromtimestamp(value, UTC).isoformat()


@pytest.fixture
async def dispatch(tmp_path, monkeypatch, repo_root):
    from octop.infra.bridge_dependencies import semantica_model_host

    monkeypatch.setattr(starlink, "_host", semantica_model_host())
    monkeypatch.syspath_prepend(str(repo_root.parent / "server" / "bridge"))
    monkeypatch.syspath_prepend(str(repo_root.parent / "apps" / "builder" / "backend"))
    monkeypatch.setenv("WANX_MODEL_PROVIDERS_ENABLED", "1")
    from wanx_bridge.model_provider_catalog import ModelProviderCatalog, ModelProviderConfig
    from wanx_bridge.native_model_service import native_model_service

    paths = PathLayout(tmp_path / "octop")
    paths.ensure_root()
    db = SqlitePool(paths.db)
    run_migrations(db)
    services = build_shared_services(db=db, paths=paths, config=OctopConfig())
    user_id = services.user_repo.create(username="synthetic-owner", role="admin")
    key = tmp_path / "device-key"
    key.write_text("synthetic-device-authentication-key")
    key.chmod(0o600)
    now = int(time.time())
    state = SimpleNamespace(
        now=now,
        mono=1000,
        status=200,
        supplier_key="synthetic-initial-supplier-credential",
        calls=[],
        admin_headers=[],
        owner_current=True,
        value={
            "schemaVersion": 2,
            "deviceId": "synthetic-box",
            "bindingId": "synthetic-binding",
            "ownerAccountId": "synthetic-owner",
            "ownershipEpoch": 1,
            "authVersion": 1,
            "issuedAt": stamp(now),
            "expiresAt": stamp(now + 300),
            "providers": [
                {
                    "providerId": "qeetoken",
                    "displayName": "QeeToken",
                    "configVersion": "1",
                    "enabled": True,
                    "protocol": "openai-compatible",
                    "baseUrl": "https://models.example.com/v1",
                    "apiKey": "synthetic-initial-supplier-credential",
                    "allowedProducts": ["wanxiang", "zhijun"],
                    "allowedModels": [FLASH, NEXT, CODING],
                }
            ],
            "applicationDefaults": {"revision": "0", "defaults": {}},
        },
    )

    def admin(request):
        state.admin_headers.append(dict(request.headers))
        ident = request.headers["X-Request-Id"]
        if state.status != 200:
            return httpx.Response(state.status)
        data = copy.deepcopy(state.value)
        if request.method == "POST":
            data = {"accepted": True, "providers": json.loads(request.content)["providers"]}
        return httpx.Response(
            200,
            headers={"X-Request-Id": ident},
            json={
                "success": True,
                "msg": "",
                "errorCode": None,
                "data": data,
                "requestId": ident,
                "serverTime": stamp(state.now),
            },
        )

    def supplier(request):
        body = json.loads(request.content)
        assert request.url.host == "models.example.com"
        assert hmac.compare_digest(request.headers["authorization"], "Bearer " + state.supplier_key)
        state.calls.append({"path": request.url.path, "model": body["model"]})
        if request.url.path == "/v1/responses":
            response = {
                "id": "resp-synthetic",
                "object": "response",
                "created_at": state.now,
                "status": "completed",
                "model": body["model"],
                "output": [
                    {
                        "type": "message",
                        "id": "msg-synthetic",
                        "status": "completed",
                        "role": "assistant",
                        "content": [
                            {"type": "output_text", "text": '{"ok":true}', "annotations": []}
                        ],
                    }
                ],
                "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
            }
            if body.get("stream"):
                message = response["output"][0]
                events = [
                    {
                        "type": "response.created",
                        "response": {**response, "status": "in_progress", "output": []},
                    },
                    {
                        "type": "response.output_item.added",
                        "output_index": 0,
                        "item": {**message, "status": "in_progress", "content": []},
                    },
                    {
                        "type": "response.output_text.delta",
                        "item_id": message["id"],
                        "output_index": 0,
                        "content_index": 0,
                        "delta": '{"ok":true}',
                    },
                    {"type": "response.output_item.done", "output_index": 0, "item": message},
                    {"type": "response.completed", "response": response},
                ]
                return httpx.Response(
                    200,
                    headers={"content-type": "text/event-stream"},
                    content="".join(
                        "event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n"
                        for event in events
                    ),
                )
            return httpx.Response(200, json=response)
        assert request.url.path == "/v1/chat/completions"
        if body.get("stream"):
            chunks = [
                {
                    "id": "chatcmpl-synthetic",
                    "object": "chat.completion.chunk",
                    "created": state.now,
                    "model": body["model"],
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": '{"ok":true}'},
                            "finish_reason": None,
                        }
                    ],
                },
                {
                    "id": "chatcmpl-synthetic",
                    "object": "chat.completion.chunk",
                    "created": state.now,
                    "model": body["model"],
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
                },
            ]
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content="".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
                + "data: [DONE]\n\n",
            )
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-synthetic",
                "object": "chat.completion",
                "created": state.now,
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": '{"ok":true}'},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
            },
        )

    config = ModelProviderConfig(
        "synthetic-box", key, "https://admin.example.com", protocol_version=2
    )
    catalog = ModelProviderCatalog(
        config,
        transport=httpx.MockTransport(admin),
        clock=lambda: state.now,
        monotonic=lambda: state.mono,
    )
    try:
        async with native_model_service(
            config,
            DeviceProviderProjection(services),
            port=0,
            catalog=catalog,
            transport=httpx.MockTransport(supplier),
            authority_check=lambda snapshot: state.owner_current,
        ) as runtime:
            await runtime.reconcile()
            yield SimpleNamespace(
                services=services,
                state=state,
                runtime=runtime,
                user_id=user_id,
                tmp_path=tmp_path,
                repo_root=repo_root,
            )
    finally:
        db.close()


async def dialogue_frame(fixture, *, send=True, manual=None, agent_id=None, thread_id=None):
    body = {
        "defaults": read_application_defaults(fixture.services),
        "models": list_resolved_models(fixture.services.provider_repo.list_all()),
        "send": send,
        "manual": manual,
        "agentId": agent_id,
        "threadId": thread_id,
    }
    process = await asyncio.create_subprocess_exec(
        "node",
        str(fixture.repo_root / "tests/support/application_default_dialogue.mjs"),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate(json.dumps(body).encode())
    assert process.returncode == 0, stderr.decode()
    return json.loads(stdout)


async def native_chat(fixture, reference):
    from langchain_core.messages import HumanMessage
    from octop_harness.llm.factory import build_chat_model
    from octop_harness.llm.session_header import aclose_session_http_clients

    name, model_id = reference.split("/", 1)
    provider = next(
        p
        for p in ProviderStore(fixture.services.provider_repo).build_harness_configs()
        if p.id == name
    )
    model = next(m for m in provider.models if m.id == model_id)
    llm = build_chat_model(provider, model)
    llm.max_retries = 0
    try:
        answer = await llm.ainvoke([HumanMessage(content="Synthetic qualification, return ok.")])
        assert json.loads(answer.content) == {"ok": True}
    finally:
        await aclose_session_http_clients(llm)


def policy(fixture, *, revision="1", flash=FLASH):
    fixture.state.value["applicationDefaults"] = {
        "revision": revision,
        "defaults": {
            role: {"providerId": "qeetoken", "modelId": CODING if role == "kaiwu" else flash}
            for role in ("starlink", "dialogue", "kaiwu")
        },
    }


async def starlink_check(fixture):
    config = {
        "box_id": "synthetic-box",
        "application_id": "synthetic-starlink",
        "service_token": "synthetic-local-starlink-contract-token",
    }
    (fixture.services.paths.root / "semantica.json").write_text(json.dumps(config))

    async def invoke(body):
        raw = json.dumps(
            {
                "owner": json.dumps(
                    [config["box_id"], config["application_id"], "wanx:" + str(fixture.user_id)]
                ),
                **body,
            }
        ).encode()
        stamp, nonce = str(int(time.time())), uuid.uuid4().hex
        signature = hmac.new(
            config["service_token"].encode(),
            stamp.encode() + b"." + nonce.encode() + b"." + raw,
            hashlib.sha256,
        ).hexdigest()

        async def disconnected():
            return False

        return await starlink.internal(
            raw,
            {
                "x-starklink-time": stamp,
                "x-starklink-nonce": nonce,
                "x-starklink-signature": signature,
            },
            fixture.services,
            disconnected,
        )

    catalog = await invoke({"action": "catalog"})
    assert catalog["default_source"] == "application"
    assert catalog["default"]["model"] == FLASH
    answer = await invoke({"action": "check", "selection": catalog["default"]})
    assert json.loads(answer["text"]) == {"ok": True}


async def codex_response(fixture, frozen=None):
    from openai import AsyncOpenAI
    from wanx_studio.codex_config import resolve_runtime
    from wanx_studio.wanx import WanxModels

    root = fixture.tmp_path / "studio"
    binary = root / "node_modules/.bin" / ("codex.cmd" if os.name == "nt" else "codex")
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text("not executed: this test qualifies resolved launch configuration and HTTP")
    binary.chmod(0o700)
    service = SimpleNamespace(
        model=WanxModels(fixture.services),
        project_root=root,
        store=SimpleNamespace(root=fixture.tmp_path / "studio-state"),
    )
    environment, _summary = resolve_runtime(
        service=service, owner="synthetic-owner", model_ref=frozen
    )
    config = json.loads(environment["WANX_CODEX_CONFIG"])
    route = config["model_providers"]["wanx_device"]
    async with AsyncOpenAI(
        api_key=environment["WANX_CODEX_PROXY_TOKEN"], base_url=route["base_url"], max_retries=0
    ) as client:
        answer = await client.responses.create(
            model=config["model"], input="Synthetic qualification."
        )
        assert json.loads(answer.output_text) == {"ok": True}


async def test_late_lease_defaults_reach_all_three_application_dispatches(dispatch):
    f = dispatch
    assert (await dialogue_frame(f, send=False))["defaultModel"] is None
    assert f.state.calls == []
    f.services.settings_repo.set_active_model(PROVIDER, CODING)
    policy(f)
    await f.runtime.reconcile()
    assert all(h["x-wanx-application-defaults"] == "1" for h in f.state.admin_headers)
    frame = await dialogue_frame(f)
    assert frame["frame"]["model"] == PROVIDER + "/" + FLASH
    await native_chat(f, frame["frame"]["model"])
    await starlink_check(f)
    await codex_response(f)
    assert f.state.calls == [
        {"path": "/v1/chat/completions", "model": FLASH},
        {"path": "/v1/chat/completions", "model": FLASH},
        {"path": "/v1/responses", "model": CODING},
    ]
    assert f.services.settings_repo.get_active_model() == (PROVIDER, CODING)
    assert "credential" not in json.dumps(read_application_defaults(f.services))


async def test_queued_reference_rotation_and_revocation_still_control_real_requests(dispatch):
    from openai import APIStatusError
    from wanx_studio.codex_config import snapshot_model
    from wanx_studio.wanx import WanxModels

    f = dispatch
    policy(f)
    await f.runtime.reconcile()
    frozen = snapshot_model(SimpleNamespace(model=WanxModels(f.services)))
    policy(f, revision="2", flash=NEXT)
    f.state.value["applicationDefaults"]["defaults"]["kaiwu"]["modelId"] = FLASH
    f.state.supplier_key = "synthetic-rotated-supplier-credential"
    f.state.value["providers"][0].update(configVersion="2", apiKey=f.state.supplier_key)
    await f.runtime.reconcile()
    frame = await dialogue_frame(f)
    assert frame["frame"]["model"] == PROVIDER + "/" + NEXT
    manual = await dialogue_frame(f, manual=PROVIDER + "/" + FLASH)
    assert manual["frame"]["model"] == PROVIDER + "/" + FLASH
    await native_chat(f, manual["frame"]["model"])
    await codex_response(f, frozen)
    assert [item["model"] for item in f.state.calls] == [FLASH, CODING]
    f.state.mono += 301
    before = len(f.state.calls)
    with pytest.raises(APIStatusError) as expired:
        await native_chat(f, manual["frame"]["model"])
    assert expired.value.status_code == 503
    assert len(f.state.calls) == before


async def test_owner_revocation_blocks_real_requests_before_cloud_poll(dispatch):
    from openai import APIStatusError

    f = dispatch
    policy(f)
    await f.runtime.reconcile()
    selected = (await dialogue_frame(f))["frame"]["model"]
    f.state.owner_current = False
    with pytest.raises(APIStatusError) as revoked:
        await native_chat(f, selected)
    assert revoked.value.status_code == 403
    assert f.state.calls == []


async def test_real_assistant_websocket_uses_late_default_through_actual_harness(dispatch):
    from octop.infra.users.password import hash_password
    from tests.support.app import octop_client
    from tests.support.auth import auth_header
    from tests.support.http import chat_ws_path, ws_connect

    f = dispatch
    f.services.user_repo.set_password_hash(f.user_id, hash_password("SyntheticPassword123!"))
    f.services.settings_repo.set_active_model(PROVIDER, CODING)
    async with octop_client(f.services.paths.root, patch_llm=False) as (client, server):
        auth = await auth_header(
            client, username="synthetic-owner", password="SyntheticPassword123!"
        )
        policy(f)
        await f.runtime.reconcile()
        profile = await client.post("/api/assistant/profile", headers=auth)
        profile.raise_for_status()
        agent_id = profile.json()["agent_id"]
        created = await client.post(f"/api/agents/{agent_id}/threads", headers=auth)
        created.raise_for_status()
        frame = await dialogue_frame(f, agent_id=agent_id, thread_id=created.json()["thread_id"])
        async with ws_connect(client._octop_app, chat_ws_path(agent_id, auth)) as ws:
            await ws.send_json(frame["frame"])
            events = await ws.drain_turn()
        assert events[-1]["type"] == "done", events
        text = "".join(event.get("content", "") for event in events if event.get("type") == "token")
        assert json.loads(text) == {"ok": True}
        assert f.state.calls == [{"path": "/v1/chat/completions", "model": FLASH}]
        assert f.services.settings_repo.get_active_model() == (PROVIDER, CODING)


@pytest.mark.skipif(
    os.name == "nt" or not os.getenv("WANX_TEST_CODEX_BINARY"),
    reason="Explicit native POSIX Codex binary required for full app-server qualification",
)
async def test_actual_codex_app_server_uses_default_in_supplier_request(dispatch):
    from wanx_studio.codex_config import resolve_runtime
    from wanx_studio.wanx import WanxModels

    f = dispatch
    policy(f)
    await f.runtime.reconcile()
    root = f.tmp_path / "native-studio"
    binary = root / "node_modules/.bin/codex"
    binary.parent.mkdir(parents=True)
    binary.symlink_to(os.environ["WANX_TEST_CODEX_BINARY"])
    workspace = f.tmp_path / "native-workspace"
    workspace.mkdir()
    service = SimpleNamespace(
        model=WanxModels(f.services),
        project_root=root,
        store=SimpleNamespace(root=f.tmp_path / "native-state"),
    )
    environment, _summary = resolve_runtime(service=service, owner="synthetic-owner")
    process = await asyncio.create_subprocess_exec(
        "node",
        str(f.repo_root / "tests/support/application_default_codex.mjs"),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={key: os.environ[key] for key in ("PATH", "LANG", "TMPDIR") if key in os.environ}
        | {
            "HTTP_PROXY": "http://127.0.0.1:9",
            "HTTPS_PROXY": "http://127.0.0.1:9",
            "ALL_PROXY": "http://127.0.0.1:9",
            "NO_PROXY": "127.0.0.1,localhost,::1",
        },
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(
                json.dumps(
                    {
                        "environment": environment,
                        "cwd": str(workspace),
                    }
                ).encode()
            ),
            90,
        )
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 10)
            except TimeoutError:
                process.kill()
                await process.wait()
    assert process.returncode == 0, stderr.decode()[-1000:]
    assert json.loads(stdout)["completed"] is True
    assert f.state.calls and all(
        item == {"path": "/v1/responses", "model": CODING} for item in f.state.calls
    )
