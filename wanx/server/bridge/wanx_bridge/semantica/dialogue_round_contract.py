"""Finite atomic material round and inert history contracts."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .material_processing_contract import NativeOperation


class CreateRound(NativeOperation):
    model_config = ConfigDict(extra='forbid', strict=True)
    operation_id: str = Field(min_length=1, max_length=120, pattern=r'\S')
    expected_document_version_id: str = Field(min_length=1, max_length=120)
    expected_workflow_revision: int = Field(ge=1)
    selected_draft_id: str | None = Field(default=None, min_length=1, max_length=120)
    expected_draft_revision: int | None = Field(default=None, ge=1)

    @model_validator(mode='after')
    def draft_pair(self):
        if (self.selected_draft_id is None) != (self.expected_draft_revision is None):
            raise ValueError('Draft ID and revision must be supplied together')
        return self


class Wire(BaseModel):
    model_config = ConfigDict(extra='allow')


class RoundReceipt(Wire):
    operation_id: str
    resource_id: str
    round_id: str
    conversation_id: str
    intent_id: str
    conversation_revision: int
    intent_revision: int
    document_id: str
    document_version_id: str
    workflow_revision: int
    selected_draft_id: str | None
    selected_draft_revision: int | None
    requires_draft_claim: bool
    status: Literal['active']
    reused: bool
    publication_performed: Literal[False]
    extraction_started: Literal[False]


class Round(Wire):
    id: str
    conversation_id: str
    document_id: str
    current_intent_id: str
    status: Literal['active', 'completed', 'superseded', 'unavailable']
    reason: str
    origin: Literal['atomic', 'legacy']
    document_version_id: str | None
    baseline_run_id: str | None
    superseded_by: str | None
    started_at: str
    updated_at: str
    can_continue: bool
    read_only: bool
    legacy_multi_material: bool


class RoundPage(Wire):
    items: list[Round]
    has_more: bool
    offset: int
    limit: int
    next_offset: int
    current_round_id: str | None
    requires_round_selection: bool


class RoundDetail(Round):
    intents: list[dict]
    executions: list[dict]
    drafts: list[dict]


class HistoryPage(Wire):
    items: list[dict]
    has_more: bool
    offset: int
    limit: int
    next_offset: int
    read_only: Literal[True]


class Messages(Wire):
    items: list[dict]
    has_more: bool
    next_sequence: int



BASE = '/workbench/documents/{document_id}/dialogue-rounds'
ROUTES = [
    ('POST', BASE, 'Atomically start an isolated material round', CreateRound, {}),
    ('GET', BASE, 'List current actor material rounds', None, {'offset': (0,9007199254740991), 'limit': (1,50)}),
    ('GET', BASE+'/{round_id}', 'Read round status and associations', None, {}),
    ('GET', BASE+'/{round_id}/history', 'Read inert proposal and step history', None, {'offset': (0,9007199254740991), 'limit': (1,50)}),
    ('GET', BASE+'/{round_id}/messages', 'Read authorized round transcript', None, {'after_sequence': (0,9007199254740991), 'limit': (1,100)}),
]
RESPONSES = {(method,path): model for (method,path,*_),model in zip(ROUTES,
    (RoundReceipt,RoundPage,RoundDetail,HistoryPage,Messages))}
ERROR_CODES = frozenset({'MODELING_ROUND_HISTORICAL', 'MODELING_ROUND_WORKFLOW_CHANGED',
    'MODELING_ROUND_DRAFT_CHANGED', 'MODELING_ROUND_DRAFT_SELECTION_REQUIRED', 'MODELING_ROUND_SINGLE_MATERIAL', 'MODELING_ROUND_ATOMIC_REQUIRED'})
EXAMPLES = {CreateRound: {'operation_id':'new-round','_native_operation_id':'new-round',
    'expected_document_version_id':'version','expected_workflow_revision':1}}
