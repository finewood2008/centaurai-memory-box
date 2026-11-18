"""Document wire responses without filtering the owner's additive payload fields."""

from __future__ import annotations

from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field

from .source_preparation_contract import Preparation


class WireResponse(BaseModel):
    model_config = ConfigDict(extra="allow")


class Receipt(WireResponse):
    resource_id: str
    status: str
    operation_id: str
    reused: bool


class Conversation(WireResponse):
    id: str
    status: str
    scenario: str
    revision: int
    input_generation: int
    last_sequence: int


class ConversationCreated(Receipt):
    revision: int
    conversation: Conversation


class Intent(WireResponse):
    id: str
    revision: int
    status: str
    document_id: str | None
    document_version_id: str | None
    source_status: str


class IntentDetail(Intent):
    execution_available: bool
    goal: dict | None = None
    execution: dict | None = None
    review: dict | None = None
    outcome: dict | None = None


class TurnSummary(WireResponse):
    id: str
    status: str
    input_generation: int
    error_code: str | None


T = TypeVar("T")


class Page(WireResponse, Generic[T]):  # noqa: UP046 - shared ASGI contract tests run on Python 3.11.
    items: list[T]
    has_more: bool
    offset: int
    limit: int
    next_offset: int


class Limits(WireResponse):
    message_chars: int
    attachments: int
    model_requests: int
    sample_segments: int
    segment_chars: int
    timeout_seconds: int


class Overview(Conversation):
    intents: Page[Intent]
    active_attachment_count: int
    source_stamp: str
    latest_turn: TurnSummary | None
    limits: Limits


class Reply(WireResponse):
    answer: str
    questions: list[str] | None = None
    goal_summary: str | None = None
    ready_for_confirmation: bool | None = None
    modification_intent: dict | None = None
    coverage: list[dict] | None = None


class Turn(TurnSummary):
    is_current: bool
    requests_used: int
    content_status: str | None = None
    reply: Reply | None = None


class Message(WireResponse):
    id: str
    sequence: int
    input_generation: int
    role: Literal["user", "assistant"]
    content: str = Field(
        description="User plain text; assistant content is a JSON-encoded reply, not an object."
    )
    content_status: str | None = None


class Messages(WireResponse):
    items: list[Message]
    has_more: bool
    next_sequence: int


class TurnAccepted(Receipt):
    turn_id: str
    job_id: str | None = None
    error_code: str | None = None
    revision: int | None = None
    existing: bool | None = None


class IntentReceipt(Receipt):
    revision: int


class IntentCreated(IntentReceipt):
    conversation_revision: int


class GoalReceipt(IntentReceipt):
    context_id: str
    execution_available: bool


class Goal(WireResponse):
    goal: str
    instructions: str


class ExtractionPlan(WireResponse):
    intent_id: str
    revision: int
    conversation_revision: int
    document_id: str
    document_version_id: str
    ontology_id: str
    goal: Goal
    processing: dict
    plan_digest: str
    publication_policy: Literal["review_required"]


class ExtractionReceipt(IntentReceipt):
    execution_id: str
    job_id: str
    publication_policy: Literal["review_required"]
    result_reused: bool | None = None


class Candidate(WireResponse):
    candidate_key: str
    kind: Literal["entity", "relation"]
    payload: dict
    evidence: list[dict]


class Candidates(WireResponse):
    execution_id: str
    items: list[Candidate]
    total: int
    offset: int
    limit: int
    publication_available: Literal[False]
    review_available: Literal[True]
    empty_result: bool


class MergeCounts(WireResponse):
    add: int
    reuse: int
    defer: int


class MergeDecision(WireResponse):
    candidate_key: str
    action: Literal["add", "reuse", "defer"]
    candidate: Candidate
    target: dict | None
    existing: list[dict]
    endpoints: dict[str, str]


class MergePlan(WireResponse):
    plan_digest: str
    draft_id: str | None
    draft_revision: int
    retained_count: int
    removed_count: int
    total_items: int
    counts: MergeCounts
    publication_policy: Literal["review_required"]
    decisions: list[MergeDecision]
    total: int
    offset: int
    limit: int


class MergeReceipt(IntentReceipt):
    draft_id: str
    draft_revision: int
    lease_generation: int
    publication_policy: Literal["review_required"]


class RuleDraft(Receipt):
    unresolved_questions: list[str] | None = None
    # Lifecycle cleanup can replace the historical receipt with a tombstone.
    schema_digest: str | None = None
    schema_definition: dict | None = Field(default=None, alias="schema")
    base_schema: dict | None = None
    changes: list[dict] | None = None
    publish_operation_id: str | None = None


class RulePublication(Receipt):
    unresolved_questions: list[str] | None = None
    ontology_id: str | None = None
    version_number: int | None = None
    changed: bool | None = None


class RuleWorkbench(WireResponse):
    proposal: dict | None
    base_ontology: dict | None
    draft: RuleDraft | None
    publication: RulePublication | None


class ImpactItem(WireResponse):
    document_id: str
    document_version_id: str | None
    name: str
    certainty: Literal["certain", "possible", "unknown", "unchanged"]
    reasons: list[str]
    protected: bool
    active_task_count: int


class ImpactPreview(WireResponse):
    read_only: Literal[True]
    execution_performed: Literal[False]
    valid: Literal[True]
    preview_token: str
    base_ontology: dict
    target: dict
    changes: list[dict]
    scope: Literal["page", "selected"]
    offset: int
    limit: int
    total: int
    has_more: bool
    items: list[ImpactItem]
    counts: dict[str, int]


class RuleExecutionItem(WireResponse):
    document_id: str
    status: str
    job_id: str | None = None
    error_code: str | None = None
    retryable: bool | None = None


class RuleExecution(WireResponse):
    resource_id: str
    status: str
    operation_id: str
    reused: bool | None = None
    mode: Literal["publish_only", "current", "selected"] | None = None
    publication: dict | None = None
    items: list[RuleExecutionItem]


class Error(WireResponse):
    code: str
    message: str | None = None


class ChangeContext(WireResponse):
    context_digest: str
    conversation_revision: int
    intent_revision: int
    document_id: str
    document_version_id: str
    base_ontology_id: str
    ontology_id: str
    schema_definition: dict = Field(alias="schema")
    goal: dict
    coverage: dict
    selected_items: list[dict]
    recent_proposals: list[dict]
    proposal_has_more: bool
    proposal_next_offset: int
    publication_performed: Literal[False]


class ChangeProposal(WireResponse):
    id: str
    resource_id: str
    status: Literal[
        "generating", "prepared", "needs_clarification", "no_changes", "failed", "stale", "applied"
    ]
    context_digest: str
    can_apply: bool
    result: dict | None = None
    proposal_digest: str | None = None
    application: dict | None = None
    error_code: str | None = None
    message: str | None = None


class ChangeApplied(WireResponse):
    resource_id: str
    status: Literal["applied"]
    active_intent_id: str
    ontology_draft_id: str | None
    draft_id: str | None
    draft_revision: int | None
    reextract: dict
    publication_performed: Literal[False]
    extraction_started: Literal[False]


class MaterialDraftState(WireResponse):
    status: str
    revision: int
    source_current: bool
    has_changes: bool | None = Field(
        default=None, description="Actual fact or ontology-target differences; opening a draft is not a change. Missing means older owner, not false."
    )
    change_count: int | None = Field(default=None, ge=0)
    ontology_changed: bool | None = None


class ExtractionReviewIssue(WireResponse):
    batch_index: int = Field(ge=0)
    stage: str
    reason: str
    audit_rounds: int = Field(ge=0, le=2)
    message: str


class PublicationBlocker(WireResponse):
    code: str
    message: str


class MaterialExtractionQuality(WireResponse):
    coverage_unconfirmed: bool
    excluded_candidate_count: int = Field(ge=0, strict=True)


class MaterialPublication(WireResponse):
    id: str
    document_version_id: str
    status: Literal["published"]
    published_at: str | None
    entity_count: int | None = Field(default=None, ge=0)
    relation_count: int | None = Field(default=None, ge=0)
    extraction_quality: MaterialExtractionQuality | None = None


class MaterialExtractionReview(WireResponse):
    run_id: str
    reason_code: str
    message: str
    issues: list[ExtractionReviewIssue]
    next_action: Literal["review_candidates"]
    entity_count: int | None = Field(default=None, ge=0, description="All entity candidates, including candidates not yet adopted or valid for publication.")
    relation_count: int | None = Field(default=None, ge=0, description="All relation candidates, including candidates not yet adopted or valid for publication.")
    adoptable_entity_count: int | None = Field(
        default=None, ge=0, strict=True,
        description="Entity candidates eligible to be added to a draft. Missing or null means unknown on older owners, not zero. Not a publication authorization.",
    )
    adoptable_relation_count: int | None = Field(
        default=None, ge=0, strict=True,
        description="Relation candidates eligible to be added to a draft, including uncertain relations still requiring review. Missing or null means unknown, not zero. Not a publication authorization.",
    )
    excluded_candidate_count: int | None = Field(
        default=None, ge=0, strict=True,
        description="Candidates excluded from direct adoption by evidence, endpoint or constraint checks. Not necessarily false facts. Missing or null means unknown, not zero.",
    )
    publication_blockers: list[PublicationBlocker] | None = Field(default=None, description="Why this automatic run awaits review; not a replacement for draft publication validation.")


class MaterialWorkflow(WireResponse):
    preparation: Preparation | None = None
    workflow_revision: int
    latest_transition_id: str | None
    manual_publication_protected: bool
    document_id: str
    document: dict
    document_version_id: str | None
    processing_mode: Literal["automatic", "dialogue"]
    stage: str
    label: str
    tasks: list[dict]
    conversations: list[dict]
    draft: MaterialDraftState | None
    extraction_review: MaterialExtractionReview | None = Field(
        default=None, description="Current unfenced automatic candidates awaiting review, independent of draft and publication. Never a publication authorization."
    )
    publication: MaterialPublication | None
    actions: dict
    publication_policy: Literal["automatic", "review_required"]


class MaterialWorkflowPage(WireResponse):
    items: list[MaterialWorkflow]
    total: int
    offset: int
    limit: int


class OnboardingScope(WireResponse):
    industry: str = Field(description="Warehouse industry/business domain")
    occupation: str = Field(
        description="Warehouse business role; not account identity or access control"
    )
    service_objects: list[str]
    purposes: list[str]
    material_sources: list[str]
    questions_to_answer: list[str]
    excluded_scope: list[str]
    uncertain_items: list[str]


class OnboardingQuestion(WireResponse):
    field: str
    text: str
    question_id: str | None = None
    examples: list[str] = Field(default_factory=list)
    status: Literal["pending", "answered", "skipped", "uncertain", "superseded", "deferred"] = (
        "pending"
    )
    answer: str = ""
    source: Literal["model", "fallback"] = "model"
    previous_texts: list[str] = Field(default_factory=list)


class OnboardingProgress(WireResponse):
    round: int = 0
    suggested_rounds: list[int] = Field(default_factory=list)
    covered_fields: list[str] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)
    forced_round_limit: bool = False
    guidance_rounds: int | None = None
    max_guidance_rounds: int | None = None
    remaining_rounds: int | None = None
    questions_per_round: int | None = None
    scope_level: Literal["warehouse"] | None = None
    next_priority_field: Literal["industry", "occupation"] | None = None
    guidance_complete: bool | None = None


class OnboardingDraft(WireResponse):
    revision: int
    round: int
    base_ontology_id: str
    purpose_revision: int
    guidance_rounds: int | None = None
    scope: OnboardingScope
    schema_definition: dict = Field(alias="schema")
    questions: list[OnboardingQuestion]
    question_states: list[OnboardingQuestion] = Field(default_factory=list)
    ontology_proposed: bool | None = Field(
        default=None,
        description="Whether a model-proposed ontology exists; scope-only rounds preserve this flag and the existing schema.",
    )
    changes: list[dict]
    scope_changes: list[dict]


class DialogueContextBudget(WireResponse):
    context_tokens: int
    input_tokens: int
    schema_tokens: int
    reserve_tokens: int
    min_output_tokens: int
    max_output_tokens: int
    available_output_tokens: int
    required_context_tokens: int
    output_token_budget: int


class OnboardingTurn(Receipt):
    publication_performed: Literal[False]
    context_budget: DialogueContextBudget | None = None
    conversation_id: str
    content: str
    created_at: str
    status: Literal["generating", "succeeded", "failed", "stale"]
    draft: OnboardingDraft | None = None
    answer: str | None = None
    error_code: str | None = None
    message: str | None = None
    is_current: bool | None = None
    current_revision: int | None = None
    current_draft_digest: str | None = None
    can_preview: bool | None = None
    progress: OnboardingProgress | None = None
    kind: Literal["opening", "reply"] = "reply"
    question_actions: list[dict] = Field(default_factory=list)


class OnboardingState(WireResponse):
    conversation_id: str
    status: Literal["guiding", "ready_for_preview", "stale", "published"]
    draft: OnboardingDraft
    draft_digest: str
    can_preview: bool
    active_turn_id: str | None = None
    seed: dict = Field(default_factory=dict)
    can_start: bool = False
    guidance_source: Literal["model", "fallback"] = "fallback"
    progress: OnboardingProgress
    turns: dict
    publication: dict | None
    publication_effective: bool
    publication_performed: Literal[False]


class OnboardingPreview(Receipt):
    status: Literal["previewed"]
    conversation_id: str
    draft_revision: int
    draft_digest: str
    preview_digest: str
    base_ontology_id: str
    name: str
    scope: OnboardingScope
    schema_definition: dict = Field(alias="schema")
    changes: list[dict]
    questions: list[dict]
    question_states: list[OnboardingQuestion] = Field(default_factory=list)
    publication_performed: Literal[False]


class OnboardingPublication(Receipt):
    status: Literal["published"]
    conversation_id: str
    ontology_id: str
    version_number: int
    changed: bool
    draft_revision: int
    scope: OnboardingScope
    schema_definition: dict = Field(alias="schema")
    unresolved_items: list[str]
    questions: list[dict]
    question_states: list[OnboardingQuestion] = Field(default_factory=list)
    unresolved_questions: list[OnboardingQuestion] = Field(default_factory=list)
    publication_performed: Literal[True]
    extraction_started: Literal[False]


class OntologyEditDraft(WireResponse):
    revision: int
    name: str
    schema_definition: dict = Field(alias="schema")
    questions: list[str]
    changes: list[dict]


class OntologyEditState(WireResponse):
    conversation_id: str
    workspace_id: str
    initialized: bool
    status: Literal["uninitialized", "editing", "stale", "published"]
    draft: OntologyEditDraft | None = None
    draft_digest: str | None = None
    active_turn_id: str | None = None
    can_preview: bool = False
    execution_id: str | None = None
    history: dict


class OntologyEditReceipt(Receipt):
    context_budget: DialogueContextBudget | None = None
    draft: OntologyEditDraft | None = None
    current_revision: int | None = None
    current_draft_digest: str | None = None
    is_current: bool | None = None
    answer: str | None = None
    questions: list[str] = Field(default_factory=list)
    operations: list[dict] = Field(default_factory=list)


class OntologyEditPreview(Receipt):
    draft: OntologyEditDraft
    draft_revision: int
    draft_digest: str
    preview_digest: str
    impact: ImpactPreview
    execution_preview: dict


def response_model(method, path):
    """Keys are route templates from conversation_contract.ROUTES, not caller paths."""
    c = "/workbench/conversations"
    one = c + "/{conversation_id}"
    intent = one + "/intents/{intent_id}"
    turn = one + "/turns/{turn_id}"
    models = {
        ("GET", one + "/ontology-edit"): OntologyEditState,
        ("POST", one + "/ontology-edit/initialize"): OntologyEditReceipt,
        ("POST", one + "/ontology-edit/turns"): OntologyEditReceipt,
        ("GET", one + "/ontology-edit/turns/{turn_id}"): OntologyEditReceipt,
        ("POST", one + "/ontology-edit/preview"): OntologyEditPreview,
        ("POST", one + "/ontology-edit/execute"): RuleExecution,
        ("GET", one + "/onboarding"): OnboardingState,
        ("POST", one + "/onboarding/start"): OnboardingTurn,
        ("POST", one + "/onboarding/turns"): OnboardingTurn,
        ("GET", one + "/onboarding/turns/{turn_id}"): OnboardingTurn,
        ("POST", one + "/onboarding/preview"): OnboardingPreview,
        ("POST", one + "/onboarding/publish"): OnboardingPublication,
        ("GET", c + "/materials"): MaterialWorkflowPage,
        ("GET", c + "/materials/{document_id}"): MaterialWorkflow,
        ("POST", intent + "/change-context"): ChangeContext,
        ("POST", intent + "/change-proposals"): ChangeProposal,
        ("POST", intent + "/change-proposals/{proposal_id}/read"): ChangeProposal,
        ("POST", intent + "/change-proposals/{proposal_id}/apply"): ChangeApplied,
        ("POST", c): ConversationCreated,
        ("GET", c): Page[Conversation],
        ("GET", one): Overview,
        ("GET", one + "/messages"): Messages,
        ("POST", one + "/messages"): TurnAccepted,
        ("GET", one + "/turns"): Page[TurnSummary],
        ("GET", turn): Turn,
        ("POST", turn + "/cancel"): Receipt,
        ("POST", turn + "/retry"): TurnAccepted,
        ("GET", one + "/intents"): Page[Intent],
        ("POST", one + "/intents"): IntentCreated,
        ("GET", intent): IntentDetail,
        ("POST", intent + "/analyze"): TurnAccepted,
        ("POST", intent + "/goal"): GoalReceipt,
        ("POST", intent + "/cancel"): IntentReceipt,
        ("GET", intent + "/plan"): ExtractionPlan,
        ("POST", intent + "/confirm"): ExtractionReceipt,
        ("GET", intent + "/candidates"): Candidates,
        ("POST", intent + "/retry"): ExtractionReceipt,
        ("POST", intent + "/review-plan"): MergePlan,
        ("POST", intent + "/review"): MergeReceipt,
        ("GET", "/modeling/answer-suggestions/{suggestion_id}/rules"): RuleWorkbench,
        ("POST", "/modeling/rule-previews"): RuleDraft,
        ("POST", "/modeling/rule-previews/{preview_id}/publish"): RulePublication,
        ("POST", "/modeling/impact-preview"): ImpactPreview,
        ("POST", "/modeling/impact-preview/validate"): ImpactPreview,
        ("POST", "/modeling/rule-executions"): RuleExecution,
        ("GET", "/modeling/rule-executions/{execution_id}"): RuleExecution,
        ("POST", "/modeling/rule-executions/{execution_id}/retry"): RuleExecution,
    }
    from .material_processing_contract import RESPONSES
    models.update(RESPONSES)
    from .dialogue_round_contract import RESPONSES as ROUND_RESPONSES
    models.update(ROUND_RESPONSES)
    from .source_preparation_contract import RESPONSES as SOURCE_RESPONSES
    models.update(SOURCE_RESPONSES)
    from .instruction_contract import RESPONSES as INSTRUCTION_RESPONSES
    models.update(INSTRUCTION_RESPONSES)
    from .ontology_edit_contract import RESPONSES as ONTOLOGY_RESPONSES
    models.update(ONTOLOGY_RESPONSES)
    return models[(method, path)]
