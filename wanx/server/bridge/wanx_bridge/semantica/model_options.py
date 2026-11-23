"""Shared thinking-mode validation and wire controls for both model callbacks."""

from urllib.parse import urlsplit

from .desktop import DesktopError


def inference_options(body, error=DesktopError):
    options = body.get("inference_options", {})
    if (
        not isinstance(options, dict)
        or set(options) - {"thinking_mode"}
        or options.get("thinking_mode", "auto") not in ("auto", "on", "off")
    ):
        raise error("MODEL_OPTIONS_INVALID", 422)
    return {"thinking_mode": options.get("thinking_mode", "auto")}


def request_parameters(capability, *, mode, effort):
    """SDK-free equivalent of the host adapter's model-fields/body envelope."""
    adapter = capability["adapter"]
    enabled = mode == "enabled"
    fields, body = {}, {}
    if adapter == "openai_reasoning_effort":
        fields["reasoning_effort"] = effort if enabled else "none"
    elif adapter in {"thinking", "thinking_nested_effort"}:
        body["thinking"] = {"type": mode}
        if effort:
            if adapter == "thinking_nested_effort":
                body["thinking"]["reasoning_effort"] = effort
            else:
                body["reasoning_effort"] = effort
    elif adapter == "dashscope":
        body["enable_thinking"] = enabled
        if enabled and effort:
            if capability.get("effort_type") == "token_budget" and effort.isdigit():
                body["thinking_budget"] = int(effort)
            else:
                body["reasoning_effort"] = effort
    elif adapter == "openrouter":
        body["reasoning"] = {"enabled": enabled}
        if enabled and effort:
            body["reasoning"]["effort"] = effort
    elif adapter in {"anthropic_adaptive", "anthropic_budget"}:
        fields["thinking"] = (
            (
                {"type": "adaptive"}
                if adapter == "anthropic_adaptive"
                else {
                    "type": "enabled",
                    "budget_tokens": int(effort) if effort and effort.isdigit() else 1024,
                }
            )
            if enabled
            else None
        )
        if enabled and effort and adapter == "anthropic_adaptive":
            fields["reasoning_effort"] = effort
    else:
        raise DesktopError("MODEL_THINKING_UNSUPPORTED", 422)
    return {"model_fields": fields, "extra_body": body}


def thinking_overrides(
    provider, selection, mode, *, builder=request_parameters, error=DesktopError
):
    if mode == "auto":
        return {}
    capability = selection.get("reasoning_config")
    if (
        not capability
        or capability.get("supported", True) is not True
        or capability.get("adapter") == "status_only"
        or mode == "off"
        and not capability.get("toggle", False)
    ):
        raise error("MODEL_THINKING_UNSUPPORTED", 422)
    kind = provider.get("kind") if isinstance(provider, dict) else provider.kind
    base = provider.get("base_url") if isinstance(provider, dict) else provider.base_url
    parsed = urlsplit(base or "")
    if kind == "ollama" or (
        parsed.hostname in {"localhost", "127.0.0.1", "::1"} and parsed.port == 11434
    ):
        return {
            "extra_body": {"think": mode == "on"},
            "model_fields": {"reasoning_effort": "high" if mode == "on" else "none"},
        }
    effort = capability.get("default_effort") if mode == "on" else None
    if mode == "off" and capability.get("adapter") in {"thinking", "thinking_nested_effort"}:
        effort = "none" if "none" in capability.get("efforts", []) else None
    if mode == "on":
        if effort == "none" or (
            not effort and capability.get("adapter") == "openai_reasoning_effort"
        ):
            effort = next((x for x in capability.get("efforts", []) if x != "none"), None)
        if not effort and capability.get("adapter") == "openai_reasoning_effort":
            raise error("MODEL_THINKING_UNSUPPORTED", 422)
        # The Host builder falls back to default_effort when effort is omitted.
        capability = {**capability, "default_effort": effort}
    capability = {**capability, "default_effort": None} if mode == "off" else capability
    return dict(builder(capability, mode="enabled" if mode == "on" else "disabled", effort=effort))


def thinking_modes(provider, selection, **kwargs):
    modes = ["auto"]
    for mode in ("on", "off"):
        try:
            thinking_overrides(provider, selection, mode, **kwargs)
        except (kwargs.get("error", DesktopError), ValueError):
            continue
        modes.append(mode)
    return modes
