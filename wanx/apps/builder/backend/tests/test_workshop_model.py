import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_edits import body, wait
from test_studio import ROOT, op
from test_workshop import source
from test_workshop import svc as svc
from wanx_studio.contracts import StudioError
from wanx_studio.workshop import PersonalWorkshop


def reply(text="", calls=None):
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": text,
                    **({"tool_calls": calls} if calls else {}),
                }
            }
        ]
    }


def call(name, args, key):
    return {
        "id": key,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args)},
    }


class DefaultModels:
    device_managed = True

    def __init__(self):
        self.active = "default-a"
        self.used = []
        self.change_after_plan = False
        self.invalid = False
        self.fail = False
        self.bad_source = False

    def __bool__(self):
        return True

    async def __call__(self, owner, request):
        return reply("WANX_OK")

    def codex_provider(self, *args, **kwargs):
        raise AssertionError("No Codex provider may be resolved")

    def runtime_catalog(self):
        return {
            "defaultId": self.active,
            "models": [
                {"id": k, "name": k, "provider": "synthetic"} for k in ["default-a", "default-b"]
            ],
        }

    def fingerprint(self):
        return self.active

    def for_runtime(self, model_id):
        async def invoke(owner, request):
            self.used.append(model_id)
            if self.fail:
                raise StudioError("MODEL_UPSTREAM_FAILED", 502)
            if not request.get("tools"):
                if self.change_after_plan:
                    self.active = "default-b"
                return reply(
                    "not json"
                    if self.invalid
                    else json.dumps({"outcome": "ready", "summary": "修改页面配色"})
                )
            step = sum(m["role"] == "assistant" for m in request["messages"])
            if step == 0:
                return reply(
                    calls=[
                        call("list_sources", {}, "list"),
                        call("read_material", {}, "material"),
                        call("read_source", {"path": "src/styles.css"}, "read"),
                    ]
                )
            if step == 1:
                original = json.loads(
                    next(
                        m["content"] for m in request["messages"] if m.get("tool_call_id") == "read"
                    )
                )["text"]
                target = "../../outside.js" if self.bad_source else "src/styles.css"
                return reply(
                    calls=[
                        call(
                            "write_source",
                            {"path": target, "content": original + "\n/* " + model_id + " */\n"},
                            "write",
                        )
                    ]
                )
            if step == 2:
                return reply(calls=[call("validate_app", {}, "validate")])
            return reply("修改完成")

        class Bound:
            workshop_images = False

            def resolve(self):
                return (SimpleNamespace(id="synthetic"), SimpleNamespace(input=["text"]))

            async def __call__(self, owner, request):
                return await invoke(owner, request)

        return Bound()


@pytest.fixture
async def model_service(tmp_path):
    models = DefaultModels()
    service = PersonalWorkshop(
        tmp_path / "model-workshop", ROOT, models, AsyncMock(return_value=[])
    )
    service.native_codex.acquire = AsyncMock(side_effect=AssertionError("ACP must not start"))
    yield service, models
    await service.close()


async def copied(svc, service):
    return await service.copy_source(
        "alice", {"operationId": op(), "name": "默认模型定制", "source": await source(svc)}
    )


async def test_default_model_tools_compile_and_keep_old_version_without_codex(svc, model_service):
    service, models = model_service
    p = await copied(svc, service)
    assert p["engine"]["id"] == "wanx-default"
    await service.edits.submit("alice", p["id"], body(p, "改成浅色"))
    result = await wait(service, p["id"])
    assert result["items"][0]["state"] == "completed", result["items"][0].get("error")
    saved = service.store.get("alice", p["id"])
    assert len(saved["artifacts"]) == 2
    assert saved["artifacts"][0]["files"] != saved["artifacts"][1]["files"]
    assert saved["tasks"][-1]["executor"] == "万象默认模型"
    assert set(models.used) == {"default-a"}
    assert saved["preparation"]["interview"]["turns"] == []
    service.native_codex.acquire.assert_not_called()


async def test_one_round_freezes_default_and_next_round_follows_new_default(svc, model_service):
    service, models = model_service
    models.change_after_plan = True
    p = await copied(svc, service)
    await service.edits.submit("alice", p["id"], body(p, "第一处修改"))
    first = await wait(service, p["id"])
    assert first["items"][0]["state"] == "completed", first["items"][0].get("error")
    assert set(models.used) == {"default-a"}
    p = first["project"]
    await service.edits.submit("alice", p["id"], body(p, "第二处修改"))
    second = await wait(service, p["id"])
    assert [e["state"] for e in second["items"]] == ["completed", "completed"]
    assert models.used[-1] == "default-b"
    css = service.store.get("alice", p["id"])["artifacts"][-1]["files"]["src/styles.css"]
    assert "default-a" in css and "default-b" in css


@pytest.mark.parametrize(
    ("mode", "code"),
    [("invalid", "WORKSHOP_MODEL_RESPONSE_INVALID"), ("fail", "MODEL_UPSTREAM_FAILED")],
)
async def test_invalid_or_unavailable_model_keeps_old_version_and_input(
    svc, model_service, mode, code
):
    service, models = model_service
    p = await copied(svc, service)
    setattr(models, mode, True)
    await service.edits.submit("alice", p["id"], body(p, "原话保留"))
    result = await wait(service, p["id"])
    assert result["items"][0]["state"] == "failed"
    assert result["items"][0]["error"] == code
    assert result["items"][0]["text"] == "原话保留"
    assert len(result["project"]["artifacts"]) == 1
    assert len(models.used) == 1
    service.native_codex.acquire.assert_not_called()


async def test_tool_cannot_write_outside_source_and_keeps_baseline(svc, model_service):
    service, models = model_service
    p = await copied(svc, service)
    models.bad_source = True
    await service.edits.submit("alice", p["id"], body(p, "修改颜色"))
    result = await wait(service, p["id"])
    assert result["items"][0]["state"] == "failed"
    assert len(result["project"]["artifacts"]) == 1
    assert not (service.store.root.parent / "outside.js").exists()
    service.native_codex.acquire.assert_not_called()


async def test_missing_default_does_not_fall_back_to_saved_codex(svc, tmp_path):
    service = PersonalWorkshop(tmp_path / "unconfigured", ROOT)
    service.native_codex.acquire = AsyncMock(side_effect=AssertionError("ACP must not start"))
    try:
        p = await copied(svc, service)
        q = service.store.get("alice", p["id"])
        q["engine"] = {
            "id": "codex",
            "name": "Codex",
            "fingerprint": "legacy",
            "location": "legacy",
        }
        service.store.save(q)
        await service.edits.submit("alice", p["id"], body(p, "修改颜色"))
        result = await wait(service, p["id"])
        assert result["items"][0]["error"] == "MODEL_NOT_CONFIGURED"
        assert len(result["project"]["artifacts"]) == 1
        service.native_codex.acquire.assert_not_called()
    finally:
        await service.close()


async def test_only_private_workshop_model_accepts_bounded_inline_preview_images(monkeypatch):
    from octop_harness.config import ModelConfig
    from wanx_studio.wanx import WanxModels

    models = WanxModels.__new__(WanxModels)
    models.resolve = lambda: (
        SimpleNamespace(id="synthetic"),
        ModelConfig.from_dict({"id": "fixture", "input": ["text", "image"]}),
    )
    request = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "圈选标题"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,synthetic"}},
                ],
            }
        ]
    }
    with pytest.raises(StudioError, match="MODEL_INPUT_INVALID"):
        await models("alice", request)
    calls = []

    class LLM:
        async def ainvoke(self, messages, **kwargs):
            calls.append(messages)
            return SimpleNamespace(
                content="ok",
                tool_calls=[],
                additional_kwargs={},
                usage_metadata=None,
                response_metadata={},
            )

    monkeypatch.setattr("octop_harness.llm.factory.build_chat_model", lambda *a: LLM())
    monkeypatch.setattr("octop_harness.llm.session_header.aclose_session_http_clients", AsyncMock())
    models.workshop_images = True
    assert (await models("alice", request))["choices"][0]["message"]["content"] == "ok"
    assert calls[0][0].content == request["messages"][0]["content"]
    request["messages"][0]["content"][1]["image_url"]["url"] = "https://outside.invalid/image.png"
    with pytest.raises(StudioError, match="MODEL_INPUT_INVALID"):
        await models("alice", request)
    assert len(calls) == 1


@pytest.mark.parametrize("patch", [
    {"summary": "标题调整"}, {"text": []}, {"upsert": ["错误条目"]},
    {"capabilities": "data"}, {"unexpected": True},
])
def test_invalid_incremental_plan_is_rejected_before_applying(patch):
    from wanx_studio.workshop_model import decode_plan

    with pytest.raises(StudioError, match="WORKSHOP_MODEL_RESPONSE_INVALID"):
        decode_plan(reply(json.dumps({"outcome": "ready", "summary": "修改标题", "patch": patch})))
