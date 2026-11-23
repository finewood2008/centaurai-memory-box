"""Shared operation budgets and safe owner-workbench errors for both host entries."""

import re


def private_search_error(status: int, error: dict) -> str | None:
    nested = error.get("error")
    if status == 409 and isinstance(nested, dict):
        code = nested.get("code")
        if code in ("INDEX_REQUIRED", "INDEX_STALE", "NO_PARSED_CONTENT", "EMBEDDING_NOT_CONFIGURED"):
            return f"SEMANTICA_{code}"
    return None


_INVALID_IMPORT_CONTENT = frozenset({
    "文件类型与 Content-Type 不匹配",
    "文件内容不是有效的 DOCX",
    "文件内容不是有效的 PDF",
    "文件内容不是有效的 XLS",
    "图片内容与文件扩展名不匹配",
    "图片内容与 Content-Type 不匹配",
    "音频内容与文件扩展名不匹配",
    "音频内容与 Content-Type 不匹配",
    "Office 文件内容与扩展名不匹配",
    "Office 文件损坏或不是有效的 ZIP",
})


def private_import_error(status: int, error: dict) -> str | None:
    # Existing boxes return these known refusals as strings. Only the stable
    # code crosses the desktop boundary.
    detail = error.get("detail")
    if not isinstance(detail, str):
        return None
    if status == 415 and detail in _INVALID_IMPORT_CONTENT:
        return "SEMANTICA_FILE_CONTENT_MISMATCH"
    if status == 422 and detail == "DOCX 已加密，无法解析":
        return "SEMANTICA_FILE_ENCRYPTED"
    return None


def operation_timeout(path: str) -> int:
    if (
        path == "/workbench/ontology-suggestions/generate"
        or re.fullmatch(r"/workbench/conversations/[A-Za-z0-9_-]{1,128}/ontology-edit/(?:turns|proposals)", path)
        or re.fullmatch(
            r"/workbench/conversations/[A-Za-z0-9_-]{1,128}/onboarding/(turns|start)", path
        )
        or re.fullmatch(
            r"/workbench/conversations/[A-Za-z0-9_-]{1,128}/intents/[A-Za-z0-9_-]{1,128}/change-proposals",
            path,
        )
        or re.fullmatch(
            r"/workbench/ontology-suggestions/materials/[A-Za-z0-9_-]{1,128}/review", path
        )
        or re.fullmatch(
            r"/workbench/conversations/[A-Za-z0-9_-]{1,128}/instruction-plans(?:/[A-Za-z0-9_-]{1,128}/prepare)?", path
        )
        or path in {"/processing", "/processing/check", "/workbench/sensitive/preview"}
        or path.startswith("/reasoning/")
    ):
        return 285
    return 85 if path in {"/search", "/workbench/search"} else 45


def grant_ttl(timeout: int) -> int:
    # Semantica rechecks authorization after a workbench operation finishes.
    # Its maximum accepted grant is 300 s; reserve 15 s for delivery.
    return min(300, max(120, timeout + 15))


OWNER_ERROR_CODES = frozenset(
    {
        "ONTOLOGY_CONSTRAINT",
        "ONTOLOGY_CONTEXT_TOO_SMALL",
        "ONTOLOGY_INVALID_OUTPUT",
        "ONTOLOGY_MODEL_FAILED",
        "ONTOLOGY_MODEL_TIMEOUT",
        "ONTOLOGY_OPERATION_CONFLICT",
        "ONTOLOGY_OWNER_REQUIRED",
        "ONTOLOGY_SOURCE_MISMATCH",
        "ONTOLOGY_SOURCE_NOT_FOUND",
        "ONTOLOGY_SOURCE_NOT_READY",
        "ONTOLOGY_SUGGESTION_BUSY",
        "ONTOLOGY_SUGGESTION_EXPIRED",
        "ONTOLOGY_SUGGESTION_STALE",
        "ONTOLOGY_TARGET_CHANGED",
        "ONTOLOGY_UPDATE_BUSY",
        "ONTOLOGY_UPDATE_CONFIRMATION_REQUIRED",
        "ONTOLOGY_UPDATE_STALE",
        "RELEASE_DOCUMENT_UNAVAILABLE",
        "RELEASE_ITEM_NOT_FOUND",
        "RELEASE_NOT_FOUND",
        "RELEASE_PROJECTION_INCOMPLETE",
        "RESTORE_CONFIRMATION_REQUIRED",
        "RESTORE_KNOWLEDGE_UNAVAILABLE",
        "RESTORE_NOTE_INVALID",
        "RESTORE_PREVIEW_STALE",
        "RESTORE_SNAPSHOT_INCOMPLETE",
        "SENSITIVE_REVISION_CONFLICT",
        "SENSITIVE_RULE_INVALID",
        "SENSITIVE_SIMILAR_RULE",
        "SENSITIVE_PREVIEW_FAILED",
    }
)


def owner_error(code) -> bool:
    return isinstance(code, str) and (
        code in OWNER_ERROR_CODES
        or re.fullmatch(r"(?:CORRECTION|INVALID_CORRECTION)_[A-Z_]{1,100}", code) is not None
    )


def owner_error_message(code, message) -> str | None:
    if code == "SENSITIVE_SIMILAR_RULE" and isinstance(message, str) and re.fullmatch(
        r"规则与 [a-z][a-z0-9_]{0,79} 相似", message
    ):
        return message
    return None
