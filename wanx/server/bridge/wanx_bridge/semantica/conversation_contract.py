"""Finite contracts for STARLINK's dialogue, rule review and material review pages."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import Field, model_validator

from . import (
    conversation_responses,
    dialogue_round_contract,
    ontology_edit_contract,
    instruction_contract,
    material_processing_contract,
    source_preparation_contract,
)
from .desktop_workbench import SCOPE_FIELDS
from .modeling_contract import Operation, Revision, StrictBody, openapi_extra

ID = r"[A-Za-z0-9_-]{1,128}"
PREFIX = "/warehouses/{warehouse_id}"
C = "/workbench/conversations"
ONE = C + "/{conversation_id}"
INTENT = ONE + "/intents/{intent_id}"
TURN = ONE + "/turns/{turn_id}"
M = "/modeling"
PAGE = {"offset": (0, 9007199254740991), "limit": (1, 50)}
ERROR_CODES = frozenset(
    {
        "MODELING_ONTOLOGY_EDIT_STALE",
        "MODELING_ONTOLOGY_EDIT_BUSY",
        "MODELING_ONTOLOGY_EDIT_TIMEOUT",
        "MODELING_ONTOLOGY_EDIT_INVALID_OUTPUT",
        "MODELING_ONTOLOGY_EDIT_MODEL_FAILED",
        "MODELING_SCENARIO_MISMATCH",
        "MODELING_ONBOARDING_STALE",
        "MODELING_ONBOARDING_BUSY",
        "MODELING_ONBOARDING_NOT_READY",
        "MODELING_ONBOARDING_TIMEOUT",
        "MODELING_ONBOARDING_INVALID_OUTPUT",
        "MODELING_ONBOARDING_MODEL_FAILED",
        "MODELING_ONBOARDING_ALREADY_STARTED",
        "MODELING_ONBOARDING_QUESTION_STALE",
        "MODELING_CHANGE_BUSY",
        "MODELING_CHANGE_STALE",
        "MODELING_CHANGE_INVALID",
        "MODELING_CHANGE_CONTEXT_TOO_LARGE",
        "MODELING_CHANGE_INVALID_OUTPUT",
        "MODELING_CHANGE_MODEL_FAILED",
        "MODELING_CHANGE_TIMEOUT",
        "LLM_NOT_CONFIGURED",
        "MODELING_ATTACHMENT_LIMIT",
        "MODELING_CANDIDATES_NOT_READY",
        "MODELING_CONFIRMATION_REQUIRED",
        "MODELING_CONVERSATION_CLOSED",
        "MODELING_CONTEXT_BUDGET",
        "MODELING_EXECUTION_NOT_FOUND",
        "MODELING_EXECUTION_STOPPED",
        "MODELING_EXPLICIT_SELECTION_REQUIRED",
        "MODELING_GOAL_CHANGED",
        "MODELING_IMPACT_STALE",
        "MODELING_INTENT_BOUND",
        "MODELING_MATERIAL_BUSY",
        "MODELING_MESSAGE_LIMIT",
        "MODELING_MODEL_CHANGED",
        "MODELING_ONTOLOGY_CHANGED",
        "MODELING_ONTOLOGY_REQUIRED",
        "MODELING_OPERATION_EXPIRED",
        "MODELING_PLAN_CHANGED",
        "MODELING_PLAN_NOT_READY",
        "MODELING_PROMPT_CHANGED",
        "MODELING_RETRY_UNAVAILABLE",
        "MODELING_REVIEW_ALREADY_MERGED",
        "MODELING_REVIEW_BASE_CHANGED",
        "MODELING_REVIEW_DECISION_REQUIRED",
        "MODELING_REVIEW_ONTOLOGY_MISMATCH",
        "MODELING_REVIEW_PLAN_CHANGED",
        "MODELING_RULE_ALREADY_PUBLISHED",
        "MODELING_RULE_CONFIRMATION_REQUIRED",
        "MODELING_RULE_DECISION_INVALID",
        "MODELING_RULE_DECISIONS_REQUIRED",
        "MODELING_RULE_DIGEST_CHANGED",
        "MODELING_RULE_DRAFT_CHANGED",
        "MODELING_RULE_SOURCE_STALE",
        "MODELING_RULE_CLARIFICATION_REQUIRED",
        "MODELING_RULE_TARGET_CHANGED",
        "MODELING_SOURCE_CHANGED",
        "MODELING_SOURCE_NOT_READY",
        "MODELING_TURN_BUSY",
        "MODELING_TURN_CLOSED",
        "MODELING_TURN_NOT_FOUND",
        "MODELING_TURN_RETRY_UNAVAILABLE",
    }
)


class NativeOperation(Operation):
    native_operation: str = Field(
        alias="_native_operation_id", min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_-]+$"
    )


class NativeRevision(NativeOperation, Revision):
    pass


class CreateConversation(NativeOperation):
    scenario: Literal["material", "onboarding", "change"] = "material"


class OnboardingStart(NativeRevision):
    expected_revision: int = Field(ge=0, le=9007199254740991)
    draft_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class OnboardingQuestionAction(StrictBody):
    question_id: str = Field(min_length=1, max_length=64)
    action: Literal["answer", "skip", "uncertain"]
    answer: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def validate_answer(self):
        if not self.question_id.strip() or (self.action == "answer" and not self.answer.strip()):
            raise ValueError("Question and answer must be nonblank")
        if self.action != "answer" and self.answer != "":
            raise ValueError("Skipped or uncertain questions cannot carry answers")
        return self


class OnboardingTurn(OnboardingStart):
    content: str = Field(default="", max_length=8000)
    question_actions: list[OnboardingQuestionAction] = Field(default_factory=list, max_length=2)

    @model_validator(mode="after")
    def validate_turn(self):
        ids = [q.question_id for q in self.question_actions]
        if len(ids) != len(set(ids)) or (not self.content.strip() and not ids):
            raise ValueError("Provide text or distinct question actions")
        if len(self.content) + sum(len(q.answer) for q in self.question_actions) > 8000:
            raise ValueError("Combined answer exceeds budget")
        return self


class OnboardingPreview(OnboardingStart):
    name: str = Field(default="建仓对话本体", min_length=1, max_length=120)

    @model_validator(mode="after")
    def nonblank_name(self):
        if not self.name.strip():
            raise ValueError("Onboarding ontology name must be nonblank")
        return self


class OnboardingPublish(NativeOperation):
    preview_id: str = Field(min_length=1, max_length=120)
    preview_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirmed: bool

    @model_validator(mode="after")
    def explicit_confirmation(self):
        if self.confirmed is not True:
            raise ValueError("Publication requires explicit confirmation")
        return self


class OntologyEditInitialize(NativeOperation):
    base_ontology_id: str = Field(min_length=1, max_length=120)
    ontology_draft_id: str | None = Field(default=None, min_length=1, max_length=120)
    name: str = Field(default="本体编辑草稿", min_length=1, max_length=120)


class OntologySelection(StrictBody):
    kind: Literal["entity", "relation", "property"]
    type_kind: Literal["entity", "relation"]
    type_name: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$")
    property_name: str | None = Field(default=None, pattern=r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


class OntologyEditTurn(OnboardingStart):
    instruction: str = Field(min_length=1, max_length=8000)
    selected: list[OntologySelection] = Field(default_factory=list, max_length=20)


class OntologyEditSave(OnboardingStart):
    name: str = Field(min_length=1, max_length=120)
    schema_definition: dict = Field(alias="schema")


class OntologyEditPreview(OnboardingStart):
    document_ids: list[str] | None = Field(default=None, min_length=1, max_length=20)
    offset: int = Field(default=0, ge=0, le=9007199254740991)
    limit: int = Field(default=20, ge=1, le=20)


class OntologyEditExecute(OnboardingPublish):
    mode: Literal["publish_only", "current", "selected"]


class SendMessage(NativeRevision):
    content: str = Field(min_length=1, max_length=8000)


class CreateIntent(NativeRevision):
    document_id: str | None = Field(default=None, min_length=1, max_length=120)


class Analyze(NativeOperation):
    document_version_id: str = Field(min_length=1, max_length=120)


class Goal(NativeRevision):
    expected_conversation_revision: int = Field(ge=1)
    goal: str = Field(min_length=1, max_length=8000)
    instructions: str = Field(default="", max_length=8000)
    confirmed: bool


class ConfirmPlan(NativeRevision):
    expected_conversation_revision: int = Field(ge=1)
    plan_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirmed: bool


class Editor(StrictBody):
    session: str = Field(pattern=r"^[A-Za-z0-9_-]{20,200}$")
    generation: str = Field(pattern=r"^[0-9]{1,12}$")


class ReviewPlan(StrictBody):
    native_operation: str = Field(
        alias="_native_operation_id", min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_-]+$"
    )
    editor: Editor = Field(alias="_native_editor")


class ChangeRead(StrictBody):
    native_operation: str = Field(
        alias="_native_operation_id", min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_-]+$"
    )
    editor: Editor | None = Field(default=None, alias="_native_editor")


class ChangeSelection(ChangeRead):
    draft_id: str | None = Field(default=None, min_length=1, max_length=120)
    ontology_draft_id: str | None = Field(default=None, min_length=1, max_length=120)
    selected_item_ids: list[str] = Field(default_factory=list, max_length=20)
    allowed_scopes: list[Literal["rules", "goal", "facts"]] | None = Field(default=None, min_length=1, max_length=3)


class ChangeContext(ChangeSelection):
    proposal_offset: int = Field(default=0, ge=0, le=9007199254740991)


class GenerateChange(ChangeSelection, NativeOperation):
    context_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    instruction: str = Field(min_length=1, max_length=4000)


class ApplyChange(ChangeRead, NativeOperation):
    proposal_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirmed: bool


class MergeReview(NativeRevision):
    editor: Editor = Field(alias="_native_editor")
    plan_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    draft_id: str | None = Field(default=None, min_length=1, max_length=120)
    confirmed: bool
    deferred_policy: Literal["keep_existing"] | None = None


class RuleDecision(StrictBody):
    suggestion_id: str = Field(min_length=1, max_length=120)
    action: Literal["add", "reuse", "ignore"]
    target_name: str = Field(default="", max_length=64)
    owner_kind: Literal["", "entity", "relation"] = ""
    owner_name: str = Field(default="", max_length=64)


class PrepareRules(Operation):
    proposal_id: str = Field(min_length=1, max_length=120)
    expected_draft_id: str | None = Field(default=None, min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=120)
    schema_definition: dict = Field(alias="schema")
    decisions: list[RuleDecision] = Field(max_length=12)


class PublishRules(Operation):
    schema_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirmed: bool


class Impact(StrictBody):
    base_ontology_id: str = Field(min_length=1, max_length=120)
    schema_definition: dict | None = Field(default=None, alias="schema")
    ontology_draft_id: str | None = Field(default=None, min_length=1, max_length=120)
    rule_draft_id: str | None = Field(default=None, min_length=1, max_length=120)
    document_ids: list[str] | None = Field(default=None, min_length=1, max_length=20)
    offset: int = Field(default=0, ge=0, le=9007199254740991)
    limit: int = Field(default=20, ge=1, le=20)


class ValidateImpact(Impact):
    preview_token: str = Field(pattern=r"^[0-9a-f]{64}$")


class ExecuteRules(Operation):
    confirmed: bool
    mode: Literal["publish_only", "current", "selected"]
    name: str = Field(min_length=1, max_length=120)
    preview: ValidateImpact


class RetryRules(Operation):
    confirmed: bool


# Explicit routes, request schemas and bounded query parameters. No wildcard registration.
ERROR_CODES = ERROR_CODES | ontology_edit_contract.ERROR_CODES | dialogue_round_contract.ERROR_CODES | material_processing_contract.ERROR_CODES | source_preparation_contract.ERROR_CODES | instruction_contract.ERROR_CODES

ROUTES = [
    *ontology_edit_contract.ROUTES,
    *instruction_contract.ROUTES,
    *dialogue_round_contract.ROUTES,
    *material_processing_contract.ROUTES,
    *source_preparation_contract.ROUTES,
    ("GET", C + "/materials", "List warehouse material workflows", None, PAGE),
    ("GET", C + "/materials/{document_id}", "Read material workflow and actions", None, {}),
    ("GET", ONE + "/ontology-edit", "Read shared ontology editing draft and history", None, PAGE),
    (
        "POST",
        ONE + "/ontology-edit/initialize",
        "Bind an ontology editing conversation to a version or draft",
        OntologyEditInitialize,
        {},
    ),
    (
        "POST",
        ONE + "/ontology-edit/draft",
        "Save manual changes to the shared ontology draft",
        OntologyEditSave,
        {},
    ),
    (
        "POST",
        ONE + "/ontology-edit/turns",
        "Generate validated ontology patches from conversation",
        OntologyEditTurn,
        {},
    ),
    ("GET", ONE + "/ontology-edit/turns/{turn_id}", "Recover an ontology editing turn", None, {}),
    (
        "POST",
        ONE + "/ontology-edit/preview",
        "Preview ontology and material impact bound to draft version",
        OntologyEditPreview,
        {},
    ),
    (
        "POST",
        ONE + "/ontology-edit/execute",
        "Confirm publication and optionally process selected materials",
        OntologyEditExecute,
        {},
    ),
    ("GET", ONE + "/onboarding", "Read warehouse onboarding scope and round history", None, PAGE),
    (
        "POST",
        ONE + "/onboarding/start",
        "Generate adaptive opening guidance from warehouse purpose",
        OnboardingStart,
        {},
    ),
    (
        "POST",
        ONE + "/onboarding/turns",
        "Generate and save a private document-free scope draft",
        OnboardingTurn,
        {},
    ),
    (
        "GET",
        ONE + "/onboarding/turns/{turn_id}",
        "Recover an onboarding round without regeneration",
        None,
        {},
    ),
    (
        "POST",
        ONE + "/onboarding/preview",
        "Bind a publication preview to the onboarding draft",
        OnboardingPreview,
        {},
    ),
    (
        "POST",
        ONE + "/onboarding/publish",
        "Explicitly publish the reviewed onboarding scope and ontology",
        OnboardingPublish,
        {},
    ),
    ("POST", INTENT + "/change-context", "Read the single-page change context", ChangeContext, {}),
    (
        "POST",
        INTENT + "/change-proposals",
        "Generate a private conversational change proposal",
        GenerateChange,
        {},
    ),
    (
        "POST",
        INTENT + "/change-proposals/{proposal_id}/read",
        "Recover a private change proposal",
        ChangeRead,
        {},
    ),
    (
        "POST",
        INTENT + "/change-proposals/{proposal_id}/apply",
        "Apply confirmed changes to drafts only",
        ApplyChange,
        {},
    ),
    ("POST", C, "Create a material conversation", CreateConversation, {}),
    ("GET", C, "List personal warehouse conversations", None, PAGE),
    (
        "GET",
        ONE,
        "Read conversation revisions and material progress",
        None,
        {"intent_offset": PAGE["offset"]},
    ),
    (
        "GET",
        ONE + "/messages",
        "Read incremental conversation messages",
        None,
        {"after_sequence": PAGE["offset"], "limit": (1, 100)},
    ),
    (
        "POST",
        ONE + "/messages",
        "Submit a dialogue turn without executing changes",
        SendMessage,
        {},
    ),
    ("GET", ONE + "/turns", "Recover dialogue turns", None, PAGE),
    ("GET", TURN, "Poll a dialogue turn", None, {}),
    ("POST", TURN + "/cancel", "Cancel a dialogue turn", NativeRevision, {}),
    ("POST", TURN + "/retry", "Retry a failed dialogue turn", NativeRevision, {}),
    ("GET", ONE + "/intents", "List material intents", None, PAGE),
    (
        "POST",
        ONE + "/intents",
        "Reserve an attachment or link an existing material",
        CreateIntent,
        {},
    ),
    ("GET", INTENT, "Read material goal and extraction outcome", None, {}),
    (
        "POST",
        INTENT + "/analyze",
        "Request preliminary reading of the parsed attachment",
        Analyze,
        {},
    ),
    ("POST", INTENT + "/goal", "Confirm the current material goal", Goal, {}),
    (
        "POST",
        INTENT + "/cancel",
        "Cancel a material intent without deleting its document",
        NativeRevision,
        {},
    ),
    ("GET", INTENT + "/plan", "Preview the extraction plan", None, {}),
    ("POST", INTENT + "/confirm", "Confirm and enqueue reviewed extraction", ConfirmPlan, {}),
    ("GET", INTENT + "/candidates", "Read private extraction candidates", None, PAGE),
    ("POST", INTENT + "/retry", "Retry failed material extraction", NativeRevision, {}),
    (
        "POST",
        INTENT + "/review-plan",
        "Read the merge plan with editor credentials",
        ReviewPlan,
        {**PAGE, "draft_id": None},
    ),
    (
        "POST",
        INTENT + "/review",
        "Merge candidates into an unpublished review draft",
        MergeReview,
        {},
    ),
    (
        "GET",
        M + "/answer-suggestions/{suggestion_id}/rules",
        "Read initial suggestions and the saved rule draft",
        None,
        {},
    ),
    (
        "POST",
        M + "/rule-previews",
        "Save reviewed rule decisions and the full schema",
        PrepareRules,
        {},
    ),
    (
        "POST",
        M + "/rule-previews/{preview_id}/publish",
        "Confirm publication of the reviewed rule schema",
        PublishRules,
        {},
    ),
    ("POST", M + "/impact-preview", "Preview rule impact on selected materials", Impact, {}),
    (
        "POST",
        M + "/impact-preview/validate",
        "Revalidate the rule and material snapshot",
        ValidateImpact,
        {},
    ),
    (
        "POST",
        M + "/rule-executions",
        "Publish rules and optionally process selected materials",
        ExecuteRules,
        {},
    ),
    (
        "GET",
        M + "/rule-executions/{execution_id}",
        "Read rule publication and material submission receipts",
        None,
        {},
    ),
    (
        "POST",
        M + "/rule-executions/{execution_id}/retry",
        "Retry failed submissions from a confirmed rule change",
        RetryRules,
        {},
    ),
]


def entry(method, path):
    return next(
        (
            row
            for row in ROUTES
            if row[0] == method and re.fullmatch(re.sub(r"\{[^}]+\}", lambda _: ID, row[1]), path)
        ),
        None,
    )


def matches(path):
    return any(re.fullmatch(re.sub(r"\{[^}]+\}", lambda _: ID, row[1]), path) for row in ROUTES)


def prepare(method, path, body, query):
    row = entry(method, path)
    if row is None:
        raise ValueError("Unsupported operation")
    pending = [body, query]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            if SCOPE_FIELDS.intersection(item):
                raise PermissionError("Scope is supplied by WANX")
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    for key, value in query.items():
        if key not in row[4] or not isinstance(value, str):
            raise ValueError("Unexpected query")
        bounds = row[4][key]
        if bounds is None:
            if not re.fullmatch(ID, value):
                raise ValueError("Invalid draft ID")
        elif not re.fullmatch(r"[0-9]{1,16}", value) or not bounds[0] <= int(value) <= bounds[1]:
            raise ValueError("Invalid pagination")
    if method == "GET":
        if body is not None:
            raise ValueError("Unexpected body")
        return None, None
    parsed = row[3].model_validate(body)
    operation = getattr(parsed, "operation_id", None)
    if path.startswith(C) or path.startswith("/workbench/documents/"):
        native = parsed.native_operation
        if operation is not None and operation != native:
            raise ValueError("Mismatched operation identity")
        operation = native
    # Impact previews are read-only POSTs and intentionally have no write operation.
    return dict(body), operation


def schema_extra(method, suffix, model, query):
    route = PREFIX + suffix
    extra = openapi_extra(route, model)
    extra["parameters"].extend(
        {
            "in": "query",
            "name": key,
            "required": False,
            "schema": {"type": "string", "pattern": "^" + ID + "$"}
            if bounds is None
            else {"type": "integer", "minimum": bounds[0], "maximum": bounds[1]},
        }
        for key, bounds in query.items()
    )

    def content(response):
        # Reuse the existing $defs inliner; these schemas document the wire only.
        return openapi_extra("", response)["requestBody"]["content"]

    extra["responses"] = {
        str(success_status(method, suffix)): {
            "description": "Business receipt; inspect status before progressing or publishing.",
            "content": content(conversation_responses.response_model(method, suffix)),
        },
        **{
            str(status): {
                "description": "Safe error code; original upstream diagnostics are omitted.",
                "content": content(conversation_responses.Error),
            }
            for status in (401, 403, 404, 409, 413, 422, 429, 503, 504)
        },
    }
    return extra


def success_status(method, path):
    if method == 'POST' and path == dialogue_round_contract.BASE:
        return 201
    if (method, path) in source_preparation_contract.RESPONSES:
        return 202
    if method == "POST" and path == material_processing_contract.MATERIAL + "/processing-transitions":
        return 202
    if method == "POST" and path.startswith(C):
        if path in {C, ONE + "/intents"}:
            return 201
        if path.endswith(("/messages", "/analyze", "/confirm", "/retry")):
            return 202
    return 200
