from pathlib import Path

from wanx_studio import devkit


ROOT = Path(__file__).resolve().parents[2]


def project(overrides=None, **kwargs):
    value = {
        "id": "a" * 32,
        "name": "客户回访助手",
        "appId": "ai.wanx.selfmade.app12345678",
        "solution": {"capabilities": ["data", "model", "data"]},
        "artifacts": [],
    }
    value.update(overrides or {})
    value.update(kwargs)
    return value


def test_kit_info_is_available_and_hash_bound():
    info = devkit.kit_info(ROOT)
    assert info["available"] is True
    assert info["version"] == "0.3.0"
    assert len(info["kitSha256"]) == 64
    assert len(info["sdk"]["sha256"]) == 64
    assert info["projectSchemaSha256"]


def test_project_spec_is_stable_and_uses_public_references():
    spec = devkit.project_spec(project())
    assert devkit.validate_project_spec(spec) == []
    assert spec["backend"] == {"mode": "none"}
    assert spec["applicationId"] == "ai.wanx.selfmade.app12345678"
    assert spec["capabilities"] == [
        {"id": "data", "sourceRef": "wanx.public.data"},
        {"id": "model", "sourceRef": "wanx.public.model"},
    ]
    assert devkit.digest(spec) == devkit.digest(devkit.project_spec(project()))


def test_validation_rejects_duplicate_capabilities_and_incomplete_box_backend():
    spec = devkit.project_spec(project())
    spec["capabilities"].append({"id": "data", "sourceRef": "wanx.public.data"})
    spec["backend"] = {"mode": "custom", "deployment": "box", "contractRef": "box.service"}
    errors = devkit.validate_project_spec(spec)
    assert {error["code"] for error in errors} == {"DUPLICATE_CAPABILITY", "BOX_DEPLOYMENT_REQUIRED"}


def test_compatibility_report_is_read_only_and_marks_legacy_artifact():
    report = devkit.compatibility_report(project({"artifacts": [{"hash": "legacy"}]}), ROOT)
    assert report["valid"] is False
    assert report["legacy"] is True
    assert report["stages"]["scaffold"]["status"] == "passed"
    assert report["stages"]["application"]["status"] == "blocked"
    assert report["stages"]["application"]["errors"] == [{"code": "LEGACY_MINIAPP_FORMAT", "path": "/artifacts"}]
    assert report["stages"]["build"]["status"] == "not-run"


def test_dry_run_parses_multiline_generator_json():
    report = devkit.compatibility_report(project(), ROOT)
    assert report["dryRun"]["valid"] is True
    assert report["valid"] is True


def test_project_inventory_rejects_identity_conflicts_and_hash_changes():
    assert devkit.validate_project_specs([
        {"slug": "demo-app", "applicationId": "dev.wanx.demo-app"},
        {"slug": "demo-app", "applicationId": "dev.wanx.demo-app"},
    ])[0]["code"] == "DUPLICATE_PROJECT_IDENTITY"
    base = project()
    changed = project({"solution": {"capabilities": ["files"]}})
    assert devkit.digest(devkit.project_spec(base)) != devkit.digest(devkit.project_spec(changed))
