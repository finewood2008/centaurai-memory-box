import pytest
from centuarai_local_data_gate.native_policy import classify_octop
from centuarai_local_data_gate.protocol import DataProtocolError

P = "/api/_client/workshop"
ID = "a" * 32
APP = "ai.wanx.selfmade." + "b" * 32


def test_workshop_uses_personal_authority_never_company_management():
    for method, path in [
        ("GET", "/context"),
        ("GET", "/sources"),
        ("POST", "/copies"),
        ("GET", "/_builder/projects/" + ID + "/edits?contextId=test"),
        ("POST", "/_builder/projects/" + ID + "/edits"),
    ]:
        rule = classify_octop(method, P + path, "http", "wanx-host")
        assert rule["resourceId"] == "wanx"
        assert rule["family"] == "workshop"
    for method, path, app, selected in [
        ("POST", "/projects", "wanx-host", None),
        ("POST", "/projects/" + ID + "/build", "wanx-host", None),
        ("POST", "/copies", APP, None),
        ("GET", "/sources", "centaurai.wanx.dialogue", None),
        ("GET", "/sources", "wanx-host", "team:space:" + "a" * 32),
        ("GET", "/sources?unexpected=1", "wanx-host", None),
    ]:
        with pytest.raises(DataProtocolError):
            classify_octop(method, P + path, "http", app, selected)


def test_installed_workshop_app_has_only_personal_runtime_routes():
    for method, path in [
        ("POST", "/apps/" + APP + "/runtime"),
        ("POST", "/runtime/test/invoke"),
        ("DELETE", "/runtime/test"),
    ]:
        rule = classify_octop(method, P + path, "http", APP)
        assert rule["resourceId"] == "wanx"
        assert rule["family"] == "workshop-runtime"


def test_cleanup_is_private_host_only_not_runtime_app_authority():
    for method,path in [('GET','/_management/projects'),('POST','/_management/projects/'+ID)]:
        assert classify_octop(method,P+path,'http','wanx-host')['family']=='workshop'
        with pytest.raises(DataProtocolError):
            classify_octop(method,P+path,'http',APP)
