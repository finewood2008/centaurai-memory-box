"""Ask / Plan / Craft helpers for Octop (policy SoT lives in octop-harness)."""

from __future__ import annotations

import re
from typing import Any

from langgraph.config import get_config
from octop_harness.middleware.conversation_mode import (
    CONFIG_EXTRA_READ_KEY,
    CONFIG_MODE_KEY,
    DEFAULT_CONVERSATION_MODE,
    ConversationMode,
    ConversationModeMiddleware,
    is_allowed_plan_path,
    parse_conversation_mode,
)

HOST_READ_TOOLS: tuple[str, ...] = ("search_knowledge",)
_ASSISTANT_SOURCE = re.compile(r"^wanx_(?:space|knowledge)_[0-9a-f]{32}$")
_ASSISTANT_READ_TOOL = re.compile(
    r"^(wanx_(?:space|knowledge)_[0-9a-f]{32})_"
    r"(?:space_(?:list_spaces|list|search|read_document|read_bytes|read_image)|"
    r"xingtu_(?:warehouses|documents|graph|search|evidence))$"
)

_EXECUTE_EXACT = frozenset(
    {
        "执行计划",
        "按计划执行",
        "开始干",
        "开始干吧",
        "开始执行",
        "干吧",
        "开干",
        "executeplan",
        "executetheplan",
    }
)
_EXECUTE_CONTAINS = (
    "按计划执行",
    "execute the plan",
    "execute plan",
    "start executing",
)
_PLAN_FILE = r"plans/[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.md"
_DASHBOARD_EXECUTE_RES = (
    re.compile(rf"请按\s*{_PLAN_FILE}\s*执行"),
    re.compile(rf"(?i)(?:please\s+)?execute\s+{_PLAN_FILE}"),
)
_PUNCT_RE = re.compile(r"[\s，。！？、,.!?;:'\"“”‘’]+")


def resolve_conversation_mode(
    *,
    explicit: object | None = None,
    thread_mode: object | None = None,
) -> ConversationMode:
    """explicit (if a valid mode string) → thread sticky → craft."""
    if isinstance(explicit, str) and explicit in {"ask", "plan", "craft"}:
        return explicit  # type: ignore[return-value]
    if explicit is not None:
        return DEFAULT_CONVERSATION_MODE
    if thread_mode is not None:
        return parse_conversation_mode(thread_mode)
    return DEFAULT_CONVERSATION_MODE


def stamp_assistant_ask(
    request: dict[str, Any], servers: list[str] | None, tool_names: list[str]
) -> dict[str, Any]:
    """Ask with choice questions and existing, explicitly selected read-only sources."""
    stamp_conversation_mode(request, "ask")
    selected = [name for name in servers or [] if _ASSISTANT_SOURCE.fullmatch(name)]
    request["mcp_servers"] = selected
    config = request["configurable"]
    config["mcp_servers"] = selected
    config[CONFIG_EXTRA_READ_KEY] = [
        "ask_user_question",
        *(
            name
            for name in tool_names
            if (m := _ASSISTANT_READ_TOOL.fullmatch(name)) and m[1] in selected
        ),
    ]
    return request


class AssistantAskMiddleware(ConversationModeMiddleware):
    """Keep Ask after choice-answer resumes, which may omit the original turn config."""

    @staticmethod
    def _ask() -> None:
        config = get_config().setdefault("configurable", {})
        stamped = stamp_assistant_ask(
            {}, config.get("mcp_servers"), config.get(CONFIG_EXTRA_READ_KEY, [])
        )
        config.update(stamped["configurable"])

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        self._ask()
        return super().wrap_model_call(request, handler)

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        self._ask()
        return await super().awrap_model_call(request, handler)

    def wrap_tool_call(self, request: Any, handler: Any) -> Any:
        self._ask()
        return super().wrap_tool_call(request, handler)

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        self._ask()
        return await super().awrap_tool_call(request, handler)


def plan_relpath_from_artifact(path: str) -> str:
    """Return ``plans/<slug>.md`` if *path* points at an allowed plan file."""
    raw = (path or "").strip().replace("\\", "/")
    parts = [p for p in raw.lstrip("/").split("/") if p and p != "."]
    if len(parts) >= 2 and parts[-2] == "plans":
        rel = f"plans/{parts[-1]}"
        if is_allowed_plan_path(rel):
            return rel
    stripped = raw.lstrip("/")
    return stripped if is_allowed_plan_path(stripped) else ""


def execute_user_message(plan_path: str, locale: str | None = None) -> str:
    """Visible user-turn text that tells craft mode to follow the plan file."""
    from octop.i18n import tr
    from octop.infra.utils.locale import DEFAULT_LOCALE

    rel = plan_relpath_from_artifact(plan_path) or plan_path.strip()
    return tr("conversation_mode.execute", locale or DEFAULT_LOCALE, path=rel)


def is_plan_execute_utterance(text: str) -> bool:
    """Loose match for IM/CLI 'run the pending plan' messages."""
    raw = (text or "").strip()
    if not raw:
        return False
    if any(pattern.search(raw) for pattern in _DASHBOARD_EXECUTE_RES):
        return True
    lowered = raw.lower()
    for needle in _EXECUTE_CONTAINS:
        if needle in lowered or needle in raw:
            return True
    compact = _PUNCT_RE.sub("", raw).lower()
    return compact in _EXECUTE_EXACT


def stamp_conversation_mode(
    request: dict[str, Any],
    mode: ConversationMode,
) -> None:
    """Write mode + Ask/Plan host overlays onto a harness request dict."""
    configurable = dict(request.get("configurable") or {})
    configurable[CONFIG_MODE_KEY] = mode
    if mode in ("ask", "plan"):
        configurable[CONFIG_EXTRA_READ_KEY] = list(HOST_READ_TOOLS)
        request["skills"] = []
        request["mcp_servers"] = []
        configurable["skills"] = []
        configurable["mcp_servers"] = []
        configurable.pop("mcp_use_default", None)
    request["configurable"] = configurable
    request["conversation_mode"] = mode


__all__ = [
    "CONFIG_EXTRA_READ_KEY",
    "CONFIG_MODE_KEY",
    "DEFAULT_CONVERSATION_MODE",
    "HOST_READ_TOOLS",
    "ConversationMode",
    "execute_user_message",
    "is_allowed_plan_path",
    "is_plan_execute_utterance",
    "parse_conversation_mode",
    "plan_relpath_from_artifact",
    "resolve_conversation_mode",
    "stamp_conversation_mode",
]
