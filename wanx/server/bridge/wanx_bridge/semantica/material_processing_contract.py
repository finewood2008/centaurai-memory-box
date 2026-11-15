"""Finite material processing transitions; the warehouse comes from WANX grants."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .modeling_contract import Operation, StrictBody

MATERIAL = "/workbench/conversations/materials/{document_id}"
ERROR_CODES = frozenset(
    {
        "MATERIAL_PROCESSING_PREVIEW_STALE",
        "MATERIAL_PROCESSING_ACK_REQUIRED",
        "SOURCE_CONFIRMATION_REQUIRED",
        "MATERIAL_PROCESSING_PREVIEW_EXPIRED",
        "MATERIAL_PROCESSING_PREVIEW_CONSUMED",
        "MATERIAL_PROCESSING_OPERATION_CONFLICT",
        "MATERIAL_PROCESSING_GENERATION_STALE",
        "MATERIAL_REVIEW_REQUIRED",
        "MATERIAL_SOURCE_NOT_READY",
    }
)


class NativeOperation(Operation):
    operation_id: str = Field(min_length=1, max_length=120, pattern=r"\S")
    native_operation: str = Field(
        alias="_native_operation_id",
        min_length=1,
        max_length=120,
        pattern=r"^[A-Za-z0-9_-]+$",
    )


class DialogueContext(StrictBody):
    conversation_id: str = Field(min_length=1, max_length=120)
    intent_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=1)
    expected_conversation_revision: int = Field(ge=1)


class ProcessingPreview(NativeOperation):
    target_mode: Literal["automatic", "dialogue"]
    expected_document_version_id: str = Field(min_length=1, max_length=120)
    expected_workflow_revision: int = Field(ge=1)
    dialogue_context: DialogueContext | None = None

    @model_validator(mode="after")
    def check_context(self):
        if self.target_mode == "dialogue" and self.dialogue_context is None:
            raise ValueError("Dialogue context required")
        if (
            self.target_mode == "automatic"
            and "dialogue_context" in self.model_fields_set
        ):
            raise ValueError("Automatic processing has no dialogue context")
        return self


class ProcessingConfirm(NativeOperation):
    preview_id: str = Field(min_length=1, max_length=120)
    preview_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_workflow_revision: int = Field(ge=1)
    confirmed: Literal[True]
    replacement_acknowledgement: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class Wire(BaseModel):
    model_config = ConfigDict(extra="allow")


class Replacement(Wire):
    draft_count: int = Field(ge=0)
    modified_draft_count: int = Field(ge=0)
    candidate_result_count: int = Field(ge=0)
    modified_candidate_result_count: int = Field(ge=0)
    replaces_manual_publication: bool
    requires_acknowledgement: bool
    preserves_history: Literal[True]
    description: str
    acknowledgement_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class Snapshot(Wire):
    document_version_id: str
    ontology_id: str | None
    baseline_run_id: str | None
    configuration_digest: str | None
    thinking_mode: Literal["auto", "on", "off"] | None
    dialogue_context: DialogueContext | None


class PreviewResponse(Wire):
    contract_version: str
    replacement: Replacement | None = None
    preview_id: str
    operation_id: str
    document_id: str
    workspace_id: str
    from_mode: Literal["automatic", "dialogue"]
    target_mode: Literal["automatic", "dialogue"]
    workflow_revision: int
    preview_digest: str
    expires_at: str
    can_confirm: bool
    blockers: list[dict]
    snapshot: Snapshot
    publication_policy: Literal["automatic", "review_required"]
    effects: dict
    reused: bool


class Receipt(Wire):
    replacement: Replacement | None = None
    transition_id: str
    operation_id: str
    preview_id: str
    document_id: str
    workspace_id: str
    from_mode: Literal["automatic", "dialogue"]
    target_mode: Literal["automatic", "dialogue"]
    workflow_revision: int
    document_version_id: str
    ontology_id: str
    publication_policy: Literal["automatic", "review_required"]
    configuration_digest: str
    thinking_mode: Literal["auto", "on", "off"]
    job_id: str
    run_id: str | None
    execution_id: str | None
    conversation_id: str | None
    intent_id: str | None
    result_reused: bool
    publication_performed: Literal[False]
    accepted_at: str


class Current(Wire):
    stage: Literal[
        "queued",
        "running",
        "awaiting_review",
        "publishing",
        "published",
        "failed",
        "cancelled",
        "stale",
    ]
    job_status: Literal["queued", "running", "succeeded", "failed", "cancelled"] | None
    active_workflow_revision: int
    is_current: bool
    publication_performed: bool
    published_run_id: str | None
    error: dict | None


class ConfirmResponse(Wire):
    receipt: Receipt
    reused: bool


class TransitionResponse(Wire):
    receipt: Receipt
    current: Current


ROUTES = [
    (
        "POST",
        MATERIAL + "/processing-previews",
        "Preview material processing mode",
        ProcessingPreview,
        {},
    ),
    (
        "POST",
        MATERIAL + "/processing-transitions",
        "Confirm material processing and enqueue",
        ProcessingConfirm,
        {},
    ),
    (
        "GET",
        MATERIAL + "/processing-transitions/{transition_id}",
        "Recover material processing operation",
        None,
        {},
    ),
]
RESPONSES = {
    (method, path): response
    for (method, path, *_), response in zip(
        ROUTES, (PreviewResponse, ConfirmResponse, TransitionResponse)
    )
}
EXAMPLES = {
    ProcessingPreview: {
        "operation_id": "preview",
        "_native_operation_id": "preview",
        "target_mode": "automatic",
        "expected_document_version_id": "version",
        "expected_workflow_revision": 1,
    },
    ProcessingConfirm: {
        "operation_id": "confirm",
        "_native_operation_id": "confirm",
        "preview_id": "preview",
        "preview_digest": "a" * 64,
        "expected_workflow_revision": 1,
        "confirmed": True,
    },
}
