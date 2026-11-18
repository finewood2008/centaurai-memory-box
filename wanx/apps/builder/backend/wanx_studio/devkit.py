"""Read-only integration with the wanx-app-dev-kit contracts.

This module is intentionally limited to the first migration milestone.  It
does not build or package an application and it never changes the existing
miniapp artifact path.  It projects the current product solution into the
dev-kit ProjectSpec shape and reports which later delivery stages have not
run yet.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import tarfile
from pathlib import Path
from typing import Any

from .contracts import StudioError, digest
from .capability_mapping import resolve, runtime_gaps


PROJECT_REF = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:[./-][a-zA-Z0-9][a-zA-Z0-9_-]*)*$")
SLUG = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
APPLICATION_ID = re.compile(r"^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sdk_tree_digest(root: Path, artifact: dict[str, Any]) -> str | None:
    # App Kit's declared digest is digestTree, not the npm tarball checksum.
    # Preserve its manifest order (JS locale ordering differs from Python's).
    names = artifact.get("files")
    relative=artifact.get("path")
    if not isinstance(relative,str) or Path(relative).is_absolute() or ".." in Path(relative).parts:return None
    directory = root / relative
    if not isinstance(names, list) or not names or not all(isinstance(x,str) for x in names) or len(set(names)) != len(names):
        return None
    if not directory.is_dir() or directory.is_symlink():return None
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()}
    if actual != set(names):return None
    h = hashlib.sha256()
    for name in names:
        if not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts:return None
        path = directory / name
        if any(p.is_symlink() for p in [path, *path.parents] if p != root.parent):return None
        h.update(name.encode());h.update(b"\0");h.update(path.read_bytes());h.update(b"\0")
    return h.hexdigest()


def _sdk_archive_matches(path: Path, root: Path, artifact: dict[str, Any]) -> bool:
    # The tarball has no separately published checksum. Verify the exact npm
    # package contents against the independently declared SDK tree instead.
    try:
        if path.stat().st_size>32*1024*1024:return False
        expected={"package/"+name:(root/artifact["path"]/name).read_bytes() for name in artifact["files"]}
        with tarfile.open(path,"r:gz") as archive:
            seen=set();total=0
            for member in archive:
                if member.isdir():continue
                if not member.isfile() or member.name not in expected or member.name in seen:return False
                total+=member.size
                if total>32*1024*1024 or member.size!=len(expected[member.name]):return False
                stream=archive.extractfile(member)
                if stream is None or stream.read()!=expected[member.name]:return False
                seen.add(member.name)
            return seen==set(expected)
    except (OSError,ValueError,tarfile.TarError,KeyError,TypeError):return False


def _kit_root(project_root: Path | None = None) -> Path | None:
    configured = os.environ.get("WANX_APP_DEV_KIT_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    if project_root is not None:
        # Local developer layout: centaur-WANX and wanx-app-dev-kit are
        # sibling projects.  This path is used only by the Builder process;
        # it is never written into a generated application.
        candidate = project_root.resolve().parents[2] / "wanx-app-dev-kit"
        if candidate.is_dir():
            return candidate
    return None


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise StudioError("DEVKIT_CONTRACT_UNAVAILABLE", 503) from error
    if not isinstance(value, dict):
        raise StudioError("DEVKIT_CONTRACT_INVALID", 503)
    return value


def kit_info(project_root: Path | None = None) -> dict[str, Any]:
    """Return a sanitized, hash-bound description of the installed kit."""

    root = _kit_root(project_root)
    if root is None:
        return {
            "available": False,
            "code": "DEVKIT_ROOT_NOT_CONFIGURED",
            "version": None,
            "kitSha256": None,
            "sdk": None,
        }
    package_path = root / "package.json"
    manifest_path = root / "vendor" / "wanx-app-kit" / "0.3.0" / "wanx-app-kit.json"
    schema_path = root / "contracts" / "app-builder" / "project.schema.json"
    if not package_path.is_file() or not manifest_path.is_file() or not schema_path.is_file():
        return {
            "available": False,
            "code": "DEVKIT_CONTRACT_UNAVAILABLE",
            "version": None,
            "kitSha256": None,
            "sdk": None,
        }
    package = _read_json(package_path)
    manifest = _read_json(manifest_path)
    schema = _read_json(schema_path)
    kit_version = manifest.get("kitVersion")
    if not isinstance(kit_version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", kit_version):
        return {"available": False, "code": "DEVKIT_MANIFEST_INVALID", "version": None, "kitSha256": None, "sdk": None}
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not all(isinstance(item, dict) for item in artifacts):
        return {"available": False, "code": "DEVKIT_MANIFEST_INVALID", "version": kit_version, "kitSha256": None, "sdk": None}
    sdk_artifact = next((x for x in artifacts if x.get("kind") == "sdk"), None)
    if not isinstance(sdk_artifact, dict):
        return {"available": False, "code": "DEVKIT_SDK_ARTIFACT_MISSING", "version": kit_version, "kitSha256": None, "sdk": None}
    sdk_file = root / "vendor" / "wanx-app-kit" / kit_version / str(sdk_artifact.get("packageFile", ""))
    if not sdk_file.is_file():
        return {"available": False, "code": "DEVKIT_SDK_PACKAGE_MISSING", "version": kit_version, "kitSha256": None, "sdk": None}
    schema_hash = _sha256(schema_path)
    sdk_hash = _sha256(sdk_file)
    sdk_tree_hash = _sdk_tree_digest(manifest_path.parent, sdk_artifact)
    if sdk_tree_hash is None or sdk_tree_hash!=sdk_artifact.get("sha256") or not _sdk_archive_matches(sdk_file,manifest_path.parent,sdk_artifact):
        return {"available":False,"code":"DEVKIT_SDK_INTEGRITY_FAILED","version":kit_version,"kitSha256":None,"sdk":None}
    contract_hash = str(next((x.get("sha256") for x in artifacts if x.get("kind") == "contract"), ""))
    kit_hash = digest({"kitVersion": kit_version, "packageVersion": package.get("version"), "sdkSha256": sdk_hash, "schemaSha256": schema_hash, "contractSha256": contract_hash})
    return {
        "available": True,
        "code": None,
        "version": kit_version,
        "kitSha256": kit_hash,
        "sdk": {
            "name": sdk_artifact.get("name"),
            "version": sdk_artifact.get("version"),
            "sha256": sdk_hash,
            "declaredSha256": sdk_artifact.get("sha256"),
            "treeSha256": sdk_tree_hash,
            "hashMatches": sdk_tree_hash is not None and sdk_artifact.get("sha256") == sdk_tree_hash,
        },
        "projectSchemaSha256": schema_hash,
        "contractSha256": contract_hash,
        "sourceRevision": (manifest.get("source") or {}).get("revision"),
    }


def _slug(value: str, fallback: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    text = re.sub(r"-+", "-", text)
    if not text or not text[0].isalpha():
        text = fallback
    return text[:64].rstrip("-") or fallback


def _reference(value: str) -> bool:
    return bool(isinstance(value, str) and 1 <= len(value) <= 160 and PROJECT_REF.fullmatch(value))


def _managed_expert(project: dict[str, Any]) -> bool:
    value=project.get("deploymentExpert")
    if value is None:return False
    if not isinstance(value,dict) or value.get("profile")!="wanx-expert-app-v1":
        raise StudioError("EXPERT_CONTRACT_INVALID",422)
    return True


def _backend(project: dict[str, Any]) -> dict[str, Any]:
    solution = project.get("solution") or {}
    if _managed_expert(project):return {"mode":"existing","connectionRef":"wanx.expert-app.v1"}
    selected = project.get("devKitBackend") or solution.get("devKitBackend")
    if isinstance(selected, dict):
        return selected
    return {"mode": "none"}


def project_spec(project: dict[str, Any]) -> dict[str, Any]:
    """Project the current solution into the exact dev-kit input shape."""

    solution = project.get("solution") or {}
    project_id = str(project.get("id") or "")
    slug = _slug(str(project.get("name") or ""), "wanx-app-" + project_id[:8])
    application_id = str(project.get("appId") or "")
    if not APPLICATION_ID.fullmatch(application_id):
        if project.get("devKit") and application_id:raise StudioError("PROJECT_IDENTITY_INVALID",409)
        application_id = "dev.wanx." + slug
    capability_items = []
    for capability in dict.fromkeys(solution.get("capabilities") or []):
        if not isinstance(capability, str) or not capability:
            continue
        capability_items.append({"id": capability, "sourceRef": "wanx.public." + capability})
    return {
        "schemaVersion": 1,
        "slug": slug,
        "applicationId": application_id,
        "backend": _backend(project),
        "expert": {"enabled":True,"definitionRef":"wanx.expert-app.v1"} if _managed_expert(project) else project.get("devKitExpert") if isinstance(project.get("devKitExpert"), dict) else {"enabled": False},
        "capabilities": capability_items,
    }


def validate_project_spec(spec: dict[str, Any]) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    if not isinstance(spec, dict) or set(spec) != {"schemaVersion", "slug", "applicationId", "backend", "expert", "capabilities"}:
        return [{"code": "PROJECT_SCHEMA_INVALID", "path": "/"}]
    if spec["schemaVersion"] != 1:
        errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/schemaVersion"})
    if not isinstance(spec["slug"], str) or not SLUG.fullmatch(spec["slug"]) or len(spec["slug"]) > 64:
        errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/slug"})
    if not isinstance(spec["applicationId"], str) or not APPLICATION_ID.fullmatch(spec["applicationId"]) or len(spec["applicationId"]) > 64:
        errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/applicationId"})
    backend = spec["backend"]
    if not isinstance(backend, dict) or backend.get("mode") not in {"none", "existing", "custom"}:
        errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/backend"})
    elif backend["mode"] == "none" and set(backend) != {"mode"}:
        errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/backend"})
    elif backend["mode"] == "existing" and (set(backend) != {"mode", "connectionRef"} or not _reference(backend.get("connectionRef"))):
        errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/backend/connectionRef"})
    elif backend["mode"] == "custom":
        if backend.get("deployment") not in {"external", "box"}:
            errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/backend/deployment"})
        if not _reference(backend.get("contractRef")):
            errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/backend/contractRef"})
        if backend.get("deployment") == "box" and not _reference(backend.get("deploymentRef")):
            errors.append({"code": "BOX_DEPLOYMENT_REQUIRED", "path": "/backend/deploymentRef"})
    expert = spec["expert"]
    if not isinstance(expert, dict) or expert.get("enabled") not in {True, False} or (not expert.get("enabled") and set(expert) != {"enabled"}):
        errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/expert"})
    elif expert["enabled"] and not _reference(expert.get("definitionRef")):
        errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/expert/definitionRef"})
    capabilities = spec["capabilities"]
    if not isinstance(capabilities, list) or len(capabilities) > 100:
        errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": "/capabilities"})
    else:
        seen: set[str] = set()
        for index, item in enumerate(capabilities):
            if not isinstance(item, dict) or set(item) != {"id", "sourceRef"} or not _reference(item.get("id")) or not _reference(item.get("sourceRef")):
                errors.append({"code": "PROJECT_SCHEMA_INVALID", "path": f"/capabilities/{index}"})
                continue
            if item["id"] in seen:
                errors.append({"code": "DUPLICATE_CAPABILITY", "path": f"/capabilities/{index}/id"})
            seen.add(item["id"])
    return errors


def validate_project_specs(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reject duplicate slugs or application IDs in a project inventory."""
    errors: list[dict[str, Any]] = []
    seen_ids: dict[str, int] = {}
    seen_slugs: dict[str, int] = {}
    for index, spec in enumerate(specs):
        for field, seen in (("applicationId", seen_ids), ("slug", seen_slugs)):
            value = spec.get(field) if isinstance(spec, dict) else None
            if not isinstance(value, str):
                continue
            if value in seen:
                errors.append({"code": "DUPLICATE_PROJECT_IDENTITY", "path": f"/{index}/{field}", "first": seen[value]})
            else:
                seen[value] = index
    return errors


def _dry_run(root: Path, spec: dict[str, Any]) -> dict[str, Any]:
    generate = root / "tools" / "app-builder" / "generate.mjs"
    if not generate.is_file():
        return {"valid": False, "code": "DEVKIT_GENERATOR_MISSING"}
    with tempfile.TemporaryDirectory(prefix="wanx-builder-devkit-") as directory:
        spec_path = Path(directory) / "project-spec.json"
        output_path = Path(directory) / "app"
        spec_path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
        try:
            result = subprocess.run(
                ["node", str(generate), "--spec", str(spec_path), "--out", str(output_path), "--dry-run"],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return {"valid": False, "code": "DEVKIT_GENERATOR_UNAVAILABLE"}
    if result.returncode:
        return {"valid": False, "code": "DEVKIT_GENERATE_DRY_RUN_FAILED"}
    try:
        output = json.loads(result.stdout.strip())
    except ValueError:
        return {"valid": False, "code": "DEVKIT_GENERATOR_OUTPUT_INVALID"}
    return {"valid": True, "code": None, "output": output}


def compatibility_report(project: dict[str, Any], project_root: Path | None = None) -> dict[str, Any]:
    info = kit_info(project_root)
    spec = project_spec(project)
    errors = validate_project_spec(spec)
    if (project.get("solution") or {}).get("dependencies") and spec["backend"].get("mode") == "none":
        errors.append({"code": "BACKEND_CONTRACT_REQUIRED", "path": "/backend"})
    dry_run = {"valid": False, "code": "DEVKIT_ROOT_NOT_CONFIGURED"}
    if info["available"] and not errors:
        root = _kit_root(project_root)
        assert root is not None
        dry_run = _dry_run(root, spec)
        if not dry_run["valid"]:
            errors.append({"code": dry_run["code"], "path": "/"})
    legacy = bool(project.get("artifacts")) and not project.get("devKit")
    stages = {
        "scaffold": {"status": "passed" if info["available"] and not errors else "blocked", "errors": errors},
        "application": {"status": "blocked" if legacy else "not-run", "errors": [{"code": "LEGACY_MINIAPP_FORMAT", "path": "/artifacts"}] if legacy else []},
        "build": {"status": "not-run", "errors": []},
        "package": {"status": "not-run", "errors": []},
        "install": {"status": "not-run", "errors": []},
        "host": {"status": "not-run", "errors": []},
        "business": {"status": "not-run", "errors": []},
    }
    mapping = resolve((project.get("solution") or {}).get("capabilities") or [], expert=bool((spec.get("expert") or {}).get("enabled")), backend=spec.get("backend"))
    runtime_errors = [{"code": gap["reason"], "path": "/capabilities/" + gap["id"]} for gap in runtime_gaps((project.get("solution") or {}).get("capabilities") or [], expert=bool(spec["expert"].get("enabled")), backend=spec["backend"])]
    stages["runtime"] = {"status": "blocked" if runtime_errors else "passed", "errors": runtime_errors}
    return {
        "protocolVersion": 1,
        "kit": info,
        "capabilityMapping": mapping,
        "projectSpec": spec,
        "projectSpecHash": digest(spec),
        "dryRun": {k: v for k, v in dry_run.items() if k != "output"},
        "stages": stages,
        "legacy": legacy,
        "valid": not legacy and not errors and not runtime_errors and info["available"] and dry_run["valid"],
    }
