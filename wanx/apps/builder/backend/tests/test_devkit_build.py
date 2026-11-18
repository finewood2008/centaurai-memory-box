import json
import base64
import hashlib
import zipfile
from pathlib import Path
import pytest

from wanx_studio import devkit_build

ROOT = Path(__file__).resolve().parents[2]


def project():
    return {
        "id": "a" * 32,
        "name": "Demo App",
        "appId": "dev.wanx.demo-app",
        "devKit": True,
        "artifacts": [],
        "solution": {"capabilities": [], "dependencies": []},
    }


def test_workspace_pipeline_generates_standard_package(tmp_path):
    workspace = devkit_build.create_workspace(project(), ROOT, tmp_path)
    root = Path(workspace["root"])
    assert (root / "project-spec.json").is_file()
    assert (root / "generation-manifest.json").is_file()
    assert (root / "shell/main.cjs").is_file()
    result = devkit_build.run_pipeline(root)
    assert result["packageName"].endswith(".zip")
    assert len(result["packageSha256"]) == 64
    assert result["manifest"]["protocolVersion"] == 3
    assert len(base64.b64decode(result["packageBase64"])) > 100


def test_legacy_project_is_not_opted_into_devkit():
    value = project()
    value["artifacts"] = [{"hash": "legacy"}]
    value["devKit"] = False
    assert devkit_build.enabled(value) is False


def test_capability_mapping_and_backend_expert_declarations(tmp_path):
    value = project()
    value["solution"]["capabilities"] = ["data", "files", "knowledge", "reports"]
    value["solution"]["dependencies"] = [{"id": "svc", "requirement": "service", "reason": "needed"}]
    value["devKitBackend"] = {"mode": "custom", "deployment": "external", "contractRef": "wanx.service"}
    value["devKitExpert"] = {"enabled": True, "definitionRef": "wanx.expert"}
    from wanx_studio.contracts import StudioError
    from wanx_studio.capability_mapping import resolve
    mapping = resolve(value["solution"]["capabilities"], expert=True, backend=value["devKitBackend"])
    assert mapping["gaps"] == [
        {"id": cap, "reason": "NO_PUBLIC_HOST_CONTRACT"} for cap in ["data", "knowledge", "reports"]
    ]
    with pytest.raises(StudioError, match="STANDARD_RUNTIME_CONTRACT_REQUIRED"):
        devkit_build.create_workspace(value, ROOT, tmp_path)
    assert not (tmp_path / "devkit-workspace").exists()


def test_backend_contract_features_are_only_declared_for_public_drive(tmp_path):
    value = project()
    value["devKitBackend"] = {"mode": "custom", "deployment": "external", "contractRef": "wanx.service"}
    generic_root = Path(devkit_build.create_workspace(value, ROOT, tmp_path)["root"])
    generic = json.loads((generic_root / "application.manifest.json").read_text())
    assert generic["compatibility"]["backendContracts"] == [{"id": "wanx.service", "range": ">=1.0.0 <2.0.0"}]

    drive = project()
    drive["devKitBackend"] = {"mode": "custom", "deployment": "external", "contractRef": "wanx.public.drive.v1"}
    drive_root = Path(devkit_build.create_workspace(drive, ROOT, tmp_path / "drive")["root"])
    manifest = json.loads((drive_root / "application.manifest.json").read_text())
    assert manifest["compatibility"]["backendContracts"][0]["features"] == ["read", "write", "refresh"]


def test_delivery_state_distinguishes_standard_install_and_legacy():
    from wanx_studio.service import delivery_state
    legacy = {"artifacts": [{"hash": "old"}], "devKit": False, "installed": None}
    standard = {"artifacts": [{"hash": "new", "devKitPackage": {"packageSha256": "x"}}], "devKit": True, "installed": {"artifactHash": "new"}}
    assert delivery_state(legacy, legacy["artifacts"][0])["application"]["status"] == "legacy"
    assert delivery_state(standard, standard["artifacts"][0])["application"]["status"] == "passed"
    assert delivery_state(standard, standard["artifacts"][0])["install"]["status"] == "passed"


def test_standard_package_has_manifest_root_and_matching_digest(tmp_path):
    root = Path(devkit_build.create_workspace(project(), ROOT, tmp_path)["root"])
    result = devkit_build.run_pipeline(root)
    archive = tmp_path / "app.zip"
    archive.write_bytes(base64.b64decode(result["packageBase64"]))
    with zipfile.ZipFile(archive) as package:
        names = set(package.namelist())
        assert "application.manifest.json" in names
        assert "shell/main.cjs" in names
        assert "app/host.mjs" in names
        assert all(not name.startswith("/") for name in names)
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == result["packageSha256"]


def test_host_manifest_rejects_unknown_fields_protocol_and_resources(tmp_path):
    root = Path(devkit_build.create_workspace(project(), ROOT, tmp_path)["root"])
    manifest_path = root / "application.manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["unknown"] = True
    manifest["protocolVersion"] = 1
    manifest["compatibility"]["resourceDependencies"] = [{"kind": "expert"}]
    manifest_path.write_text(json.dumps(manifest))
    codes = {item["code"] for item in devkit_build.validate_host_runtime(root)}
    assert {"STANDARD_HOST_MANIFEST_UNKNOWN_FIELD", "STANDARD_HOST_RESOURCE_DEPENDENCY", "STANDARD_HOST_MANIFEST_INVALID"} <= codes


def test_host_runtime_rejects_external_dependencies_in_mutable_html(tmp_path):
    root = Path(devkit_build.create_workspace(project(), ROOT, tmp_path)["root"])
    html = root / "app/host.html"
    html.write_text('<script src="https://untrusted.example/app.js"></script>')
    errors = devkit_build.validate_host_runtime(root)
    assert {item["code"] for item in errors} == {"HOST_RUNTIME_UNSAFE_DEPENDENCY"}
    assert errors[0]["path"] == "/app/host.html"


def test_workspace_refuses_existing_output_and_leaks_no_absolute_path(tmp_path):
    first = devkit_build.create_workspace(project(), ROOT, tmp_path)
    assert Path(first["root"]).exists()
    try:
        devkit_build.create_workspace(project(), ROOT, tmp_path)
    except Exception as error:
        assert getattr(error, "code", "") == "DEVKIT_WORKSPACE_EXISTS"
    else:
        raise AssertionError("workspace collision was not rejected")
    text = (Path(first["root"]) / "project-spec.json").read_text()
    assert str(ROOT) not in text


def test_managed_expert_is_projected_to_fixed_public_contract(tmp_path):
    value=project();value['solution']['capabilities']=['data','foundation']
    value['deploymentExpert']={'schemaVersion':1,'profile':'wanx-expert-app-v1','revision':1}
    spec=devkit_build.devkit.project_spec(value)
    assert spec['expert']=={'enabled':True,'definitionRef':'wanx.expert-app.v1'}
    assert spec['backend']=={'mode':'existing','connectionRef':'wanx.expert-app.v1'}
    workspace=devkit_build.create_workspace(value,ROOT,tmp_path)
    assert workspace['capabilityGaps']==[]
    manifest=json.loads((Path(workspace['root'])/'application.manifest.json').read_text())
    assert manifest['capabilities']==['identity.read','http.request']
    assert manifest['compatibility']['backendContracts']==[{'id':'wanx.expert-app.v1','range':'>=1.0.0 <2.0.0','features':['context','expert','data']}]
    assert manifest['compatibility']['resourceDependencies']==[]


def test_npm_environment_uses_only_trusted_cache_flags(monkeypatch,tmp_path):
    from types import SimpleNamespace
    calls=[]
    monkeypatch.setenv('WANX_DEVKIT_NPM_CACHE',str(tmp_path/'cache'))
    monkeypatch.setenv('WANX_DEVKIT_NPM_OFFLINE','1')
    monkeypatch.setenv('NPM_CONFIG_USERCONFIG','/private/user-credentials.npmrc')
    monkeypatch.setattr(devkit_build.subprocess,'run',lambda args,**kwargs:(calls.append((args,kwargs)) or SimpleNamespace(returncode=0,stdout='',stderr='')))
    devkit_build._run(tmp_path,'check')
    args,kwargs=calls[-1]
    assert kwargs['env']['NPM_CONFIG_CACHE']==str(tmp_path/'cache')
    assert kwargs['env']['NPM_CONFIG_OFFLINE']=='true'
    assert kwargs['env']['NPM_CONFIG_USERCONFIG']=='/dev/null'
    assert '/private/user-credentials.npmrc' not in str(kwargs)


@pytest.mark.parametrize('missing', ['module', 'stylesheet'])
def test_pipeline_rejects_dangling_renderer_graph_before_packaging(tmp_path,missing):
    root = Path(devkit_build.create_workspace(project(), ROOT, tmp_path)["root"])
    if missing == 'module':
        devkit_build.apply_mutable_files(root, {'app/host.mjs': 'import "./pages/missing.mjs";'})
    else:
        devkit_build.apply_mutable_files(root, {'app/host.html': '<link rel="stylesheet" href="missing.css"><script type="module" src="host.mjs"></script>'})
    with pytest.raises(Exception,match='STANDARD_PREVIEW_INVALID'):
        devkit_build.run_pipeline(root)
    assert not (root/'dist').exists()


@pytest.mark.parametrize('source,expected', [
    ('import "./styles.css";', 'STANDARD_DELIVERY_LINK_CSS_REQUIRED'),
    ('import value from "./config.json"; console.log(value);', 'STANDARD_DELIVERY_JSON_ATTRIBUTE_REQUIRED'),
])
def test_pipeline_rejects_preview_only_imports_for_native_delivery(tmp_path,source,expected):
    from wanx_studio.contracts import StudioError
    root = Path(devkit_build.create_workspace(project(), ROOT, tmp_path)["root"])
    devkit_build.apply_mutable_files(root, {'app/host.mjs': source,'app/config.json':'{}'})
    with pytest.raises(StudioError,match=expected):
        devkit_build.run_pipeline(root)
    assert not (root/'dist').exists()
