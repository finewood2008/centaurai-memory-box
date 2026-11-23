"""Finite native-owner operations, always inside a signed selected warehouse.

This does not expose the instance-wide native API. Semantica still validates
each resource's ownership and the endpoint's existing request DTO.
"""

from __future__ import annotations

import re
from typing import Any

ID = r"[A-Za-z0-9_-]{1,128}"
PAGE = frozenset({"limit", "offset"})
COMPARE = PAGE | {"before_id", "after_id", "changes_only"}
CORRECTION = rf"/documents/{ID}/corrections"
RELEASE = rf"/knowledge-releases/{ID}"

# Method/path/query triples. New native endpoints must be reviewed explicitly.
RULES = [
    ("GET", r"/settings/status", frozenset()),
    ("GET", r"/ontologies", frozenset()),
    ("POST", r"/ontologies", frozenset()),
    ("POST", rf"/ontologies/{ID}/publish", frozenset()),
    ("GET", r"/ontology-suggestions/materials", frozenset()),
    ("POST", r"/ontology-suggestions/(?:generate|draft)", frozenset()),
    ("POST", rf"/ontology-suggestions/{ID}/validate", frozenset()),
    ("POST", rf"/ontology-suggestions/materials/{ID}/(?:schedule|review|dismiss)", frozenset()),
    ("GET", rf"/ontology-updates/{ID}", PAGE | {"scope"}),
    ("POST", rf"/ontology-updates/{ID}/(?:start|retry)", frozenset()),
    ("GET", r"/documents", PAGE),
    ("GET", rf"/documents/{ID}", frozenset({"segment_offset", "segment_limit"})),
    ("GET", rf"/documents/{ID}/versions", frozenset()),
    ("PATCH", rf"/documents/{ID}/content", frozenset()),
    ("POST", rf"/documents/{ID}/knowledge", frozenset()),
    ("GET", r"/jobs", PAGE),
    ("GET", rf"/jobs/{ID}", frozenset()),
    ("POST", rf"/jobs/{ID}/(?:retry|cancel)", frozenset()),
    ("GET", r"/knowledge/runs", PAGE | {"document_id"}),
    ("GET", rf"/knowledge/runs/{ID}", frozenset()),
    ("GET", CORRECTION + r"/events", frozenset({"after_id", "limit"})),
    ("POST", r"/_correction_read", frozenset()),
    ("POST", CORRECTION + r"/sessions", frozenset()),
    ("GET", CORRECTION + r"/leases", frozenset()),
    ("GET", CORRECTION + r"/current-extraction", frozenset()),
    ("POST", CORRECTION + r"/current-extraction/draft", frozenset()),
    ("POST", CORRECTION + rf"/{ID}/(?:claim|release|heartbeat)", frozenset()),
    ("GET", CORRECTION + r"/events/[0-9]+", PAGE),
    ("GET", CORRECTION + rf"/{ID}", frozenset()),
    ("GET", CORRECTION + rf"/{ID}/items", PAGE | {"revision", "kind", "keyword"}),
    ("GET", CORRECTION + rf"/{ID}/items/{ID}", frozenset({"revision"})),
    ("GET", CORRECTION + rf"/{ID}/items/{ID}/relations", PAGE | {"revision"}),
    ("GET", CORRECTION + rf"/{ID}/sources", PAGE | {"revision"}),
    ("GET", CORRECTION + rf"/{ID}/sources/{ID}", frozenset({"revision", "start"})),
    ("GET", CORRECTION + rf"/{ID}/preview", PAGE | {"revision"}),
    ("GET", CORRECTION + rf"/{ID}/(?:suggestions|extraction-results)", PAGE | {"revision", "kind"}),
    ("GET", CORRECTION + rf"/{ID}/publication", frozenset()),
    ("POST", CORRECTION, frozenset()),
    (
        "POST",
        CORRECTION
        + rf"/{ID}/(?:rules|apply|save|discard|submit|rebase|ontology|extraction-results/adopt|suggestions/adopt|publication/retry|items/{ID}/reset)",
        frozenset(),
    ),
    ("GET", r"/knowledge-releases", PAGE),
    ("POST", r"/knowledge-releases/baseline", frozenset()),
    ("GET", r"/knowledge-releases/compare", COMPARE),
    (
        "GET",
        rf"/knowledge-releases/compare/documents/{ID}/(?:items|sources|body|ontology)",
        COMPARE | {"kind", "before_item", "after_item"},
    ),
    ("GET", RELEASE, PAGE),
    (
        "GET",
        RELEASE + rf"/documents/{ID}/(?:items(?:/{ID}/sources)?|text|restore-preview)",
        PAGE | {"kind"},
    ),
    ("POST", RELEASE + rf"/documents/{ID}/restore", frozenset()),
    ("POST", r"/material-maintenance/(?:status|reload)", frozenset()),
    ("GET", r"/search/indexes", frozenset()),
    ("POST", r"/search(?:/indexes|/confirm)?", frozenset()),
    ("GET", r"/search/source-details", PAGE | {"kind", "document_id", "index_id", "item_id"}),
    ("GET", r"/sensitive/settings", frozenset()),
    ("POST", r"/sensitive/settings", frozenset()),
    ("GET", r"/graph/neighborhood", frozenset({"entity_id", "limit"})),
]

SCOPE_FIELDS = frozenset(
    {
        "workspace_id",
        "workspace_ids",
        "warehouse_id",
        "box_id",
        "application_id",
        "actor_id",
        "resource_owner",
        "organization_permissions",
        "owner_view",
        "permissions",
    }
)


def prepare(
    method: str, path: str, body: dict[str, Any] | None, query: dict[str, str]
) -> tuple[dict[str, Any] | None, str | None]:
    pending: list[Any] = [body]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if SCOPE_FIELDS.intersection(value):
                raise PermissionError()
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    if "scope" in query and query["scope"] not in {"all", "selectable"}:
        raise ValueError()
    if path == "/workbench/_correction_read":
        if (
            method != "POST"
            or not isinstance(body, dict)
            or set(body) != {"path", "query", "_native_editor", "_native_operation_id"}
            or query
        ):
            raise ValueError()
        target, selectors = body["path"], body["query"]
        if not isinstance(target, str) or not re.fullmatch(
            "/api" + CORRECTION + r"(?:/[A-Za-z0-9_/-]+)?", target
        ):
            raise ValueError()
        allowed = query_keys("GET", "/workbench" + target[4:])
        if (
            allowed is None
            or not isinstance(selectors, dict)
            or set(selectors) - allowed
            or any(not isinstance(value, str) for value in selectors.values())
        ):
            raise ValueError()
    if body is not None and "_native_editor" in body:
        editor = body["_native_editor"]
        allowed_editor = (
            path == "/workbench/_correction_read"
            or re.fullmatch("/workbench" + CORRECTION + r"(?:/[A-Za-z0-9_/-]+)?", path)
            or (
                method == "POST"
                and re.fullmatch("/workbench" + RELEASE + rf"/documents/{ID}/restore", path)
            )
        )
        if (
            not allowed_editor
            or not isinstance(editor, dict)
            or set(editor) != {"session", "generation"}
        ):
            raise ValueError()
        if not isinstance(editor["session"], str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{20,200}", editor["session"]
        ):
            raise ValueError()
        if not isinstance(editor["generation"], str) or not re.fullmatch(
            r"[0-9]{1,12}", editor["generation"]
        ):
            raise ValueError()
    if method == "GET":
        return None, None
    payload = dict(body or {})
    operation = payload.get("_native_operation_id")
    if not isinstance(operation, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", operation):
        raise ValueError()
    # Some native DTOs have their own idempotency operation_id. The desktop
    # deliberately uses that same ID for the signed transport grant.
    if payload.get("operation_id", operation) != operation:
        raise ValueError()
    return payload, operation


def query_keys(method: str, path: str) -> frozenset[str] | None:
    for allowed_method, pattern, keys in RULES:
        if method == allowed_method and re.fullmatch("/workbench" + pattern, path):
            return frozenset(keys)
    return None
