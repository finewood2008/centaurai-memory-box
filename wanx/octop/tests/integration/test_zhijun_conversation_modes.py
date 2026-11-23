"""Persist mode choices across logical threads with owner and revision checks."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from octop_gateway.models import ChannelSubject, InboundMessage, TextContent

from octop.infra.agents.assistant_conversations import AssistantConversations, ConversationError
from octop.infra.gateway.process.message_keys import session_key_from_message
from tests.support.auth import create_user, resolve_user_id
from tests.support.http import chat_ws_path, ws_connect


def _enable_checkpoint_append(agent: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    async def append_messages(thread_id, messages):
        await agent.graph.aupdate_state(
            {"configurable": {"thread_id": thread_id}}, {"messages": messages}
        )
        return messages

    monkeypatch.setattr(agent, "aappend_messages", append_messages, raising=False)


async def test_zhijun_logical_mode_is_shared_and_first_choice_is_atomic(
    env_with_provider: Any,
) -> None:
    client, server, admin = env_with_provider
    auth = await create_user(client, admin, username="mode-owner")
    uid = await resolve_user_id(client, admin, "mode-owner")
    profile = (await client.post("/api/assistant/profile", headers=auth)).json()
    aid = profile["agent_id"]
    root, fork, legacy = [
        (await client.post(f"/api/agents/{aid}/threads", headers=auth)).json()["thread_id"]
        for _ in range(3)
    ]
    user = SimpleNamespace(id=uid, application_id="wanx", locale="en")
    service = AssistantConversations(server)
    assert service.state(user, root)["conversation_mode"] is None
    assert service.resolve_turn_mode(user, root) == "ask"
    assert service.state(user, root)["revision"] == 0

    first, second = await asyncio.gather(
        asyncio.to_thread(service.resolve_turn_mode, user, root, "craft"),
        asyncio.to_thread(AssistantConversations(server).resolve_turn_mode, user, root, "ask"),
    )
    assert first == second
    initial = service.state(user, root)
    assert initial["conversation_mode"] == first
    assert initial["revision"] == 1
    service.repo.save(
        root,
        uid,
        aid,
        initial["revision"],
        active=fork,
        version={
            "thread_id": fork,
            "parent_thread_id": root,
            "target_message_id": "synthetic-message",
            "kind": "edit",
        },
    )
    selected = await service.patch(user, fork, 2, None, None, conversation_mode="craft")
    assert selected["id"] == root
    assert selected["active_thread_id"] == fork
    assert selected["revision"] == 3
    assert AssistantConversations(server).resolve_turn_mode(user, root, "ask") == "craft"
    assert (await service.get(user, fork))["conversation_mode"] == "craft"
    with pytest.raises(ConversationError, match="ASSISTANT_CONVERSATION_CONFLICT"):
        await service.patch(user, root, 2, None, None, conversation_mode="ask")
    with pytest.raises(ConversationError, match="ASSISTANT_CONVERSATION_NOT_FOUND"):
        service.resolve_turn_mode(SimpleNamespace(id=uid + 1, application_id="wanx"), root)
    with pytest.raises(ConversationError, match="ASSISTANT_CONVERSATION_NOT_FOUND"):
        service.resolve_turn_mode(
            SimpleNamespace(id=uid, application_id="wanx", local_team=object()), root
        )

    registry = server.app_runtime.gateway.thread_registry
    registry.update_composer(legacy, conversation_mode="plan")
    assert service.state(user, legacy)["conversation_mode"] == "ask"
    assert service.resolve_turn_mode(user, legacy, "plan") == "ask"
    assert (await service.patch(user, legacy, 0, None, None, conversation_mode="craft"))[
        "conversation_mode"
    ] == "craft"


async def test_zhijun_socket_uses_saved_mode_and_records_memory_source(
    env_with_provider: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, server, admin = env_with_provider
    auth = await create_user(client, admin, username="socket-memory-owner")
    aid = (await client.post("/api/assistant/profile", headers=auth)).json()["agent_id"]
    thread = (await client.post(f"/api/agents/{aid}/threads", headers=auth)).json()["thread_id"]
    agent = server.app_runtime.agent_registry.get_agent(aid)

    _enable_checkpoint_append(agent, monkeypatch)
    path = f"/api/assistant/conversations/{thread}"
    assert (
        await client.patch(path, headers=auth, json={"revision": 0, "conversation_mode": "ask"})
    ).status_code == 200
    command = {
        "type": "user_turn",
        "thread_id": thread,
        "assistant_persona": "zhijun",
        "text": "记住，彩色回形针放在蓝盒里。",
    }
    search = "/api/assistant/sidebar-memory"
    async with ws_connect(client._octop_app, chat_ws_path(aid, auth)) as ws:
        await ws.send_json({**command, "conversation_mode": "craft"})
        denied = await ws.drain_turn()
        assert denied[-1]["conversation_mode"] == "ask"
        assert any("高级模式" in frame.get("content", "") for frame in denied)
        assert (await client.get(search, headers=auth)).json()["items"] == []

        assert (
            await client.patch(
                path, headers=auth, json={"revision": 1, "conversation_mode": "craft"}
            )
        ).status_code == 200
        await ws.send_json({**command, "conversation_mode": "ask"})
        saved = await ws.drain_turn()
        assert saved[-1]["conversation_mode"] == "craft"
        assert any("已记住" in frame.get("content", "") for frame in saved)

    assert agent.last_request is None
    (memory,) = (await client.get(search, headers=auth)).json()["items"]
    assert memory["threadId"] == thread
    history = (await agent.graph.aget_state({"configurable": {"thread_id": thread}})).values
    assert any(
        message.id == memory["messageId"] and message.content == command["text"]
        for message in history["messages"]
    )


async def test_switching_zhijun_mode_keeps_the_active_turn_snapshot(
    env_with_provider: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, server, admin = env_with_provider
    auth = await create_user(client, admin, username="active-mode-owner")
    aid = (await client.post("/api/assistant/profile", headers=auth)).json()["agent_id"]
    thread = (await client.post(f"/api/agents/{aid}/threads", headers=auth)).json()["thread_id"]
    agent = server.app_runtime.agent_registry.get_agent(aid)
    agent.chunks = [{"type": "token", "content": "测试回答"}]
    stream = agent.stream
    started = asyncio.Event()
    proceed = asyncio.Event()

    async def suspended(request):
        started.set()
        await proceed.wait()
        async for chunk in stream(request):
            yield chunk

    monkeypatch.setattr(agent, "stream", suspended)
    path = f"/api/assistant/conversations/{thread}"
    frame = {
        "type": "user_turn",
        "thread_id": thread,
        "assistant_persona": "zhijun",
        "conversation_mode": "ask",
        "text": "请回答一个测试问题。",
    }
    async with ws_connect(client._octop_app, chat_ws_path(aid, auth)) as ws:
        await ws.send_json(frame)
        try:
            await asyncio.wait_for(started.wait(), timeout=5)
            changed = await client.patch(
                path, headers=auth, json={"revision": 1, "conversation_mode": "craft"}
            )
            assert changed.status_code == 200, changed.text
        finally:
            proceed.set()
        assert (await ws.drain_turn())[-1]["conversation_mode"] == "ask"
        await ws.send_json(frame)
        assert (await ws.drain_turn())[-1]["conversation_mode"] == "craft"


async def test_verified_phone_resolves_the_real_bound_personal_identity(
    env_with_provider: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, server, admin = env_with_provider
    auth = await create_user(client, admin, username="phone-mode-owner")
    aid = (await client.post("/api/assistant/profile", headers=auth)).json()["agent_id"]
    thread = (await client.post(f"/api/agents/{aid}/threads", headers=auth)).json()["thread_id"]
    _enable_checkpoint_append(server.app_runtime.agent_registry.get_agent(aid), monkeypatch)

    gateway = server.app_runtime.gateway

    async def verified(_message: InboundMessage) -> bool:
        return True

    monkeypatch.setattr(gateway.processor, "loop_message_interceptor", verified)
    msg = InboundMessage(
        channel_id="verified-test-weixin",
        channel_type="weixin",
        tenant_id=aid,
        channel_subject=ChannelSubject(subject_id="synthetic-phone", chat_type="dm"),
        content=[TextContent(text="记住，备用钥匙放在测试抽屉。")],
        metadata={"message_id": "synthetic-phone-message", "conversation_mode": "craft"},
    )
    await gateway.thread_registry.rebind(
        session_key=session_key_from_message(msg, agent_id=aid),
        thread_id=thread,
        agent_id=aid,
    )

    refused = [event async for event in gateway.processor(msg)]
    assert "高级模式" in refused[0].content[0].text
    path = f"/api/assistant/conversations/{thread}"
    changed = await client.patch(
        path, headers=auth, json={"revision": 0, "conversation_mode": "craft"}
    )
    assert changed.status_code == 200, changed.text
    saved = [event async for event in gateway.processor(msg)]
    assert "已记住" in saved[0].content[0].text
    (memory,) = (await client.get("/api/assistant/sidebar-memory", headers=auth)).json()["items"]
    assert memory["threadId"] == thread
    assert memory["title"] == "微信私聊"
