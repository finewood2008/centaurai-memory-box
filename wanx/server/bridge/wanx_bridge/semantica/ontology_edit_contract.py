"""Finite ontology Copilot contract for the current Starlink page.

Only rule publication is exposed; material execution and manual schema writes
remain outside this page contract.
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .material_processing_contract import NativeOperation


class Initialize(NativeOperation):
    base_ontology_id: str = Field(min_length=1, max_length=120)
    name: str = Field(default='本体编辑草稿', min_length=1, max_length=120)


class Revision(NativeOperation):
    expected_revision: int = Field(ge=0, le=9007199254740991)
    draft_digest: str = Field(pattern=r'^[0-9a-f]{64}$')


class Selection(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    kind: Literal['entity', 'relation', 'property']
    type_kind: Literal['entity', 'relation']
    type_name: str = Field(pattern=r'^[A-Z][A-Z0-9_]{0,63}$')
    property_name: str | None = Field(default=None, pattern=r'^[A-Za-z][A-Za-z0-9_]{0,63}$')

    @model_validator(mode='after')
    def consistent(self):
        if self.kind == 'property':
            if self.property_name is None:
                raise ValueError('Property selection requires property_name')
        elif self.kind != self.type_kind or self.property_name is not None:
            raise ValueError('Inconsistent type selection')
        return self


class Turn(Revision):
    instruction: str = Field(min_length=1, max_length=8000, pattern=r'\S')
    selected: list[Selection] = Field(default_factory=list, max_length=20)


class Propose(Turn):
    proposal_id: str | None = Field(default=None, min_length=1, max_length=120)
    proposal_digest: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')

    @model_validator(mode='after')
    def paired(self):
        if (self.proposal_id is None) != (self.proposal_digest is None):
            raise ValueError('Proposal ID and digest must be supplied together')
        return self


class Apply(Revision):
    proposal_digest: str = Field(pattern=r'^[0-9a-f]{64}$')
    confirmed: bool

    @model_validator(mode='after')
    def confirmation(self):
        if self.confirmed is not True:
            raise ValueError('Explicit confirmation required')
        return self


class Preview(Revision):
    offset: int = Field(default=0, ge=0, le=9007199254740991)
    limit: int = Field(default=20, ge=1, le=20)


class Execute(NativeOperation):
    preview_id: str = Field(min_length=1, max_length=120)
    preview_digest: str = Field(pattern=r'^[0-9a-f]{64}$')
    confirmed: bool
    mode: Literal['publish_only']

    @model_validator(mode='after')
    def confirmation(self):
        if self.confirmed is not True:
            raise ValueError('Explicit confirmation required')
        return self


class Wire(BaseModel):
    model_config = ConfigDict(extra='allow')


class Draft(Wire):
    revision: int
    name: str
    schema_definition: dict = Field(alias='schema')
    questions: list[str]
    changes: list[dict]


class History(Wire):
    items: list[dict]
    has_more: bool
    next_offset: int


class ProposalReceipt(Wire):
    resource_id: str
    status: Literal['generating', 'proposed', 'clarification_required', 'applied', 'failed', 'stale']
    proposal_digest: str | None = None
    expected_revision: int | None = None
    draft_digest: str | None = None
    summary: str | None = None
    questions: list[str] | None = None
    schema_definition: dict | None = Field(default=None, alias='schema')
    dependencies: list[str] | None = None
    error_code: str | None = None
    message: str | None = None


class ApplicationReceipt(Wire):
    resource_id: str
    status: Literal['applied']
    proposal_id: str
    proposal_digest: str
    draft: Draft
    current_revision: int
    current_draft_digest: str
    publication_performed: Literal[False]
    extraction_started: Literal[False]
    reused: bool


class State(Wire):
    conversation_id: str
    workspace_id: str
    initialized: bool
    status: Literal['uninitialized', 'editing', 'stale', 'published']
    history: History
    current_ontology_id: str | None = None
    base_ontology_id: str | None = None
    source_draft_id: str | None = None
    draft: Draft | None = None
    proposal: ProposalReceipt | None = None
    has_changes: bool | None = None
    draft_digest: str | None = None
    active_turn_id: str | None = None
    can_preview: bool | None = None
    execution_id: str | None = None
    publication: dict | None = None
    publication_effective: bool | None = None


class Initialized(Wire):
    resource_id: str
    status: Literal['initialized']
    draft: Draft
    base_ontology_id: str
    reused: bool


class TurnReceipt(Wire):
    resource_id: str
    status: Literal['generating', 'succeeded', 'failed', 'stale', 'proposed', 'clarification_required', 'applied']
    current_revision: int
    current_draft_digest: str
    is_current: bool
    answer: str | None = None
    questions: list[str] | None = None
    operations: list[dict] | None = None
    draft: Draft | None = None
    error_code: str | None = None
    message: str | None = None
    context_budget: dict | None = None
    reused: bool | None = None
    publication_performed: Literal[False] | None = None
    extraction_started: Literal[False] | None = None


class PreviewReceipt(Wire):
    resource_id: str
    status: Literal['previewed']
    draft_revision: int
    draft_digest: str
    preview_digest: str
    impact: dict
    draft: Draft
    execution_preview: dict
    reused: bool


class Publication(Wire):
    resource_id: str
    status: str
    publication: dict
    items: list[dict]


BASE = '/workbench/conversations/{conversation_id}/ontology-edit'
ROUTES = [
    ('GET', BASE, 'Read private ontology edit state and history', None, {'offset': (0, 9007199254740991), 'limit': (1, 50)}),
    ('POST', BASE+'/initialize', 'Initialize from the active ontology', Initialize, {}),
    ('POST', BASE+'/turns', 'Generate changes and save private rule draft', Turn, {}),
    ('GET', BASE+'/turns/{turn_id}', 'Recover original ontology turn', None, {}),
    ('POST', BASE+'/proposals', 'Generate a persisted suggestion without changing the draft', Propose, {}),
    ('POST', BASE+'/proposals/{proposal_id}/apply', 'Apply exactly the explicitly confirmed suggestion to the draft', Apply, {}),
    ('POST', BASE+'/preview', 'Preview rule changes and paged material impact', Preview, {}),
    ('POST', BASE+'/execute', 'Publish explicitly confirmed rules only', Execute, {}),
]
RESPONSES = {(method, path): model for (method, path, *_), model in zip(ROUTES,
    (State, Initialized, TurnReceipt, TurnReceipt, ProposalReceipt, ApplicationReceipt, PreviewReceipt, Publication))}
ERROR_CODES = frozenset('MODELING_ONTOLOGY_EDIT_' + code for code in (
    'STALE', 'BUSY', 'TIMEOUT', 'INVALID_OUTPUT', 'MODEL_FAILED', 'CLARIFICATION_REQUIRED', 'PROPOSAL_PENDING', 'NO_CHANGES')) | {'MODELING_PROPOSAL_STALE'}
OP = {'operation_id': 'edit', '_native_operation_id': 'edit'}
REV = {**OP, 'expected_revision': 0, 'draft_digest': 'a'*64}
EXAMPLES = {
    Initialize: {**OP, 'base_ontology_id': 'ontology'},
    Turn: {**REV, 'instruction': '调整类型名称'},
    Propose: {**REV, 'instruction': '建议增加项目类型', 'selected': []},
    Apply: {**REV, 'proposal_digest': 'b'*64, 'confirmed': True},
    Preview: REV,
    Execute: {**OP, 'preview_id': 'preview', 'preview_digest': 'a'*64, 'confirmed': True, 'mode': 'publish_only'},
}
