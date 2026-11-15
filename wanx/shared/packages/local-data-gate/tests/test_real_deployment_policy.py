"""Trusted delivery commands are not an application or workspace capability."""
import pytest
from centuarai_local_data_gate.native_policy import classify_octop
from centuarai_local_data_gate.protocol import DataProtocolError

P="a"*32
SLOT="ai.wanx.selfmade."+"b"*32

@pytest.mark.parametrize("prefix",["/api/app-studio","/api/_client/workshop"])
def test_delivery_is_host_only_http_with_no_aliases_or_query(prefix):
    for method,tail in [("GET","client-deliveries"),("POST",f"client-deliveries/{P}/claim"),("GET",f"client-deliveries/{P}/payload"),("POST",f"client-deliveries/{P}/ack")]:
        path=prefix+"/deployment/"+tail
        assert classify_octop(method,path,"http","wanx-host")["family"]=="deployment-client"
        for application in [SLOT,"ai.wanx.studio","centaurai.wanx.ai-browser"]:
            with pytest.raises(DataProtocolError):classify_octop(method,path,"http",application)
        with pytest.raises(DataProtocolError):classify_octop(method,path+"?nonce=fake","http","wanx-host")
        with pytest.raises(DataProtocolError):classify_octop(method,path,"websocket","wanx-host")
        if method=="GET":
            with pytest.raises(DataProtocolError):classify_octop("HEAD",path,"http","wanx-host")

@pytest.mark.parametrize("prefix",["/api/app-studio","/api/_client/workshop"])
def test_project_deployment_cannot_inherit_query_or_wrong_methods(prefix):
    for method,tail in [("GET","context"),("POST","prepare"),("POST","submit")]:
        path=prefix+f"/projects/{P}/deployment/"+tail
        assert classify_octop(method,path,"http","wanx-host")["family"] in {"studio","workshop"}
        for query in ["?boxId=other","?limit=1","?after=0"]:
            with pytest.raises(DataProtocolError):classify_octop(method,path+query,"http","wanx-host")
        with pytest.raises(DataProtocolError):classify_octop(method,path,"websocket","wanx-host")
        if method=="GET":
            with pytest.raises(DataProtocolError):classify_octop("HEAD",path,"http","wanx-host")

@pytest.mark.parametrize("prefix",["/api/app-studio","/api/_client/workshop"])
def test_slot_runtime_stays_bound_to_own_application(prefix):
    path=prefix+f"/deployment/apps/{SLOT}/runtime"
    assert classify_octop("POST",path,"http",SLOT)["action"]=="execute"
    other="ai.wanx.selfmade."+"c"*32
    with pytest.raises(DataProtocolError):classify_octop("POST",path,"http",other)
    with pytest.raises(DataProtocolError):classify_octop("POST",path+"?environment=prod","http",SLOT)


@pytest.mark.parametrize("prefix",["/api/app-studio","/api/_client/workshop"])
def test_directory_intake_has_finite_management_routes_and_no_path_or_target_query(prefix):
    for method,tail in [('GET','directory-releases'),('GET','expert-templates'),('GET','directory-releases/Expert.demo-0.1.0/context'),('POST','directory-releases/Expert.demo-0.1.0/ingest'),('POST','directory-releases/Expert.demo-0.1.0/prepare'),('POST','directory-releases/Expert.demo-0.1.0/submit')]:
        path=prefix+'/deployment/'+tail
        assert classify_octop(method,path,'http','wanx-host')['family'] in {'studio','workshop'}
        with pytest.raises(DataProtocolError):classify_octop(method,path,'http',SLOT)
        with pytest.raises(DataProtocolError):classify_octop(method,path+'?path=/data','http','wanx-host')
        with pytest.raises(DataProtocolError):classify_octop(method,path,'websocket','wanx-host')
        with pytest.raises(DataProtocolError):classify_octop('DELETE',path,'http','wanx-host')
        if method=='GET':
            with pytest.raises(DataProtocolError):classify_octop('HEAD',path,'http','wanx-host')


def test_studio_project_expert_contract_and_release_are_exact_management_routes():
    for method,tail in [('GET','expert'),('PUT','expert'),('POST','release')]:
        path=f'/api/app-studio/projects/{P}/deployment/{tail}'
        for app in ['wanx-host','ai.wanx.studio']:
            assert classify_octop(method,path,'http',app)['family']=='studio'
        with pytest.raises(DataProtocolError):classify_octop(method,path,'http',SLOT)
        for query in ['?','?path=/data','?boxId=other']:
            with pytest.raises(DataProtocolError):classify_octop(method,path+query,'http','wanx-host')
        with pytest.raises(DataProtocolError):classify_octop(method,path,'websocket','wanx-host')
        with pytest.raises(DataProtocolError):classify_octop('DELETE',path,'http','wanx-host')
        with pytest.raises(DataProtocolError):classify_octop(method,path.replace('/api/app-studio','/api/_client/workshop'),'http','wanx-host')
