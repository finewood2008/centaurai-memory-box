"""Closed reasoning metadata for leased model projection; no provider SDK needed."""

import re
from urllib.parse import urlsplit

ADAPTERS = frozenset(
    {
        "status_only",
        "thinking",
        "thinking_nested_effort",
        "openai_reasoning_effort",
        "anthropic_adaptive",
        "anthropic_budget",
        "dashscope",
        "openrouter",
    }
)


def reasoning_metadata(value):
    if not isinstance(value, dict) or type(value.get("supported", True)) is not bool:
        raise ValueError("Invalid reasoning capability")
    if value.get("supported") is False:
        return {"supported": False}
    adapter = value.get("adapter", "status_only")
    toggle = value.get("toggle", False)
    mode = value.get("default_mode", "auto")
    efforts = value.get("efforts", [])
    effort = value.get("default_effort")
    effort_type = value.get("effort_type", "enum")
    if (
        not isinstance(adapter, str)
        or adapter not in ADAPTERS
        or type(toggle) is not bool
        or mode not in ("auto", "enabled", "disabled")
        or effort_type not in ("enum", "token_budget")
        or not isinstance(efforts, list)
        or len(efforts) > 16
        or any(not isinstance(x, str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", x) for x in efforts)
        or effort is not None
        and effort not in efforts
    ):
        raise ValueError("Invalid reasoning capability")
    if adapter == "status_only":
        mode, efforts, effort = "enabled", [], None
    return {
        "supported": True,
        "toggle": toggle and adapter != "status_only",
        "default_mode": mode,
        "adapter": adapter,
        "efforts": list(dict.fromkeys(efforts)),
        "default_effort": effort,
        "effort_type": effort_type,
    }


def verified_reasoning(base_url, model):
    # This exact gateway/model pair was tested with disabled+none and enabled+high.
    # Aliases, different gateways and newer models need their own verified contract.
    url = urlsplit(base_url)
    if (
        url.scheme == "https"
        and url.netloc == "token.qeeshu.com"
        and url.path.rstrip("/") == "/v1"
        and not url.query
        and not url.fragment
        and model == "deepseek-flash"
    ):
        return reasoning_metadata(
            {
                "supported": True,
                "toggle": True,
                "adapter": "thinking",
                "efforts": ["none", "high"],
                "default_effort": "high",
            }
        )
    return None
