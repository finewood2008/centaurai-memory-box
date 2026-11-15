"""Shared operation budgets and safe owner-workbench errors for both host entries."""

import re


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
        or path in {"/processing", "/processing/check"}
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
    }
)


def owner_error(code) -> bool:
    return isinstance(code, str) and (
        code in OWNER_ERROR_CODES
        or re.fullmatch(r"(?:CORRECTION|INVALID_CORRECTION)_[A-Z_]{1,100}", code) is not None
    )
