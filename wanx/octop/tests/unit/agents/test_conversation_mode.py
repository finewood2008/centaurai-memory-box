"""Ask / Plan / Craft helpers."""

from __future__ import annotations

from octop.infra.agents.conversation_mode import (
    HOST_READ_TOOLS,
    execute_user_message,
    is_plan_execute_utterance,
    plan_relpath_from_artifact,
    resolve_conversation_mode,
    stamp_conversation_mode,
)


def test_resolve_explicit_wins() -> None:
    assert resolve_conversation_mode(explicit="ask", thread_mode="plan") == "ask"
    assert resolve_conversation_mode(explicit="nope", thread_mode="plan") == "craft"


def test_resolve_sticky_when_explicit_absent() -> None:
    assert resolve_conversation_mode(thread_mode="plan") == "plan"
    assert resolve_conversation_mode() == "craft"


def test_plan_relpath_from_artifact() -> None:
    assert (
        plan_relpath_from_artifact("plans/add-ask-plan-modes.md") == "plans/add-ask-plan-modes.md"
    )
    assert plan_relpath_from_artifact("/workspace/plans/foo.md") == "plans/foo.md"
    assert plan_relpath_from_artifact("SOUL.md") == ""
    assert plan_relpath_from_artifact("plans/中文.md") == ""


def test_execute_user_message() -> None:
    assert execute_user_message("plans/foo.md", "zh") == "请按 plans/foo.md 执行"
    assert execute_user_message("plans/foo.md", "en") == "Execute plans/foo.md"


def test_is_plan_execute_utterance() -> None:
    assert is_plan_execute_utterance("按计划执行")
    assert is_plan_execute_utterance("执行计划")
    assert is_plan_execute_utterance("execute the plan")
    assert is_plan_execute_utterance("start executing")
    assert is_plan_execute_utterance("请按 plans/foo.md 执行")
    assert is_plan_execute_utterance("Execute plans/foo.md")
    assert not is_plan_execute_utterance("执行")
    assert not is_plan_execute_utterance("execute")
    assert not is_plan_execute_utterance("帮我看看这个计划写得对不对")
    assert not is_plan_execute_utterance("go")
    assert not is_plan_execute_utterance("start")
    assert not is_plan_execute_utterance("go on")


def test_stamp_ask_clears_skills_and_mcp() -> None:
    request: dict[str, object] = {
        "skills": ["docker"],
        "mcp_servers": ["github"],
        "configurable": {"skills": ["docker"]},
    }
    stamp_conversation_mode(request, "ask")
    assert request["skills"] == []
    assert request["mcp_servers"] == []
    cfg = request["configurable"]
    assert isinstance(cfg, dict)
    assert cfg["conversation_mode"] == "ask"
    assert cfg["conversation_mode_extra_read_tools"] == list(HOST_READ_TOOLS)
    assert cfg["skills"] == []


def test_zhijun_persona_uses_the_latest_user_turn_without_changing_the_chat() -> None:
    from langchain.agents.middleware import ModelRequest
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    from octop.infra.agents.assistant_profile import ZHIJUN_PERSONA_PROMPT
    from octop.infra.agents.conversation_mode import (
        AssistantProfileMiddleware,
        latest_zhijun_message,
    )

    user = HumanMessage(content="今天有点累", additional_kwargs={"assistant_persona": "zhijun"})
    base = SystemMessage(content=[{"type": "text", "text": "Base Ask instructions"}])
    request = ModelRequest(
        model=FakeListChatModel(responses=[""]),
        messages=[user, AIMessage(content="")],
        system_message=base,
    )
    overridden = AssistantProfileMiddleware._with_persona(request)
    assert overridden.system_message.content == [
        *base.content,
        {"type": "text", "text": ZHIJUN_PERSONA_PROMPT},
    ]
    assert overridden.messages[0].content == "今天有点累"
    assert request.system_message is base

    generic = request.override(messages=[user, HumanMessage(content="Help with a file")])
    assert latest_zhijun_message(generic.messages) is None


def test_ask_keeps_questions_and_selected_reads_without_execution(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from octop_harness.middleware import conversation_mode as mode
    from octop_harness.middleware import runtime

    from octop.infra.agents.conversation_mode import stamp_assistant_mode

    server = "wanx_knowledge_" + "a" * 32
    names = ["ask_user_question", server + "_xingtu_search", server + "_delete", "execute"]
    request = stamp_assistant_mode({"skills": ["build"]}, [server], names, "ask")
    assert request["conversation_mode"] == "ask" and request["skills"] == []
    monkeypatch.setattr(runtime, "get_config", lambda: request)
    monkeypatch.setattr(mode, "get_config", lambda: request)

    def model_request(**values):
        model = SimpleNamespace(**values)
        model.override = lambda **kw: model_request(**{**values, **kw})
        return model

    model = model_request(
        tools=[SimpleNamespace(name=name) for name in names], system_message=None, state={}
    )
    filtered = mode.apply_conversation_mode_to_request(model)
    assert [tool.name for tool in filtered.tools] == names[:2]
    handler = Mock(return_value="user selected an option")
    question = SimpleNamespace(tool_call={"name": "ask_user_question", "id": "q", "args": {}})
    assert (
        mode.ConversationModeMiddleware().wrap_tool_call(question, handler) == handler.return_value
    )
    for name in names[2:]:
        question.tool_call["name"] = name
        assert mode.ConversationModeMiddleware().wrap_tool_call(question, handler).status == "error"
    assert handler.call_count == 1


def test_answer_resume_without_mode_cannot_restore_craft(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from octop_harness.middleware import conversation_mode as harness_mode
    from octop_harness.middleware import runtime

    from octop.infra.agents import conversation_mode as host_mode

    for initial in [{}, {"conversation_mode": "craft"}]:
        config = {"configurable": {"thread_id": "t", **initial}}
        for module in [host_mode, harness_mode, runtime]:
            monkeypatch.setattr(module, "get_config", lambda config=config: config)
        boundary = host_mode.AssistantProfileMiddleware()
        handler = Mock(return_value="answered")
        question = SimpleNamespace(tool_call={"id": "q", "name": "ask_user_question", "args": {}})
        assert boundary.wrap_tool_call(question, handler) == "answered"
        assert config["configurable"]["conversation_mode"] == "ask"
        for name in [
            "execute",
            "write_file",
            "edit_file",
            "browser_use",
            "acp",
            "send_file_to_user",
        ]:
            question.tool_call["name"] = name
            assert boundary.wrap_tool_call(question, handler).status == "error"
        assert handler.call_count == 1


def test_zhijun_mode_reads_prior_checkpoints_and_prefers_current_metadata():
    from langchain_core.messages import HumanMessage

    from octop.infra.agents.conversation_mode import zhijun_message_mode

    message = HumanMessage(content="继续", additional_kwargs={"zhijun_conversation_mode": "craft"})
    assert zhijun_message_mode(message) == "craft"
    message.additional_kwargs["zhijun_turn_mode"] = "ask"
    assert zhijun_message_mode(message) == "ask"


def test_sidebar_craft_recall_keeps_only_authorized_memory_tools(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from uuid import uuid4

    from langchain.agents.middleware import ModelRequest
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langchain_core.messages import HumanMessage
    from langchain_core.runnables.config import set_config_context
    from octop_harness.middleware import conversation_mode as harness
    from wanx_bridge.zhijun_memory import run_memory

    from octop.infra.agents import conversation_mode as host

    config = {"configurable": {"user": "42"}}
    monkeypatch.setattr(host, "get_config", lambda: config)
    monkeypatch.setattr(harness, "runtime_config", lambda _request: config)
    server = "wanx_knowledge_" + "a" * 32
    search = server + "_xingtu_search"
    stamped = host.stamp_assistant_mode(
        config, [server, "unrelated"], [search, server + "_delete"], "craft"
    )
    assert stamped["mcp_servers"] == [server]
    run_memory(
        tmp_path,
        42,
        {
            "action": "remember",
            "requestId": str(uuid4()),
            "text": "小林下周会搬去苏州",
        },
    )
    middleware = host.AssistantProfileMiddleware(tmp_path, 42)
    latest = HumanMessage(
        content="小林近况如何？",
        additional_kwargs={"assistant_persona": "zhijun", "zhijun_turn_mode": "craft"},
    )
    request = ModelRequest(
        model=FakeListChatModel(responses=[""]),
        messages=[latest],
        tools=[
            {"type": "function", "function": {"name": name}}
            for name in (search, "execute", server + "_delete")
        ],
    )

    def inspect_request(received):
        assert config["configurable"]["conversation_mode"] == "craft"
        assert "苏州" in received.system_message.text
        for token in ("Ask mode", "Plan mode", "Craft mode"):
            assert token not in received.system_message.text
        assert [tool["function"]["name"] for tool in received.tools] == [search]
        return SimpleNamespace(ok=True)

    inherited = harness.ConversationModeMiddleware()
    with host.zhijun_source_scope([], True):
        assert middleware.wrap_model_call(
            request, lambda incoming: inherited.wrap_model_call(incoming, inspect_request)
        ).ok
    assert config["configurable"]["conversation_mode"] == "craft"

    refs = [
        {"source": "space", "title": "交接文件", "text": "周四交接"},
        {"source": "memmy", "title": "AI 历史", "text": "来自本机"},
    ]
    with host.zhijun_source_scope(refs, False):
        result = middleware.wrap_model_call(request, lambda incoming: incoming.system_message.text)
        assert "周四交接" in result
        assert "来自本机" not in result
        assert "苏州" not in result

    config["configurable"] = {}
    resumed = SimpleNamespace(
        state={"messages": [latest]},
        tool_call={"id": "q", "name": "ask_user_question", "args": {}},
    )
    with set_config_context(config) as context:
        assert (
            context.run(middleware.wrap_tool_call, resumed, lambda _request: "answered")
            == "answered"
        )
        assert config["configurable"]["conversation_mode"] == "craft"
        resumed.tool_call["name"] = "execute"
        assert (
            context.run(middleware.wrap_tool_call, resumed, lambda _request: "unexpected").status
            == "error"
        )
        resumed.tool_call.update(name="read_file", args={"file_path": "/skills/example.md"})
        assert (
            context.run(middleware.wrap_tool_call, resumed, lambda _request: "unexpected").status
            == "error"
        )

        # A stale graph config or legacy Plan marker does not upgrade a
        # restored private assistant turn.
        for mode in (None, "plan", "ask"):
            resumed.state["messages"] = [
                latest.model_copy(
                    update={
                        "additional_kwargs": {
                            "assistant_persona": "zhijun",
                            "zhijun_turn_mode": mode,
                        }
                    }
                )
            ]
            resumed.tool_call.update(name="ask_user_question", args={})
            assert (
                context.run(middleware.wrap_tool_call, resumed, lambda _request: "answered")
                == "answered"
            )
            assert config["configurable"]["conversation_mode"] == "ask"
            resumed.tool_call.update(name="execute")
            assert (
                context.run(
                    middleware.wrap_tool_call, resumed, lambda _request: "unexpected"
                ).status
                == "error"
            )
