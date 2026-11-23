"""Per-call output caps; omission preserves the existing provider limit."""


class InvalidModelOutputLimit(ValueError):
    """Provider catalog metadata is invalid, not a bad caller budget."""


def output_budget(selection, requested=None):
    if requested is not None and (type(requested) is not int or not 1 <= requested <= 16384):
        raise ValueError("Invalid output budget")
    cap = selection.get("max_output_tokens")
    if cap is not None and (type(cap) is not int or cap < 1):
        raise InvalidModelOutputLimit("Invalid provider output limit")
    # Match Semantica's extraction configuration range. Omission still uses
    # the historical 4096 cap; an explicit request cannot exceed the model cap.
    return min(cap or requested or 4096, requested or 4096, 16384)


def truncated(metadata):
    return (
        metadata.get("done") is False
        or metadata.get("status") == "incomplete"
        or any(
            metadata.get(key) in ("length", "max_tokens", "max_output_tokens")
            for key in ("finish_reason", "stop_reason", "done_reason")
        )
    )
