"""Real runtime/store behavior; HTTP authentication is exercised separately against WANX."""
import base64
import copy
import hashlib
from types import SimpleNamespace
from uuid import uuid4

import pytest

from wanx_studio.contracts import StudioError
from standard_build_fixture import seeded
from wanx_studio.service import StudioService
from wanx_studio.team import TeamPublications

ROOT=__import__('pathlib').Path(__file__).resolve().parents[2]

def op():return uuid4().hex

class Applications:
    def __init__(self):self.products={};self.deployments={};self.access={}
    def get(self,key):return self.products.get(key)
    def deployment(self,key):return copy.deepcopy(self.deployments.get(key))
    def user_access(self,key,user):return self.access.get((key,user))

@pytest.fixture
async def team(tmp_path):
    svc=StudioService(tmp_path,ROOT)
    users={i:SimpleNamespace(id=i,role='admin' if i==1 else 'user',disabled=False) for i in [1,2,3]}
    repo=Applications();services=SimpleNamespace(user_repo=SimpleNamespace(get=users.get),application_repo=repo)
    svc.team=TeamPublications(svc,services)
    p = await seeded(svc, "wanx:1", name="内部应用", goal="管理员私有需求")
    a = svc.store.get("wanx:1", p["id"])["artifacts"][-1]
    svc.versions.adopt("wanx:1", p["id"], {
        "operationId": op(), "expectedRevision": p["versioning"]["revision"],
        "artifactHash": a["hash"], "confirmedByUser": True,
    })
    repo.products[p['appId']]=SimpleNamespace(created_by=1)
    repo.deployments[p['appId']]={'enabled':False,'configuration':{'studio_team':{'projectId':p['id'],'artifactHash':a['hash'],'audience':'all'}}}
    receipt={'operationId':op(),'artifactHash':a['hash'],'applicationId':p['appId'],'version':a['version']}
    svc.installed('wanx:1',p['id'],receipt)
    repo.deployments[p['appId']]['enabled']=True
    yield SimpleNamespace(svc=svc,users=users,repo=repo,project=p,artifact=a,receipt=receipt)
    await svc.close()

async def test_member_lease_is_private_and_cannot_grant_undeclared_access(team):
    svc, project, artifact = team.svc, team.project, team.artifact
    opened = svc.open_installed_runtime("wanx:2", project["appId"], artifact["hash"], "production")
    token = opened["session"]
    assert opened["packageBase64"] == artifact["devKitPackage"]["packageBase64"]
    assert svc.runtime("wanx:2", token)["owner"] == "wanx:2"
    with pytest.raises(StudioError, match="RUNTIME_SESSION_EXPIRED"):
        svc.close_runtime("wanx:3", token)
    with pytest.raises(StudioError, match="PROJECT_NOT_FOUND"):
        svc.open_runtime("wanx:2", project["id"], artifact["hash"], "preview")
    for method, params in [
        ("data.put", {"collection": "items", "value": {"title": "private"}}),
        ("model.generate", {"prompt": "private"}),
    ]:
        with pytest.raises(StudioError, match="CAPABILITY_DENIED"):
            await svc.invoke("wanx:2", token, method, params)
    assert svc.store.db.execute("SELECT count(*) FROM records").fetchone()[0] == 0
    assert svc.store.db.execute("SELECT count(*) FROM usage").fetchone()[0] == 0
    svc.close_runtime("wanx:2", token)


async def test_catalog_and_portable_payload_exclude_private_requirements(team):
    s,p,a=team.svc,team.project,team.artifact
    catalog=s.list_projects('wanx:2')
    assert catalog[0]['appId']==p['appId']
    for key in ['solution','context','owner','confirmation','acceptance','preparation']:
        assert key not in catalog[0]
    payload=s.install_payload('wanx:2',p['id'],a['hash'])
    assert payload["packageBase64"] == a["devKitPackage"]["packageBase64"]
    assert hashlib.sha256(base64.b64decode(payload["packageBase64"], validate=True)).hexdigest() == payload["packageSha256"] == a["packageSha256"]
    assert "bundle" not in payload and "context" not in payload
    assert 'owner' not in payload and 'solution' not in payload
    with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):s.store.get('wanx:2',p['id'])

@pytest.mark.parametrize('change',['unpublish','revoke','disable','policy','replace'])
async def test_revocation_applies_to_existing_runtime_on_every_call(team,change):
    s,p,a=team.svc,team.project,team.artifact
    token=s.open_installed_runtime('wanx:2',p['appId'],a['hash'],'production')['session']
    if change=='unpublish':team.repo.deployments[p['appId']]['enabled']=False
    if change=='revoke':team.repo.access[(p['appId'],2)]=False
    if change=='disable':team.users[2].disabled=True
    if change=='policy':team.repo.deployments[p['appId']]['configuration']['studio_team']['audience']='selected'
    if change=='replace':
        with s.store.lock:s.store.db.execute('UPDATE team_publications SET artifact=?',('f'*64,))
    denial = "STUDIO_IDENTITY_FORBIDDEN" if change == "disable" else "TEAM_APPLICATION_UNAVAILABLE"
    with pytest.raises(StudioError, match=denial):
        await s.invoke("wanx:2", token, "data.list", {"collection": "items"})
    with pytest.raises(StudioError, match=denial):
        s.open_installed_runtime("wanx:2", p["appId"], a["hash"], "production")
    with pytest.raises(StudioError, match=denial):
        s.install_payload("wanx:2", p["id"], a["hash"])
    if change == "disable":
        with pytest.raises(StudioError, match=denial):
            s.list_projects("wanx:2")
    else:
        assert s.list_projects("wanx:2") == []


async def test_selected_members_and_explicit_denial_override_all(team):
    s,p,a=team.svc,team.project,team.artifact
    team.repo.deployments[p['appId']]['configuration']['studio_team']['audience']='selected'
    s.installed('wanx:1',p['id'],{**team.receipt,'operationId':op()})
    team.repo.access[(p['appId'],2)]=True
    assert s.list_projects('wanx:2')
    assert not s.list_projects('wanx:3')
    with pytest.raises(StudioError,match="TEAM_APPLICATION_UNAVAILABLE"):s.install_payload('wanx:3',p['id'],a['hash'])

async def test_deployment_metadata_without_admin_receipt_is_not_executable(team):
    s,p,a=team.svc,team.project,team.artifact
    with s.store.lock:s.store.db.execute('DELETE FROM team_publications')
    assert s.list_projects('wanx:2')==[]
    with pytest.raises(StudioError,match="TEAM_APPLICATION_UNAVAILABLE"):s.open_installed_runtime('wanx:2',p['appId'],a['hash'],'production')
    with pytest.raises(StudioError,match='STUDIO_ADMIN_REQUIRED'):
        s.team.seal('wanx:2',p['id'],s.install_payload('wanx:1',p['id'],a['hash']))
