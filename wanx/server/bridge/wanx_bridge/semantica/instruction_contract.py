"""Finite semantic plan routes. The gateway never interprets user language."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .modeling_contract import Operation, StrictBody

Kind = Literal['question', 'answer', 'goal', 'rules', 'facts', 'source', 'extract', 'publish']


class Editor(StrictBody):
    session: str = Field(pattern=r'^[A-Za-z0-9_-]{20,200}$')
    generation: str = Field(pattern=r'^[0-9]{1,12}$')


class Read(StrictBody):
    native_operation: str = Field(alias='_native_operation_id', min_length=1, max_length=120, pattern=r'^[A-Za-z0-9_-]+$')
    editor: Editor | None = Field(default=None, alias='_native_editor')


class Context(Read):
    intent_id: str | None = Field(default=None, min_length=1, max_length=120)
    draft_id: str | None = Field(default=None, min_length=1, max_length=120)
    selected_item_ids: list[str] = Field(default_factory=list, max_length=20)
    allowed_scopes: list[Kind] = Field(min_length=1, max_length=8)


class Interpret(Context, Operation):
    context_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    instruction: str = Field(min_length=1, max_length=4000)
    clarification_plan_id: str | None = Field(default=None, min_length=1, max_length=120)


class Step(Read, Operation):
    expected_revision: int = Field(ge=1, le=9007199254740991)


class Confirm(Step):
    step_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmed: bool
    replacement_acknowledgement: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')


class ListPlans(Read):
    intent_id: str | None = Field(default=None, min_length=1, max_length=120)


class Wire(BaseModel):
    model_config = ConfigDict(extra='allow')


class ContextResponse(Wire):
    context_digest: str
    conversation_id: str
    workspace_id: str
    allowed_scopes: list[Kind]
    business_mutation_performed: Literal[False]


class PlanStep(Wire):
    id: str
    kind: Literal['change', 'publish_rules', 'extract']
    scope: str
    status: Literal['pending', 'prepared', 'blocked', 'completed', 'abandoned']
    depends_on: list[str]
    requires_confirmation: bool


class Plan(Wire):
    resource_id: str
    conversation_id: str
    workspace_id: str
    revision: int
    status: Literal['generating', 'ready', 'needs_clarification', 'unsupported', 'handoff', 'blocked', 'failed', 'completed', 'abandoned']
    steps: list[PlanStep]
    context_digest: str
    next_step_id: str | None
    recoverable_actions: list[str]


class Page(Wire):
    items: list[Plan]
    limit: int


class Receipt(Wire):
    resource_id: str
    revision: int
    operation_id: str
    reused: bool


ONE = '/workbench/conversations/{conversation_id}'
PLAN = ONE + '/instruction-plans/{plan_id}'
ROUTES = [
    ('POST', ONE + '/instruction-context', 'Read scoped instruction context', Context, {}),
    ('POST', ONE + '/instruction-plans', 'Interpret without business mutation', Interpret, {}),
    ('POST', ONE + '/instruction-plans/list', 'Recover recent owned plans', ListPlans, {}),
    ('POST', PLAN + '/read', 'Read plan progress and stop point', Read, {}),
    ('POST', PLAN + '/prepare', 'Preview next dependency step', Step, {}),
    ('POST', PLAN + '/confirm', 'Explicitly confirm one prepared step', Confirm, {}),
    ('POST', PLAN + '/abandon', 'Abandon pending steps; preserve completed work', Step, {}),
]
RESPONSES = {('POST', ONE + '/instruction-context'): ContextResponse,
             ('POST', ONE + '/instruction-plans'): Plan,
             ('POST', ONE + '/instruction-plans/list'): Page,
             ('POST', PLAN + '/read'): Plan, ('POST', PLAN + '/prepare'): Plan,
             ('POST', PLAN + '/confirm'): Receipt, ('POST', PLAN + '/abandon'): Receipt}
ERROR_CODES = frozenset({'MODELING_CHANGE_SCOPE_MISMATCH', 'INSTRUCTION_PLAN_STALE', 'INSTRUCTION_PLAN_TIMEOUT',
    'INSTRUCTION_PLAN_INVALID_OUTPUT', 'INSTRUCTION_PLAN_MODEL_FAILED', 'INSTRUCTION_PLAN_STEP_BLOCKED'})
