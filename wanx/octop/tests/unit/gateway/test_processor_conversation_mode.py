"""Conversation-mode stamping on dashboard harness requests."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.messages import HumanMessage
from octop_gateway.models import ChannelSubject, InboundMessage, MessageEvent, TextContent

from octop.infra.gateway.process.processor import GlobalProcessor, _overwrite_last_user_text
from octop.infra.gateway.slash.dispatcher import SlashDispatcher


def _processor(*, thread: SimpleNamespace | None) -> GlobalProcessor:
    agent_manager = MagicMock()
    agent_manager.merge_turn_mcp_servers = MagicMock(return_value=None)
    agent_manager.get_row = MagicMock(return_value=None)
    agent_manager.default_mcp_servers = MagicMock(return_value=[])
    agent_manager.default_knowledge_base_ids = MagicMock(return_value=[])
    agent_manager.providers = MagicMock()
    agent_manager.providers.is_model_ref_usable = MagicMock(return_value=False)
    agent_manager.providers.resolve_explicit_default_model = MagicMock(return_value=None)
    agent_manager.providers.resolve_model_for_multimodal_turn = MagicMock(
        side_effect=lambda ref, **_k: ref
    )
    agent_manager.get_thread_model = MagicMock(return_value=None)
    thread_registry = MagicMock()
    thread_registry.get_thread = MagicMock(return_value=thread)
    thread_registry.update_composer = MagicMock()
    return GlobalProcessor(
        agent_manager=agent_manager,
        thread_registry=thread_registry,
        audit_repo=MagicMock(),
        agent_repo=MagicMock(get=MagicMock(return_value=MagicMock(default_model=None))),
        user_repo=MagicMock(
            get=MagicMock(return_value=SimpleNamespace(locale="zh", preferences_json=None))
        ),
        connector_repo=MagicMock(),
        dispatcher=SlashDispatcher(),
        usage_repo=None,
        gateway=None,
    )


def test_overwrite_last_user_text_keeps_human_kwargs() -> None:
    request: dict[str, object] = {
        "messages": [HumanMessage(content="执行", additional_kwargs={"composer": True})],
    }
    _overwrite_last_user_text(request, "请按 plans/foo.md 执行")
    last = request["messages"][0]
    assert isinstance(last, HumanMessage)
    assert last.content == "请按 plans/foo.md 执行"
    assert last.additional_kwargs == {"composer": True}


@pytest.mark.asyncio
async def test_dashboard_execute_overwrites_user_text() -> None:
    processor = _processor(
        thread=SimpleNamespace(
            conversation_mode="plan",
            pending_plan_path="plans/foo.md",
            model_ref=None,
        )
    )
    msg = InboundMessage(
        channel_id="ws",
        channel_type="dashboard",
        tenant_id="agent-1",
        channel_subject=ChannelSubject(subject_id="1"),
        content=[TextContent(text="按计划执行")],
        metadata={},
    )
    request = await processor._build_dashboard_request(
        msg,
        agent_id="agent-1",
        user_id=1,
        session_key="sk",
        thread_id="thr",
        meta={},
    )
    assert request["messages"][0]["content"] == "请按 plans/foo.md 执行"
    assert request["conversation_mode"] == "craft"
    processor._thread_registry.update_composer.assert_called_once_with(
        "thr",
        conversation_mode="craft",
        pending_plan_path=None,
    )


@pytest.mark.asyncio
async def test_dashboard_mode_switch_keeps_pending_plan() -> None:
    processor = _processor(
        thread=SimpleNamespace(
            conversation_mode="plan",
            pending_plan_path="plans/foo.md",
            model_ref=None,
        )
    )
    msg = InboundMessage(
        channel_id="ws",
        channel_type="dashboard",
        tenant_id="agent-1",
        channel_subject=ChannelSubject(subject_id="1"),
        content=[TextContent(text="先问一句")],
        metadata={"conversation_mode": "ask"},
    )
    request = await processor._build_dashboard_request(
        msg,
        agent_id="agent-1",
        user_id=1,
        session_key="sk",
        thread_id="thr",
        meta={"conversation_mode": "ask"},
    )
    assert request["messages"][0]["content"] == "先问一句"
    assert request["conversation_mode"] == "ask"
    processor._thread_registry.update_composer.assert_called_once_with(
        "thr",
        conversation_mode="ask",
    )


@pytest.mark.asyncio
async def test_dashboard_turn_applies_hitl_policy() -> None:
    processor = _processor(
        thread=SimpleNamespace(
            conversation_mode="craft",
            pending_plan_path=None,
            model_ref=None,
        )
    )
    msg = InboundMessage(
        channel_id="ws",
        channel_type="dashboard",
        tenant_id="agent-1",
        channel_subject=ChannelSubject(subject_id="1"),
        content=[TextContent(text="hello")],
        metadata={"hitl_policy": {"mode": "allow_all"}},
    )
    await processor._build_dashboard_request(
        msg,
        agent_id="agent-1",
        user_id=1,
        session_key="sk",
        thread_id="thr",
        meta={"hitl_policy": {"mode": "allow_all"}},
    )
    assert processor.hitl_coordinator.session_policies.get("thr").mode == "allow_all"


def test_default_assistant_stays_in_ask_despite_craft_or_old_plan() -> None:
    processor = _processor(
        thread=SimpleNamespace(
            agent_id="assistant", conversation_mode="plan", pending_plan_path="plans/old.md"
        )
    )
    processor._agent_manager.get_row.return_value = SimpleNamespace(
        application_id="wanx", user_id=1, agent_id="assistant"
    )
    processor._user_repo.get.return_value = SimpleNamespace(
        preferences_json='{"wanx_assistant_agent_id":"assistant"}'
    )
    processor._agent_manager.get_agent.return_value = SimpleNamespace(_mcp_tools=[])
    request = processor._stamp_turn_conversation_mode(
        {"messages": [HumanMessage(content="按计划执行")]},
        thread_id="thr",
        meta={"conversation_mode": "craft"},
        user_text="按计划执行",
        mcp_servers=None,
        locale="zh",
    )
    assert request["conversation_mode"] == "ask"
    assert request["messages"][0].content == "按计划执行"
    processor._thread_registry.update_composer.assert_called_once_with(
        "thr", conversation_mode="ask", pending_plan_path=None
    )


@pytest.mark.asyncio
async def test_verified_zhijun_im_remember_and_desktop_recall_use_the_bound_assistant(
    tmp_path, monkeypatch
) -> None:
    from wanx_bridge.zhijun_memory import run_memory

    processor = _processor(
        thread=SimpleNamespace(
            agent_id="assistant", conversation_mode="ask", pending_plan_path=None, model_ref=None
        )
    )
    row = SimpleNamespace(
        agent_id="assistant", application_id="wanx", user_id=1, default_model=None
    )
    processor._agent_manager.paths = SimpleNamespace(root=tmp_path)
    processor._agent_manager.get_row.return_value = row
    processor._agent_manager.get_agent.return_value = SimpleNamespace(_mcp_tools=[])
    processor._agent_repo.get.return_value = row
    processor._user_repo.get.return_value = SimpleNamespace(
        locale="zh", preferences_json='{"wanx_assistant_agent_id":"assistant"}'
    )
    processor._thread_registry.get_or_create_by_key = AsyncMock(return_value="thr")
    processor._thread_registry.get_bound_thread_id.return_value = None
    processor.loop_message_interceptor = AsyncMock(return_value=True)
    msg = InboundMessage(
        channel_id="phone",
        channel_type="weixin",
        tenant_id="assistant",
        channel_subject=ChannelSubject(subject_id="owner", chat_type="dm"),
        content=[TextContent(text="记住，小林下周搬去杭州")],
        metadata={"message_id": "provider-message"},
    )
    response = [event async for event in processor(msg)]
    assert response[0].content[0].text == "已记住：小林下周搬去杭州"
    retry = [event async for event in processor(msg)]
    assert retry[0].content[0].text == response[0].content[0].text
    filters = {"action": "search", "query": "小林", "limit": 10, "offset": 0}
    assert run_memory(tmp_path, 2, filters)["items"] == []
    items = run_memory(tmp_path, 1, filters)["items"]
    assert len(items) == 1
    assert items[0]["title"] == "微信私聊"

    captured = []

    async def fake_stream(_manager, _agent_id, request, **_kwargs):
        captured.append(request)
        yield MessageEvent.text("杭州")

    monkeypatch.setattr("octop.infra.gateway.process.processor.project_stream", fake_stream)
    recall = msg.model_copy(update={"content": [TextContent(text="小林搬去哪里？")]})
    assert [event async for event in processor(recall)]
    (im_request,) = captured
    assert im_request["configurable"]["conversation_mode"] == "craft"
    assert im_request["messages"][0].additional_kwargs["assistant_persona"] == "zhijun"
    processor._thread_registry.update_composer.assert_called_once_with(
        "thr", conversation_mode="craft", pending_plan_path=None
    )

    desktop = InboundMessage(
        channel_id="ws",
        channel_type="dashboard",
        tenant_id="assistant",
        channel_subject=ChannelSubject(subject_id="1"),
        content=[TextContent(text="小林搬去哪里？")],
    )
    prepared = await processor._build_dashboard_request(
        desktop,
        agent_id="assistant",
        user_id=1,
        session_key="desktop",
        thread_id="desktop-thread",
        meta={
            "assistant_persona": "zhijun",
            "conversation_mode": "craft",
            "zhijun_agent_only": True,
            "zhijun_references": [
                {"source": "memmy", "title": "Claude Code", "text": "小林还在找房。"}
            ],
        },
    )
    own_memories, references = prepared["zhijun_prepared"]
    assert prepared["configurable"]["conversation_mode"] == "craft"
    assert own_memories == []
    assert [ref["title"] for ref in references] == ["Claude Code"]
    assert prepared["messages"][0].additional_kwargs["zhijun_evidence"] == references
