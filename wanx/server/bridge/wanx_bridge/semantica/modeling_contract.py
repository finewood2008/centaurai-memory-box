"""Finite personal onboarding contract for the first three STARLINK screens."""

from __future__ import annotations

import base64
import json
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from .desktop_workbench import SCOPE_FIELDS

ID = r"[A-Za-z0-9_-]{1,128}"
ROOT_RULES = [
    ("GET", r"/modeling/onboarding", frozenset()),
    ("POST", r"/modeling/onboarding", frozenset()),
    ("GET", r"/modeling/warehouses", frozenset()),
    ("POST", rf"/modeling/onboarding/{ID}/warehouse", frozenset()),
]
WAREHOUSE_RULES = [
    ("POST", r"/modeling/assistant-intent", frozenset()),
    ("GET", r"/modeling/suggestion-context", frozenset()),
    ("POST", r"/modeling/warehouse-scope/publish", frozenset()),
    ("POST", r"/modeling/answer-confirmations", frozenset()),
    ("POST", r"/modeling/answer-suggestions", frozenset()),
    ("GET", rf"/modeling/answer-suggestions/{ID}", frozenset()),
]
ERROR_CODES = frozenset(
    {
        "MODELING_CONFLICT",
        "MODELING_INVALID_REQUEST",
        "MODELING_ORIGIN_DENIED",
        "MODELING_REQUEST_TOO_LARGE",
        "MODELING_OWNER_REQUIRED",
        "MODELING_RESOURCE_NOT_FOUND",
        "MODELING_OPERATION_CONFLICT",
        "MODELING_REVISION_CHANGED",
        "MODELING_WAREHOUSE_LIMIT",
        "MODELING_HOST_CREATION_REQUIRED",
        "MODELING_WORKSPACE_BUSY",
        "MODELING_ANSWERS_EMPTY",
        "MODELING_ANSWERS_STALE",
        "MODELING_SUGGESTION_STALE",
        "MODELING_SUGGESTION_BUSY",
        "MODELING_SUGGESTION_TIMEOUT",
        "MODELING_SUGGESTION_FAILED",
        "MODELING_INTENT_INVALID",
        "MODELING_INTENT_UNAVAILABLE",
        "MODELING_INTENT_DEPENDENCY_MISSING",
        "MODELING_INTENT_TIMEOUT",
    }
)


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ConfirmedAnswers(StrictBody):
    industry: str = Field(default="", max_length=200)
    occupation: str = Field(default="", max_length=200)
    background: str = Field(default="", max_length=8000)
    purpose: str = Field(default="", max_length=16000)
    material_types: str = Field(default="", max_length=8000)
    questions: str = Field(default="", max_length=8000)


class Answers(ConfirmedAnswers):
    warehouse_name: str = Field(default="", max_length=60)
    flow_step: Literal["", "background", "purpose", "confirm"] = ""
    flow_mode: Literal["", "create", "profile"] = ""
    background_sample: str = Field(default="", max_length=60)
    purpose_sample: str = Field(default="", max_length=60)
    creation_operation: str = Field(default="", max_length=120, pattern=r"^[A-Za-z0-9_-]*$")


class Operation(StrictBody):
    operation_id: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_-]+$")


class Revision(Operation):
    expected_revision: int = Field(ge=0)


class SaveOnboarding(Revision):
    answers: Answers
    status: Literal["in_progress", "skipped", "completed"] = "in_progress"


ScopeObject = Annotated[str, Field(min_length=1, max_length=300, pattern=r"\S")]


class CreationProfile(StrictBody):
    occupation: str = Field(default="", max_length=200)
    service_objects: list[ScopeObject] = Field(default_factory=list, max_length=6)
    focus_objects: list[ScopeObject] = Field(default_factory=list, max_length=6)


class WarehouseScope(CreationProfile):
    industry: str = Field(
        default="", max_length=200, description="Warehouse industry/business domain"
    )
    occupation: str = Field(
        default="", max_length=200, description="Warehouse business role; not access control"
    )
    background: str = Field(
        default="", max_length=8000, description="Warehouse business background"
    )
    material_types: str = Field(default="", max_length=8000)
    questions: str = Field(default="", max_length=8000)


class CreateWarehouse(Revision):
    name: str = Field(min_length=1, max_length=60)
    purpose: str = Field(default="", max_length=16000)
    warehouse_scope: WarehouseScope | None = None


class PublishWarehouseScope(Revision):
    base_ontology_id: str = Field(min_length=1, max_length=120)
    changes: dict
    confirmed: Literal[True]


class ConfirmAnswers(Revision):
    onboarding_revision: int = Field(ge=0)
    expected_confirmation_id: str | None = Field(default=None, min_length=1, max_length=120)
    answers: ConfirmedAnswers


class GenerateSuggestions(Operation):
    confirmation_id: str = Field(min_length=1, max_length=120)
    base_ontology_id: str = Field(min_length=1, max_length=120)


class AssistantIntent(Operation):
    version: Literal[2]
    text: str = Field(min_length=1, max_length=2000)
    page: str = Field(min_length=1, max_length=40)
    context: dict
    history: list[dict] = Field(max_length=4)
    ontology_conversation: bool


def body_model(path: str) -> type[BaseModel]:
    if path == '/modeling/assistant-intent':
        return AssistantIntent
    if path == "/modeling/onboarding":
        return SaveOnboarding
    if re.fullmatch(rf"/modeling/onboarding/{ID}/warehouse", path):
        return CreateWarehouse
    if path == "/modeling/warehouse-scope/publish":
        return PublishWarehouseScope
    if path == "/modeling/answer-confirmations":
        return ConfirmAnswers
    if path == "/modeling/answer-suggestions":
        return GenerateSuggestions
    raise ValueError("Unknown modeling operation")


def prepare(method, path, body, query):
    pending = [body, query]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if SCOPE_FIELDS.intersection(value):
                raise PermissionError("Scope is supplied by WANX")
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    if query or (method == "GET" and body is not None):
        raise ValueError("Unexpected query or body")
    if method == "GET":
        return None, None
    parsed = body_model(path).model_validate(body)
    if isinstance(parsed, AssistantIntent):
        from centuarai_local_data_gate.starxiaotu_intent import validate_request
        validate_request(body)
    # Do not fill omitted optional fields: the owner stores request digests.
    if isinstance(parsed, PublishWarehouseScope):
        from centuarai_local_data_gate.semantica_bootstrap import validate_scope_changes

        validate_scope_changes(parsed.changes)
        if body["confirmed"] is not True:
            raise ValueError("Warehouse scope confirmation is required")
    return dict(body), parsed.operation_id


def upstream_path(path: str, headers: dict[str, str]) -> str:
    if any(re.fullmatch(pattern, path) for _, pattern, _ in ROOT_RULES):
        return path
    encoded = headers["x-semantica-scope"]
    claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    return "/modeling/warehouses/" + claims["workspace_id"] + path.removeprefix("/modeling")


# Explicit OpenAPI entries, sharing the authenticated desktop handler.
API_ROUTES = [
    ('POST', '/warehouses/{warehouse_id}/modeling/assistant-intent', 'Classify a bounded assistant request without executing it', AssistantIntent),
    ("GET", "/modeling/onboarding", "Read the current user's onboarding answers", None),
    (
        "POST",
        "/modeling/onboarding",
        "Save onboarding answers with revision checks",
        SaveOnboarding,
    ),
    ("GET", "/modeling/warehouses", "List the current user's knowledge warehouses", None),
    (
        "POST",
        "/modeling/onboarding/{onboarding_id}/warehouse",
        "Create a personal warehouse after confirmation",
        CreateWarehouse,
    ),
    (
        "GET",
        "/warehouses/{warehouse_id}/modeling/suggestion-context",
        "Read the selected warehouse's initial suggestion context",
        None,
    ),
    (
        "POST",
        "/warehouses/{warehouse_id}/modeling/warehouse-scope/publish",
        "Confirm and save warehouse business scope",
        PublishWarehouseScope,
    ),
    (
        "POST",
        "/warehouses/{warehouse_id}/modeling/answer-confirmations",
        "Confirm answers for an initial structure suggestion",
        ConfirmAnswers,
    ),
    (
        "POST",
        "/warehouses/{warehouse_id}/modeling/answer-suggestions",
        "Generate an initial structure suggestion without publishing",
        GenerateSuggestions,
    ),
    (
        "GET",
        "/warehouses/{warehouse_id}/modeling/answer-suggestions/{suggestion_id}",
        "Read an initial structure suggestion receipt",
        None,
    ),
]


def openapi_extra(path: str, model: type[BaseModel] | None) -> dict:
    extra = {
        "parameters": [
            {"in": "path", "name": name, "required": True, "schema": {"type": "string"}}
            for name in re.findall(r"\{([^}]+)\}", path)
        ]
    }
    if model is not None:
        schema = model.model_json_schema()
        definitions = schema.pop("$defs", {})

        def inline(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    return inline(definitions[value["$ref"].split("/")[-1]])
                return {key: inline(item) for key, item in value.items()}
            if isinstance(value, list):
                return [inline(item) for item in value]
            return value

        extra["requestBody"] = {
            "required": True,
            "content": {"application/json": {"schema": inline(schema)}},
        }
    return extra
