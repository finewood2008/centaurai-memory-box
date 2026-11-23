"""Actual Bridge registration and selected-owner transport for the classifier."""
import json
import pytest
from test_semantica_desktop_contract import AUTH,BASE,W,desktop  # noqa: F401


def body():
    return dict(operation_id='intent-1',version=2,context=dict(focus='page',material_title=''),text='模型在哪里配置',page='graph',history=[],ontology_conversation=False)


async def test_classifier_is_forwarded_to_selected_workspace_without_execution(desktop):
    client,_,_,seen,_,_=desktop
    response=await client.post(BASE+W+'/modeling/assistant-intent',headers=AUTH,json=body())
    assert response.status_code==200,response.text
    assert seen[0].url.path.startswith('/api/integration/modeling/warehouses/')
    assert seen[0].url.path.endswith('/assistant-intent')
    assert json.loads(seen[0].content)==body()


@pytest.mark.parametrize('change',[{'actor_id':'other'},{'workspace_id':'other'},{'page':'private'},{'history':[{'text':'x','decision':{'intent':'publish'}}]},{'version':99}])
async def test_invalid_classifier_context_is_rejected_before_forwarding(desktop,change):
    client,_,_,seen,_,_=desktop
    response=await client.post(BASE+W+'/modeling/assistant-intent',headers=AUTH,json={**body(),**change})
    assert response.status_code in (403,422),response.text
    assert seen==[]


@pytest.mark.parametrize('status,code',[(503,'MODELING_INTENT_DEPENDENCY_MISSING'),(504,'MODELING_INTENT_TIMEOUT')])
async def test_classifier_public_failures_survive_the_bridge(desktop,status,code):
    client,_,_,_,reply,_=desktop
    reply.update(status=status,value={'code':code,'detail':'private diagnostic must not be forwarded'})
    response=await client.post(BASE+W+'/modeling/assistant-intent',headers=AUTH,json=body())
    assert response.status_code==status,response.text
    assert response.json()['code']==code
    assert 'private diagnostic' not in response.text
