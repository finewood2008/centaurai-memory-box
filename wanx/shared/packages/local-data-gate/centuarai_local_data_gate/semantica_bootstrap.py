"""Finite personal bootstrap and model-selection request contracts.

These functions validate transport, never choose a principal or resolve an
owner. Selected warehouse paths and any matching DTO reference must already be
bound to the verified gateway context by the route adapter and domain service.
The private model authorization callback is deliberately not an external route.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from typing import Any

from .starlink_workbench import ID, SAFE_INTEGER, selectable_scope

UUID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"
WAREHOUSE = rf"/warehouses/(?P<warehouse_id>{UUID})"
MODELING = rf"/modeling/warehouses/(?P<workspace_id>{UUID})"
ROUTES = (
    ("GET", "/warehouses", frozenset(), "list_warehouses"),
    ("POST", "/warehouses", frozenset(), "create_warehouse"),
    ("GET", "/warehouses/runtime", frozenset(), "get_warehouse_runtime"),
    ("GET", WAREHOUSE, frozenset(), "get_warehouse"),
    ("PATCH", WAREHOUSE, frozenset(), "rename_warehouse"),
    ("POST", WAREHOUSE + "/delete/prepare", frozenset(), "prepare_delete_warehouse"),
    ("POST", WAREHOUSE + "/delete", frozenset(), "delete_warehouse"),
    ("GET", "/modeling/onboarding", frozenset(), "get_onboarding"),
    ("POST", "/modeling/onboarding", frozenset(), "save_onboarding"),
    ("GET", "/modeling/warehouses", frozenset(), "list_modeling_warehouses"),
    ("POST", rf"/modeling/onboarding/(?P<onboarding_id>{ID})/warehouse", frozenset(), "create_onboarding_warehouse"),
    ("GET", MODELING + "/suggestion-context", frozenset(), "get_modeling_suggestion_context"),
    ("POST", MODELING + "/warehouse-scope/publish", frozenset(), "publish_warehouse_scope"),
    ("POST", MODELING + "/answer-confirmations", frozenset(), "confirm_modeling_answers"),
    ("POST", MODELING + "/answer-suggestions", frozenset(), "generate_modeling_suggestions"),
    ("GET", MODELING + rf"/answer-suggestions/(?P<suggestion_id>{ID})", frozenset(), "get_modeling_suggestion"),
    ("GET", MODELING + rf"/answer-suggestions/(?P<suggestion_id>{ID})/rules", frozenset(), "get_modeling_suggestion_rules"),
    ("POST", MODELING + "/rule-previews", frozenset(), "prepare_modeling_rules"),
    ("POST", MODELING + rf"/rule-previews/(?P<preview_id>{ID})/publish", frozenset(), "publish_modeling_rules"),
    ("POST", MODELING + "/impact-preview", frozenset(), "preview_modeling_impact"),
    ("POST", MODELING + "/impact-preview/validate", frozenset(), "validate_modeling_impact"),
    ("POST", MODELING + "/rule-executions", frozenset(), "execute_modeling_rules"),
    ("GET", MODELING + "/rule-executions", frozenset({"offset"}), "list_modeling_rule_executions"),
    ("GET", MODELING + rf"/rule-executions/(?P<execution_id>{ID})", frozenset(), "get_modeling_rule_execution"),
    ("POST", MODELING + rf"/rule-executions/(?P<execution_id>{ID})/retry", frozenset(), "retry_modeling_rule_execution"),
    ("GET", "/processing", frozenset({"warehouse_id"}), "read_processing"),
    ("GET", "/processing/catalog", frozenset(), "model_catalog"),
    ("POST", "/processing/check", frozenset(), "check_processing"),
    ("PUT", "/processing", frozenset(), "save_processing"),
)


def _match(method, path):
    for allowed, pattern, query, operation in ROUTES:
        if method == allowed and (match := re.fullmatch(pattern, path)) is not None:
            return match, query, operation
    return None


def operation_name(method: str, path: str) -> str | None:
    found = _match(method, path)
    return found[2] if found else None


def query_keys(method: str, path: str) -> frozenset[str] | None:
    found = _match(method, path)
    return found[1] if found else None


def _text(value, minimum=1, maximum=120):
    return isinstance(value, str) and minimum <= len(value) <= maximum


def _choice(value, choices):
    return isinstance(value, str) and value in choices


def _integer(value, minimum=0, maximum=SAFE_INTEGER):
    return type(value) is int and minimum <= value <= maximum


def _operation(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,120}", value) is not None


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= value.keys() or value.keys() - (set(required) | set(optional)):
        raise ValueError("Semantica bootstrap fields are invalid")


def validate_query(method: str, path: str, query: Mapping[str, str]) -> None:
    keys = query_keys(method, path)
    if keys is None or query.keys() - keys or any(not isinstance(value, str) for value in query.values()):
        raise ValueError("Semantica bootstrap query is invalid")
    if "offset" in query and (re.fullmatch(r"0|[1-9][0-9]{0,15}", query["offset"]) is None
            or not 0 <= int(query["offset"]) <= SAFE_INTEGER):
        raise ValueError("Semantica bootstrap pagination is invalid")
    if "warehouse_id" in query and re.fullmatch(UUID, query["warehouse_id"]) is None:
        raise ValueError("Semantica warehouse reference is invalid")


def validate_selection(body: dict | None, query: Mapping[str, str], selected_warehouse: str | None) -> None:
    """A DTO reference can confirm, never replace, the verified route selection.

    Pass the route adapter's resolved external warehouse ID, including the
    canonical default-warehouse alias when applicable. None denotes only the
    root/default processing configuration, not a wildcard warehouse selection.
    """
    for values in (body or {}, query):
        identifier = values.get("warehouse_id")
        if identifier is not None and (identifier != selected_warehouse
                or not isinstance(identifier, str) or re.fullmatch(UUID, identifier) is None):
            raise ValueError("Semantica warehouse reference does not match verified route")


_ANSWER_FIELDS = {"industry": 200, "occupation": 200, "background": 8000,
    "purpose": 16000, "material_types": 8000, "questions": 8000}
_ONBOARDING_ANSWER_FIELDS = _ANSWER_FIELDS | {"warehouse_name": 60,
    "background_sample": 60, "purpose_sample": 60, "creation_operation": 120}


def _answers(value, *, onboarding=False):
    limits = _ONBOARDING_ANSWER_FIELDS if onboarding else _ANSWER_FIELDS
    _fields(value, (), set(limits) | ({"flow_step", "flow_mode"} if onboarding else set()))
    if any(not _text(item, 0, limits[name]) for name, item in value.items() if name in limits):
        raise ValueError("Semantica onboarding answer is invalid")
    if "creation_operation" in value and value["creation_operation"] and not _operation(value["creation_operation"]):
        raise ValueError("Semantica creation operation is invalid")
    if not _choice(value.get("flow_step", ""), {"", "background", "purpose", "confirm"}):
        raise ValueError("Semantica onboarding step is invalid")
    if not _choice(value.get("flow_mode", ""), {"", "create", "profile"}):
        raise ValueError("Semantica onboarding mode is invalid")


def _id_list(value, minimum, maximum):
    return isinstance(value, list) and minimum <= len(value) <= maximum and all(_text(item, 1, 120) for item in value)


def _impact(value, *, validate=False):
    _fields(value, {"base_ontology_id"} | ({"preview_token"} if validate else set()),
        {"schema", "ontology_draft_id", "rule_draft_id", "document_ids", "offset", "limit"})
    if not _text(value["base_ontology_id"]):
        raise ValueError("Semantica ontology reference is invalid")
    for name in ("ontology_draft_id", "rule_draft_id"):
        if value.get(name) is not None and not _text(value[name]):
            raise ValueError("Semantica rule draft reference is invalid")
    if value.get("schema") is not None and not isinstance(value["schema"], dict):
        raise ValueError("Semantica rule schema is invalid")
    if value.get("document_ids") is not None and not _id_list(value["document_ids"], 1, 20):
        raise ValueError("Semantica material selection is invalid")
    if not _integer(value.get("offset", 0)) or not _integer(value.get("limit", 20), 1, 20):
        raise ValueError("Semantica impact pagination is invalid")
    if validate and not _digest(value["preview_token"]):
        raise ValueError("Semantica impact digest is invalid")


_SCOPE_LIMITS = {"industry": 0, "occupation": 0, "service_objects": 6,
    "purposes": 6, "material_sources": 6, "questions_to_answer": 6,
    "excluded_scope": 6, "uncertain_items": 8}


def validate_scope_changes(value):
    _fields(value, (), _SCOPE_LIMITS)
    if not value:
        raise ValueError("Warehouse scope changes are required")
    for field, item in value.items():
        limit = _SCOPE_LIMITS[field]
        if not (isinstance(item, list) and len(item) <= limit
                and all(_text(text, 1, 300) and text.strip() for text in item)
                if limit else _text(item, 0, 200)):
            raise ValueError("Warehouse scope field is invalid")


_BODY_FIELDS = {
    "publish_warehouse_scope": ({"expected_revision", "base_ontology_id", "changes", "confirmed"}, set()),
    "create_warehouse": ({"name"}, {"description"}),
    "rename_warehouse": ({"name"}, set()),
    "prepare_delete_warehouse": (set(), set()),
    "delete_warehouse": ({"confirmation_token", "typed_name"}, set()),
    "save_onboarding": ({"expected_revision", "answers"}, {"status"}),
    "create_onboarding_warehouse": ({"expected_revision", "name"}, {"purpose"}),
    "confirm_modeling_answers": ({"expected_revision", "onboarding_revision", "answers"}, {"expected_confirmation_id"}),
    "generate_modeling_suggestions": ({"confirmation_id", "base_ontology_id"}, set()),
    "prepare_modeling_rules": ({"proposal_id", "name", "schema", "decisions"}, {"expected_draft_id"}),
    "publish_modeling_rules": ({"schema_digest", "confirmed"}, set()),
    "preview_modeling_impact": ({"base_ontology_id"}, {"schema", "ontology_draft_id", "rule_draft_id", "document_ids", "offset", "limit"}),
    "validate_modeling_impact": ({"base_ontology_id", "preview_token"}, {"schema", "ontology_draft_id", "rule_draft_id", "document_ids", "offset", "limit"}),
    "execute_modeling_rules": ({"confirmed", "mode", "name", "preview"}, set()),
    "retry_modeling_rule_execution": ({"confirmed"}, set()),
    "check_processing": ({"extraction"}, {"warehouse_id", "mode", "sensitive", "sensitive_follow", "inference_options", "cloud_confirmations"}),
    "save_processing": ({"expected_revision"}, {"warehouse_id", "inherit", "mode", "check_id"}),
}


def validate_body(method: str, path: str, body: dict[str, Any] | None) -> str | None:
    operation = operation_name(method, path)
    if operation is None:
        raise ValueError("Semantica bootstrap operation is not registered")
    if method == "GET":
        if body is not None:
            raise ValueError("Semantica bootstrap read cannot carry a body")
        return None
    required, optional = _BODY_FIELDS[operation]
    # Read-only impact POSTs intentionally have no mutation idempotency field.
    has_operation = operation not in {"preview_modeling_impact", "validate_modeling_impact"}
    _fields(body, required | ({"operation_id"} if has_operation else set()), optional)
    references = {key: value for key, value in body.items() if key != "warehouse_id"}
    if selectable_scope(references):
        raise ValueError("Semantica bootstrap authority is not body-selectable")
    if has_operation and not _operation(body["operation_id"]):
        raise ValueError("Semantica bootstrap operation id is invalid")
    if operation == "delete_warehouse" and (
        not _text(body["confirmation_token"], 1, 8192)
        or not _text(body["typed_name"], 1, 120)
        or not body["typed_name"].strip()
    ):
        raise ValueError("Semantica warehouse deletion confirmation is invalid")
    for name in ("expected_revision", "onboarding_revision"):
        if name in body and not _integer(body[name]):
            raise ValueError("Semantica bootstrap revision is invalid")
    if "name" in body and not _text(body["name"], 1, 60 if operation in {"create_warehouse", "rename_warehouse", "create_onboarding_warehouse"} else 120):
        raise ValueError("Semantica warehouse or rule name is invalid")
    if operation == "rename_warehouse" and (not 1 <= len(body["name"].strip()) <= 60
            or any(unicodedata.category(char) == "Cc" for char in body["name"])):
        raise ValueError("Semantica warehouse name is invalid")
    if "description" in body and not _text(body["description"], 0, 500):
        raise ValueError("Semantica warehouse description is invalid")
    if "purpose" in body and not _text(body["purpose"], 0, 16000):
        raise ValueError("Semantica warehouse purpose is invalid")
    if "answers" in body:
        _answers(body["answers"], onboarding=operation == "save_onboarding")
    if "status" in body and not _choice(body["status"], {"in_progress", "skipped", "completed"}):
        raise ValueError("Semantica onboarding status is invalid")
    for name in ("expected_confirmation_id", "expected_draft_id", "check_id"):
        if body.get(name) is not None and not _text(body[name]):
            raise ValueError("Semantica confirmation or draft reference is invalid")
    for name in ("confirmation_id", "base_ontology_id", "proposal_id"):
        if name in body and not _text(body[name]):
            raise ValueError("Semantica modeling reference is invalid")
    if "schema" in body and body["schema"] is not None and not isinstance(body["schema"], dict):
        raise ValueError("Semantica modeling schema is invalid")
    if "confirmed" in body and type(body["confirmed"]) is not bool:
        raise ValueError("Semantica modeling confirmation is invalid")
    if operation == "publish_warehouse_scope":
        validate_scope_changes(body["changes"])
        if body["confirmed"] is not True:
            raise ValueError("Warehouse scope confirmation is required")
    if "schema_digest" in body and not _digest(body["schema_digest"]):
        raise ValueError("Semantica modeling schema digest is invalid")
    if operation in {"preview_modeling_impact", "validate_modeling_impact"}:
        _impact(body, validate=operation == "validate_modeling_impact")
    if operation == "execute_modeling_rules":
        if not _choice(body["mode"], {"publish_only", "current", "selected"}):
            raise ValueError("Semantica rule execution mode is invalid")
        _impact(body["preview"], validate=True)
    if "decisions" in body:
        if not isinstance(body["decisions"], list) or len(body["decisions"]) > 12:
            raise ValueError("Semantica rule decisions are invalid")
        for decision in body["decisions"]:
            _fields(decision, {"suggestion_id", "action"}, {"target_name", "owner_kind", "owner_name"})
            if (not _text(decision["suggestion_id"]) or not _choice(decision["action"], {"add", "reuse", "ignore"})
                    or not _text(decision.get("target_name", ""), 0, 64)
                    or not _text(decision.get("owner_name", ""), 0, 64)
                    or not _choice(decision.get("owner_kind", ""), {"", "entity", "relation"})):
                raise ValueError("Semantica rule decision is invalid")
    if operation in {"check_processing", "save_processing"}:
        if body.get("warehouse_id") is not None and (not isinstance(body["warehouse_id"], str)
                or re.fullmatch(UUID, body["warehouse_id"]) is None):
            raise ValueError("Semantica warehouse reference is invalid")
        if not _choice(body.get("mode", "manual"), {"manual", "automatic"}):
            raise ValueError("Semantica processing mode is invalid")
        for name in ("inherit", "sensitive_follow"):
            if name in body and type(body[name]) is not bool:
                raise ValueError("Semantica processing choice is invalid")
        for name in ("extraction", "sensitive"):
            if name == "extraction" and name in body and not _text(body[name], 0, 300):
                raise ValueError("Semantica model selection is invalid")
            if name in body and body[name] is not None and not _text(body[name], 0, 300):
                raise ValueError("Semantica model selection is invalid")
        if "inference_options" in body:
            _fields(body["inference_options"], (), {"thinking_mode"})
            if not _choice(body["inference_options"].get("thinking_mode", "auto"), {"auto", "on", "off"}):
                raise ValueError("Semantica inference option is invalid")
        if "cloud_confirmations" in body and (not isinstance(body["cloud_confirmations"], list)
                or len(body["cloud_confirmations"]) > 2
                or any(not _text(model, 1, 300) for model in body["cloud_confirmations"])):
            raise ValueError("Semantica cloud confirmation is invalid")
    return body.get("operation_id")


def resource_ids(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, str]:
    """References only; callers still enforce real owner/parent relationships."""
    validate_body(method, path, body)
    result = {key: value for key, value in _match(method, path)[0].groupdict().items() if value is not None}
    for name in ("warehouse_id", "confirmation_id", "base_ontology_id", "proposal_id", "expected_draft_id", "expected_confirmation_id"):
        if body and isinstance(body.get(name), str):
            result[name] = body[name]
    return result
