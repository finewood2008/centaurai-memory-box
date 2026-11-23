"""Versioned, non-executable product requirements shared by interview and build."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_serializer

class PrdInput(BaseModel):
    model_config=ConfigDict(extra='forbid')

class Scenario(PrdInput):
    title: str = Field(min_length=1,max_length=160)
    actor: str = Field(default='',max_length=300)
    trigger: str = Field(default='',max_length=600)
    steps: list[str] = Field(default_factory=list)
    outcome: str = Field(default='',max_length=600)

class Implementation(PrdInput):
    source: Literal['frontend', 'contract']
    contractIds: list[str] = Field(default_factory=list)
    caseRefs: list[str] = Field(min_length=1)
    conditions: str = Field(default='', max_length=600)


class Feature(PrdInput):
    implementation: Implementation | None = None
    title: str = Field(min_length=1,max_length=160)
    description: str = Field(default='',max_length=1000)
    priority: Literal['must','later'] = 'must'

class PageBlock(PrdInput):
    title: str = Field(min_length=1,max_length=160)
    kind: Literal['list','form','summary','detail','actions']
    fields: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)

class PagePlan(PrdInput):
    name: str = Field(min_length=1,max_length=160)
    purpose: str = Field(default='',max_length=600)
    blocks: list[PageBlock] = Field(default_factory=list)

class DataField(PrdInput):
    name: str = Field(min_length=1,max_length=160)
    type: Literal['text','longText','number','date','status','boolean'] = 'text'
    required: bool = False
    description: str = Field(default='',max_length=600)
    example: str = Field(default='',max_length=300)

class AcceptanceCase(PrdInput):
    ref: str | None = Field(default=None, pattern=r'^[a-z][a-z0-9_-]{0,63}$')
    title: str = Field(min_length=1,max_length=160)
    given: str = Field(default='',max_length=600)
    when: str = Field(default='',max_length=600)
    then: str = Field(default='',max_length=600)

class ProductRequirement(PrdInput):
    version: Literal[1] = 1
    problem: str = Field(default='',max_length=2000)
    currentApproach: str = Field(default='',max_length=2000)
    successOutcome: str = Field(default='',max_length=2000)
    scenarios: list[Scenario] = Field(default_factory=list)
    features: list[Feature] = Field(default_factory=list)
    pages: list[PagePlan] = Field(default_factory=list)
    dataFields: list[DataField] = Field(default_factory=list)
    rules: list[str] = Field(default_factory=list)
    expertRules: list[str] | None = None
    exceptions: list[str] = Field(default_factory=list)
    tests: list[AcceptanceCase] = Field(default_factory=list)
    outOfScope: list[str] = Field(default_factory=list)
    openQuestions: list[str] = Field(default_factory=list)

    @model_serializer(mode='wrap')
    def serialize_prd(self, handler):
        values = handler(self)
        if self.expertRules is None:
            values.pop('expertRules', None)
        return values

PRD_REVIEW_SECTIONS=['goal','flow','scope','pages','data','rules','acceptance']

def implementation_missing(solution):
    prd = solution.get('prd') or {}
    refs = [case.get('ref') for case in prd.get('tests', []) if case.get('ref')]
    missing = [] if len(refs) == len(set(refs)) else ['验收用例引用重复']
    declared = set(solution.get('capabilities', []))
    for feature in prd.get('features', []):
        if feature.get('priority') != 'must':
            continue
        plan = feature.get('implementation') or {}
        cases = plan.get('caseRefs') or []
        contracts = set(plan.get('contractIds') or [])
        if not cases or not set(cases) <= set(refs):
            missing.append(feature['title'] + '：未关联有效验收用例')
        if plan.get('source') not in {'frontend','contract'} or (plan['source'] == 'contract') != bool(contracts) or not contracts <= declared:
            missing.append(feature['title'] + '：实现来源与已声明合同不一致')
    return missing


def prd_missing(solution):
    prd=solution.get('prd')
    if prd is None:return []
    missing=[]
    for key in ('problem','currentApproach','successOutcome'):
        if not prd.get(key,'').strip():missing.append('prd.'+key)
    if not prd.get('scenarios') or any(not s.get('trigger','').strip() or not s.get('steps') or not s.get('outcome','').strip() for s in prd['scenarios']):missing.append('prd.scenarios')
    if not prd.get('features') or not any(f.get('priority')=='must' for f in prd['features']):missing.append('prd.features')
    if not prd.get('pages') or any(not page.get('blocks') for page in prd['pages']):missing.append('prd.pages')
    if set(solution['fields'])!={f['name'] for f in prd.get('dataFields',[])}:missing.append('prd.dataFields')
    if not prd.get('rules'):missing.append('prd.rules')
    if not prd.get('exceptions'):missing.append('prd.exceptions')
    if not prd.get('tests') or any(not all(t.get(k,'').strip() for k in ('given','when','then')) for t in prd['tests']):missing.append('prd.tests')
    if prd.get('openQuestions'):missing.append('prd.openQuestions')
    return missing
