"""Real SQLite/workshop service; fake model and transport, synthetic files only."""

import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from test_studio import ROOT, op
from test_workshop_model import DefaultModels, reply
from wanx_studio.contracts import StudioError, digest
from wanx_studio.haowen import HaoWen, check_answer
from wanx_studio.haowen_channels import audience, dispatch, file_request, native, save_policy
from wanx_studio.workshop import PersonalWorkshop


class Models(DefaultModels):
    def __init__(self):
        super().__init__()
        self.prompts = []
        self.after = None

    async def __call__(self, owner, request):
        self.prompts.append(
            request["messages"][0]["content"] + "\n" + request["messages"][-1]["content"]
        )
        if self.after:
            self.after()
        if self.fail:
            raise RuntimeError("synthetic failure")
        context = json.loads(self.prompts[-1].split("\n", 1)[1])
        if context["evidence"]:
            e = context["evidence"][0]
            return reply(
                json.dumps(
                    {
                        "grounded": "合成验收码 LANTERN-7304 [1]",
                        "claims": [{"id": "1", "quote": e["text"]}],
                        "supplement": "通用建议：保存验收记录。",
                    }
                )
            )
        return reply("合成通用回答")

    def for_runtime(self, key):
        return self


class Space:
    def __init__(self):
        self.entries = {
            "folder": {
                "id": "folder",
                "kind": "folder",
                "name": "合成目录",
                "space_id": "personal",
                "parent": "",
                "trashed": None,
            },
            "file": {
                "id": "file",
                "kind": "file",
                "name": "合成.txt",
                "space_id": "personal",
                "parent": "folder",
                "trashed": None,
                "size": len("合成验收码 LANTERN-7304".encode()),
                "version": 1,
            },
            "outside": {
                "id": "outside",
                "kind": "file",
                "name": "无授权.txt",
                "space_id": "personal",
                "parent": "",
                "trashed": None,
                "size": 6,
                "version": 1,
            },
        }

    def spaces(self):
        return [{"id": "personal", "name": "个人空间", "root": "", "trashed": None}]

    def metadata(self, key):
        row = self.entries[key]
        if row.get("trashed"):
            raise ValueError("removed")
        return deepcopy(row)

    def listing(self, parent="", trash=False, space_id="personal"):
        return {
            "items": [
                self.metadata(k)
                for k, r in self.entries.items()
                if r["parent"] == parent and not r.get("trashed")
            ]
        }

    def read_chunk(self, key, offset, length):
        data = "合成验收码 LANTERN-7304".encode() if key == "file" else b"hidden"
        return data[offset : offset + length], self.metadata(key)


@pytest.fixture
async def configured(tmp_path):
    model, space = Models(), Space()
    service = PersonalWorkshop(tmp_path, ROOT, model)
    source = json.loads((ROOT / "templates/knowledge-qa/wanx.editable.json").read_text())
    p = await service.copy_source(
        "wanx:1", {"operationId": op(), "name": "好问合成", "source": source}
    )
    a = p["artifacts"][0]
    raw = service.store.get("wanx:1", p["id"])
    raw["installed"] = {"artifactHash": a["hash"], "version": a["version"]}
    service.store.save(raw)
    token = service.open_runtime("wanx:1", p["id"], a["hash"], "preview")["session"]
    session = service.runtime("wanx:1", token)
    channel = SimpleNamespace(
        channel_id="c1",
        agent_id="haowen-test",
        user_id=1,
        enabled=1,
        kind="wecom",
        name="合成机器人",
        config_json='{"secret":"synthetic-only"}',
    )
    gateway = SimpleNamespace(
        get_channel=lambda key: channel if key == "c1" else None,
        list_channels=lambda aid: [channel],
        runtime_status_to_dict=lambda key: {"connected": True},
    )
    server = SimpleNamespace(
        services=SimpleNamespace(
            user_repo=SimpleNamespace(get=lambda uid: SimpleNamespace(disabled=False))
        ),
        app_runtime=SimpleNamespace(gateway=gateway),
    )
    svc = HaoWen(service, server, lambda _: space)
    service.haowen = svc
    grant = await svc.select(session, [{"kind": "folder", "id": "folder"}])
    await svc.save(
        session,
        {
            "revision": 0,
            "name": "好问",
            "style": "合成回答",
            "sources": grant,
            "cloudAllowed": True,
        },
    )
    yield svc, session, service, model, space, channel, token
    await service.close()


async def test_shared_app_settings_and_live_folder_membership(configured):
    svc, s, service, model, space, _, token = configured
    result = await service.invoke(
        s["owner"],
        token,
        "dialogue.invoke",
        {
            "operation": "ask",
            "input": {"conversationId": "a", "question": "合成验收码是什么", "requestId": "r1"},
        },
    )
    assert "LANTERN-7304" in result["content"]
    assert result["evidence"][0]["sourceId"] == "file"
    assert "hidden" not in model.prompts[-1]
    assert "credentialRevision" not in json.dumps(svc.public(s))
    space.entries["file"]["parent"] = ""
    with pytest.raises(StudioError, match="SOURCE_REMOVED"):
        await svc.evidence(s, result["evidence"][0])


async def test_owner_app_environment_and_trusted_selection_isolation(configured):
    svc, s, service, _, _, _, token = configured
    with pytest.raises(StudioError, match="RUNTIME_SESSION_EXPIRED"):
        await service.invoke("wanx:2", token, "dialogue.invoke", {"operation": "read", "input": {}})
    prod = {**s, "environment": "production"}
    assert not svc.state(prod)["sources"]
    with pytest.raises(StudioError, match="HAOWEN_SOURCE_NOT_SELECTED"):
        await svc.save(
            prod,
            {
                "revision": 0,
                "name": "好问",
                "style": "简洁",
                "cloudAllowed": True,
                "sources": [{"kind": "file", "id": "file"}],
            },
        )
    other = await service.copy_source(
        s["owner"],
        {
            "operationId": op(),
            "name": "另一个",
            "source": json.loads((ROOT / "templates/knowledge-qa/wanx.editable.json").read_text()),
        },
    )
    other_session = {**s, "project": other["id"], "app": other["appId"]}
    assert not svc.state(other_session)["sources"]
    with pytest.raises(StudioError, match="HAOWEN_SOURCE_NOT_SELECTED"):
        await svc.save(
            other_session,
            {
                "revision": 0,
                "name": "好问",
                "style": "简洁",
                "cloudAllowed": True,
                "sources": [{"kind": "folder", "id": "folder"}],
            },
        )


async def test_no_model_call_without_explicit_source_processing_consent(configured):
    svc, s, _, model, _, _, _ = configured
    cfg = svc.state(s)
    svc.write(s, {"cloudAllowed": False}, cfg["revision"])
    with pytest.raises(StudioError, match="HAOWEN_MODEL_CONSENT_REQUIRED"):
        await svc.answer(s, "dm", "合成验收码", "r")
    assert not model.prompts


async def test_inflight_config_and_file_revocation_discard_generated_answer(configured):
    svc, s, _, model, space, _, _ = configured
    model.after = lambda: svc.write(s, {"sources": []}, svc.state(s)["revision"])
    with pytest.raises(StudioError, match="HAOWEN_CONFIG_CHANGED"):
        await svc.answer(s, "dm", "合成验收码", "r")
    assert not svc.history(s, "dm")
    svc.write(
        s,
        {
            "sources": [
                {
                    "kind": "folder",
                    "id": "folder",
                    "spaceId": "personal",
                    "folderId": "folder",
                    "name": "合成目录",
                }
            ]
        },
        svc.state(s)["revision"],
    )
    model.after = lambda: space.entries["file"].update(parent="")
    with pytest.raises(StudioError, match="SOURCE_REMOVED"):
        await svc.answer(s, "dm", "合成验收码", "r")
    assert not svc.history(s, "dm")


async def test_failure_retry_idempotency_and_context_not_replaying_old_evidence(configured):
    svc, s, _, model, _, _, _ = configured
    model.fail = True
    with pytest.raises(StudioError, match="MODEL_UPSTREAM_FAILED"):
        await svc.answer(s, "dm", "合成验收码", "r1")
    model.fail = False
    await svc.answer(s, "dm", "合成验收码", "r1")
    before = len(model.prompts)
    cached = await svc.answer(s, "dm", "合成验收码", "r1")
    assert cached["content"] and len(model.prompts) == before
    svc.write(s, {"sources": []}, svc.state(s)["revision"])
    await svc.answer(s, "dm", "继续一般讨论", "r2")
    history = json.loads(model.prompts[-1].split("\n", 1)[1])["history"]
    assert history and "LANTERN-7304" not in json.dumps(history)
    await svc.answer(s, "different-person", "新会话", "r3")
    assert not json.loads(model.prompts[-1].split("\n", 1)[1])["history"]


def policy(svc, s):
    svc.write(s, {"agentId": "haowen-test"}, svc.state(s)["revision"])
    return {
        "id": "c1",
        "kind": "wecom",
        "name": "合成机器人",
        "enabled": True,
        "subjects": ["person-a"],
        "groups": ["group-a"],
        "allowFiles": True,
        "sources": svc.state(s)["sources"],
        "credentialRevision": digest(["wecom", '{"secret":"synthetic-only"}']),
    }


def msg(text="合成验收码", subject="person-a", group=False):
    from octop_gateway.models import ChannelSubject, InboundMessage, TextContent

    return InboundMessage(
        channel_id="c1",
        channel_type="wecom",
        tenant_id="haowen-test",
        channel_subject=ChannelSubject(subject_id=subject, chat_type="group" if group else "dm"),
        content=[TextContent(text=text)],
        metadata={"sender_id": "member-a", "message_id": op()},
    )


async def test_channel_audience_session_keys_and_deny_unknown_identity(configured):
    svc, s, *_ = configured
    p = policy(svc, s)
    a = audience(msg(), p)[0]
    b = audience(msg(subject="group-a", group=True), p)[0]
    assert a != b
    with pytest.raises(StudioError, match="HAOWEN_AUDIENCE_DENIED"):
        audience(msg(subject="person-b"), p)
    m = msg()
    m.channel_subject = None
    with pytest.raises(StudioError, match="HAOWEN_IDENTITY_REQUIRED"):
        audience(m, p)
    m = msg(subject="person-a", group=True)
    with pytest.raises(StudioError, match="HAOWEN_AUDIENCE_DENIED"):
        audience(m, p)


async def test_policy_requires_audience_and_subset_and_production(configured):
    svc, s, _, _, _, _, _ = configured
    with pytest.raises(StudioError, match="HAOWEN_CHANNEL_DELEGATION_REQUIRED"):
        await save_policy(
            svc,
            s,
            {
                "revision": 1,
                "id": "c1",
                "enabled": True,
                "subjects": ["a"],
                "groups": [],
                "allowFiles": True,
                "sources": [],
            },
        )
    s = {**s, "environment": "production"}
    policy(svc, s)
    cfg = svc.state(s)
    value = {
        "revision": cfg["revision"],
        "id": "c1",
        "enabled": True,
        "subjects": [],
        "groups": [],
        "allowFiles": True,
        "sources": [],
    }
    with pytest.raises(StudioError, match="HAOWEN_AUDIENCE_REQUIRED"):
        await save_policy(svc, s, value)
    value["subjects"] = ["person-a"]
    value["sources"] = [{"kind": "file", "id": "outside"}]
    with pytest.raises(StudioError, match="HAOWEN_SOURCE_NOT_SELECTED"):
        await save_policy(svc, s, value)
    value["sources"] = []
    await save_policy(svc, s, value)
    assert svc.state(s)["channels"]["c1"]["enabled"]


async def test_original_file_export_respects_switch_scope_credential_and_live_move(configured):
    svc, s, _, _, space, channel, _ = configured
    p = policy(svc, s)
    denied = await file_request(svc, s, {**p, "allowFiles": False}, "/文件 合成.txt")
    assert "未开放" in denied.content[0].text
    event = await file_request(svc, s, p, "/文件 合成.txt")
    assert event.content[0].filename == "合成.txt"
    assert event.content[0].data
    outside = await file_request(svc, s, p, "/文件 outside")
    assert "未找到" in outside.content[0].text
    channel.config_json = '{"secret":"rotated-synthetic"}'
    with pytest.raises(StudioError, match="HAOWEN_CHANNEL_REVOKED"):
        await file_request(svc, s, p, "/文件 合成.txt")


async def test_dispatch_uses_registered_app_policy_and_not_generic_agent_tools(configured):
    svc, s, service, model, _, _, _ = configured
    s = {**s, "environment": "production"}
    grant = await svc.select(s, [{"kind": "file", "id": "file"}])
    await svc.save(
        s, {"revision": 0, "name": "好问", "style": "简洁", "cloudAllowed": True, "sources": grant}
    )
    p = policy(svc, s)
    svc.write(s, {"channels": {"c1": p}}, svc.state(s)["revision"])
    agent = SimpleNamespace(
        agent_id="haowen-test", user_id=1, description="WANX HaoWen " + s["app"]
    )
    events = [e async for e in dispatch(svc, msg(), agent)]
    assert "LANTERN-7304" in events[0].content[0].text
    before = len(model.prompts)
    denied = [e async for e in dispatch(svc, msg(subject="stranger"), agent)]
    assert "允许名单" in denied[0].content[0].text and len(model.prompts) == before
    identity = [e async for e in dispatch(svc, msg("/身份", subject="stranger"), agent)]
    assert "stranger" in identity[0].content[0].text and len(model.prompts) == before
    svc.service.local_authority = SimpleNamespace(required=lambda: True)
    denied = [e async for e in dispatch(svc, msg(), agent)]
    assert "常驻通道授权" in denied[0].content[0].text and len(model.prompts) == before


def test_fabricated_citations_are_not_rendered():
    content, _, evidence = check_answer(
        {
            "grounded": "错误答案[99]",
            "claims": [{"id": "99", "quote": "虚构引文"}],
            "supplement": "一般建议",
        },
        [{"id": "1", "text": "真实合成原文"}],
    )
    assert not content and not evidence


async def test_actual_gateway_intercepts_before_slash_and_model_tools(configured):
    from octop.infra.gateway.process.processor import GlobalProcessor

    svc, s, _, _, _, _, _ = configured
    row = SimpleNamespace(agent_id="haowen-test")
    processor = SimpleNamespace(
        loop_message_interceptor=None,
        _agent_repo=SimpleNamespace(get=lambda key: row),
        _agent_manager=SimpleNamespace(),
    )
    events = [e async for e in GlobalProcessor.__call__(processor, msg("/help"))]
    assert "好问服务尚未就绪" in events[0].content[0].text

    async def handler(message, agent):
        from octop_gateway.models import MessageEvent

        assert agent is row
        yield MessageEvent.text("scoped handler")
        yield MessageEvent.completed()

    processor._agent_manager.haowen_handler = handler
    events = [e async for e in GlobalProcessor.__call__(processor, msg("/help"))]
    assert events[0].content[0].text == "scoped handler"


async def test_channel_credential_ui_never_returns_secrets(configured):
    svc, s, _, _, _, _, _ = configured
    s = {**s, "environment": "production"}
    policy(svc, s)
    detail = await native(svc, s, {"action": "channel-detail", "id": "c1"})
    assert "secret" in detail["configured"]
    assert "secret" not in detail["values"]
    assert "synthetic-only" not in json.dumps(detail)
    with pytest.raises(StudioError, match="HAOWEN_NATIVE_OPERATION_DENIED"):
        await native(svc, s, {"action": "channel-detail", "id": "c1", "owner": "wanx:2"})
    with pytest.raises(StudioError, match="HAOWEN_CHANNEL_NOT_FOUND"):
        await native(svc, s, {"action": "channel-detail", "id": "other"})
