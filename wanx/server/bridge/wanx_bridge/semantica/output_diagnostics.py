"""Versioned, bounded model-output diagnostics; never include instance values."""

# This wire contract is mirrored in Semantica's app/adapters/output_diagnostics.py.
FIELDS = frozenset((
    "entities relations e r id text label confidence subject_id object_id predicate i n t c s o p a properties name value quote type source target evidence "
    "suggestions analysis_summary observations kind definition reason source_id owner_kind owner_name source_types target_types "
    "similar_to existing_gap business_need topic scope_ref summary questions explanation outcome field"
).split())
VALIDATORS = frozenset("type required additionalProperties minItems maxItems minLength maxLength minimum maximum exclusiveMinimum exclusiveMaximum enum const uniqueItems anyOf oneOf allOf not pattern format schema".split())
KINDS = frozenset({"schema_validation", "invalid_json", "truncated", "invalid_response", "response_too_large"})
REASONS = {
    "schema_validation": "模型输出未通过字段校验",
    "invalid_json": "模型输出不是有效 JSON",
    "truncated": "模型输出被截断",
    "invalid_response": "模型响应结构无效",
    "response_too_large": "模型响应超过大小限制",
    "required": "缺少必填字段",
    "additionalProperties": "包含不允许的字段（仅显示其所属对象路径）",
    "type": "字段类型不符合要求",
    "enum": "字段取值不在允许范围内",
    "minItems": "数组条目数量不足", "maxItems": "数组条目数量超限",
    "minLength": "字符串长度不足", "maxLength": "字符串长度超限",
    "minimum": "数值小于允许下限", "maximum": "数值超过允许上限",
}


def safe_path(parts):
    """Only fixed protocol keys and bounded indices; custom keys become '*'."""
    return "".join("/" + (str(p) if (type(p) is int and 0 <= p <= 1000000)
                          or (type(p) is str and p in FIELDS) else "*") for p in list(parts)[:16])


def diagnostic(kind, *, source="semantica", path=(), validator=None):
    result = {"version": 1, "source": source, "kind": kind, "field_path": safe_path(path)}
    if validator in VALIDATORS:
        result["validator"] = validator
    result["message"] = REASONS.get(validator, REASONS.get(kind, REASONS["invalid_response"]))
    return result


def sanitize_diagnostic(value):
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        return None
    kind, source, validator = value.get("kind"), value.get("source"), value.get("validator")
    if type(kind) is not str or kind not in KINDS or type(source) is not str or source not in {"bridge", "semantica", "upstream"}:
        return None
    raw = value.get("field_path", "")
    if type(raw) is not str or len(raw) > 512 or (raw and not raw.startswith("/")):
        return None
    parts = [int(p) if p.isascii() and p.isdecimal() and len(p) <= 7 else p for p in raw.split("/")[1:]]
    return diagnostic(kind, source=source, path=parts,
                      validator=validator if type(validator) is str else None)


def schema_diagnostic(error):
    """Describe the failing field without copying instance values or error messages."""
    path = list(error.absolute_path)
    if error.validator == "required" and isinstance(error.instance, dict):
        missing = next((key for key in error.validator_value if key not in error.instance), None)
        if missing is not None:
            path.append(missing)
    return diagnostic("schema_validation", source="bridge", path=path, validator=error.validator)


def safe_output_metadata(value):
    """Allow only bounded counters and known termination codes in server logs."""
    if not isinstance(value, dict):
        return {}
    result = {}
    for key in ("max_output_tokens", "requested_output_tokens", "response_bytes", "json_error_position"):
        number = value.get(key)
        if type(number) is int and 0 <= number <= 100_000_000:
            result[key] = number
    for key in ("finish_reason", "stop_reason", "done_reason", "status"):
        reason = value.get(key)
        if type(reason) is str and reason in {
            "stop", "length", "max_tokens", "max_output_tokens", "tool_calls",
            "function_call", "content_filter", "end_turn", "stop_sequence",
            "incomplete", "completed",
        }:
            result[key] = reason
    if type(value.get("done")) is bool:
        result["done"] = value["done"]
    return result


def termination_metadata(value):
    """Upstream may report termination, but cannot supply our measured counters."""
    return {key: item for key, item in safe_output_metadata(value).items()
            if key in {"finish_reason", "stop_reason", "done_reason", "status", "done"}}

