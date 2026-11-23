import pytest
from centuarai_local_data_gate.starxiaotu_intent import CATALOG, validate_request, validate_decision, validate_resolution, decision_schema
from centuarai_local_data_gate.semantica_bootstrap import validate_body, operation_name


def body():
    return dict(operation_id='intent-1', version=2, context=dict(focus='page',material_title=''), text='模型在哪里配', page='graph', history=[], ontology_conversation=False)


def test_registered_classifier_is_bounded_and_cannot_select_authority():
    path='/modeling/warehouses/11111111-1111-1111-1111-111111111111/assistant-intent'
    assert operation_name('POST',path)=='classify_assistant_intent'
    assert validate_body('POST',path,body())=='intent-1'
    for extra in [{'actor_id':'other'},{'workspace_id':'other'},{'page':'private'},{'version':True},{'history':[{'text':'x','answer':'private material'}]},{'text':' '}]:
        with pytest.raises(ValueError):
            validate_request({**body(),**extra})


def test_all_valid_targets_are_finite_and_generated_into_the_schema():
    for intent, targets in [('guide',CATALOG['guides']),('navigate',CATALOG['pages'])]:
        for target in targets:
            assert validate_decision(dict(intent=intent,target=target,arguments={}))['target']==target
    assert decision_schema()['type']=='object'
    assert decision_schema()['properties']['intent']['enum']==CATALOG['intents']


def test_clarification_has_only_distinct_related_read_actions_and_context_is_bounded():
    guide=dict(intent='guide',target='graph',arguments={})
    search=dict(intent='search',target='materials',arguments={'query':'星图'})
    def clarify(values):return dict(intent='clarify',target='none',arguments={'reason':'ambiguous','candidates':values})
    assert validate_decision(clarify([guide,search]))['arguments']['candidates'][1]==search
    for values in [[],[guide],[guide,guide],[guide,search,guide],[guide,dict(intent='ontology_change',target='ontology',arguments={})],[guide,clarify([guide,search])]]:
        with pytest.raises(ValueError):validate_decision(clarify(values))
    current={**body(),'context':{'focus':'material','material_title':'星图产品介绍'},'history':[{'text':'查找星图产品','page':'graph','decision':search}]}
    assert validate_request(current)==current
    scoped=dict(intent='search',target='materials',arguments={'query':'星图','scope':'active_material'})
    assert validate_resolution(scoped,current)==scoped
    with pytest.raises(ValueError):validate_resolution(scoped,body())
    for context in [{'focus':'material','material_title':''},{'focus':'page','material_title':'文档'},{'focus':'material','material_title':'文档','workspace_id':'other'}]:
        with pytest.raises(ValueError):validate_request({**current,'context':context})


@pytest.mark.parametrize('decision',[
    dict(intent='publish',target='ontology',arguments={}),
    dict(intent='guide',target='__proto__',arguments={}),
    dict(intent='search',target='materials',arguments={'query':'x','warehouse_id':'other'}),
    dict(intent='ontology_change',target='ontology',arguments={'confirmed':True}),
    dict(intent='navigate',target='/private',arguments={}),
    dict(intent='query',target='project_stats',arguments={'metric':'secret_count'}),
])
def test_invalid_decisions_are_not_execution_requests(decision):
    with pytest.raises(ValueError):
        validate_decision(decision)
