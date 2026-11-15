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


def test_ask_keeps_questions_and_selected_reads_without_execution(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from octop_harness.middleware import conversation_mode as mode
    from octop_harness.middleware import runtime

    from octop.infra.agents.conversation_mode import stamp_assistant_ask

    server = "wanx_knowledge_" + "a" * 32
    names = ["ask_user_question", server + "_xingtu_search", server + "_delete", "execute"]
    request = stamp_assistant_ask({"skills": ["build"]}, [server], names)
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
        boundary = host_mode.AssistantAskMiddleware()
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
