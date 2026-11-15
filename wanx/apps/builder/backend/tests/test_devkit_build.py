import json
import base64
import hashlib
import zipfile
from pathlib import Path

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
    workspace = devkit_build.create_workspace(value, ROOT, tmp_path)
    root = Path(workspace["root"])
    assert workspace["capabilityGaps"] == [
        {"id": "data", "reason": "NO_PUBLIC_HOST_CONTRACT"},
        {"id": "knowledge", "reason": "NO_PUBLIC_HOST_CONTRACT"},
        {"id": "reports", "reason": "NO_PUBLIC_HOST_CONTRACT"},
    ]
    assert json.loads((root / "integration/selection.json").read_text())["contractRef"] == "wanx.service"
    assert json.loads((root / "expert/definition.json").read_text())["definitionRef"] == "wanx.expert"
    manifest = json.loads((root / "application.manifest.json").read_text())
    assert "files.upload" in manifest["capabilities"]
    assert "http.request" in manifest["capabilities"]
    assert "experts.select" in manifest["capabilities"]
    assert devkit_build.validate_host_runtime(root) == []


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
