"""Standard wanx-app-dev-kit workspace and pipeline adapter.

The adapter is opt-in through the private ``devKit`` project marker. Legacy
projects never enter this module and retain their miniapp build/export path.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from . import devkit
from .capability_mapping import resolve, validate_manifest_capabilities
from .contracts import StudioError


PIPELINE = ("check", "build", "package")


def enabled(project: dict[str, Any]) -> bool:
    return bool(project.get("devKit"))


def _run(root: Path, *args: str, timeout: int = 180) -> dict[str, Any]:
    try:
        result = subprocess.run(
            ["npm", "run", *args],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={k: v for k, v in os.environ.items() if k in {"PATH", "LANG", "TMPDIR", "HOME", "USER", "TMP"}},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise StudioError("DEVKIT_PIPELINE_UNAVAILABLE", 503) from error
    return {
        "command": ["npm", "run", *args],
        "exitCode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }



def _set_version(workspace: Path, version: str) -> None:
    for relative in ("application.manifest.json", "package.json", "package-lock.json"):
        path = workspace / relative
        value = json.loads(path.read_text(encoding="utf-8"))
        value["version"] = version
        if relative == "package-lock.json" and isinstance(value.get("packages"), dict) and isinstance(value["packages"].get(""), dict):
            value["packages"][""]["version"] = version
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    generation_path = workspace / "generation-manifest.json"
    generation = json.loads(generation_path.read_text(encoding="utf-8"))
    for relative in ("application.manifest.json", "package.json", "package-lock.json"):
        generation["files"][relative] = hashlib.sha256((workspace / relative).read_bytes()).hexdigest()
    generation_path.write_text(json.dumps(generation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _set_host_capabilities(workspace: Path, project: dict[str, Any]) -> dict[str, Any]:
    solution = project.get("solution") or {}
    mapping = resolve(solution.get("capabilities") or [], expert=bool((project.get("devKitExpert") or {}).get("enabled")), backend=devkit.project_spec(project).get("backend"))
    manifest_path = workspace / "application.manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["capabilities"] = mapping["hostCapabilities"]
    backend = devkit.project_spec(project).get("backend") or {"mode": "none"}
    contract_ref = backend.get("connectionRef") if backend.get("mode") == "existing" else backend.get("contractRef")
    contract = {"id": contract_ref, "range": ">=1.0.0 <2.0.0"} if contract_ref else None
    # Only the fixed public Drive contract has a validated feature vocabulary.
    # Other contracts remain identity/range declarations until their own public
    # capability metadata is available; never advertise operations by guessing.
    if contract and contract_ref == "wanx.public.drive.v1":
        contract["features"] = ["read", "write", "refresh"]
    manifest.setdefault("compatibility", {})["backendContracts"] = [contract] if contract else []
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    generation_path = workspace / "generation-manifest.json"
    generation = json.loads(generation_path.read_text(encoding="utf-8"))
    generation["files"]["application.manifest.json"] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    generation_path.write_text(json.dumps(generation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return mapping


def validate_host_runtime(workspace: Path) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    manifest = json.loads((workspace / "application.manifest.json").read_text(encoding="utf-8"))
    errors.extend(validate_manifest_capabilities(manifest))
    allowed = {"applicationId", "name", "version", "protocolVersion", "runtime", "launchMode", "platform", "arch", "entrypoint", "capabilities", "description", "compatibility", "critical"}
    if set(manifest) - allowed:
        errors.append({"code": "STANDARD_HOST_MANIFEST_UNKNOWN_FIELD", "path": "/"})
    compatibility = manifest.get("compatibility")
    if isinstance(compatibility, dict) and compatibility.get("resourceDependencies"):
        errors.append({"code": "STANDARD_HOST_RESOURCE_DEPENDENCY", "path": "/compatibility/resourceDependencies"})
    if manifest.get("protocolVersion") != 3 or manifest.get("entrypoint") != "shell/main.cjs":
        errors.append({"code": "STANDARD_HOST_MANIFEST_INVALID", "path": "/"})
    for relative in ("shell/main.cjs", "shell/host.cjs", "shell/preload.cjs", "app/host.mjs", "app/host.html"):
        if not (workspace / relative).is_file():
            errors.append({"code": "STANDARD_HOST_FILE_MISSING", "path": "/" + relative})
    forbidden = ("/api/app-studio/", "http://", "https://", "fetch(", "XMLHttpRequest")
    for relative in ("shell/main.cjs", "shell/host.cjs", "shell/preload.cjs", "app/host.mjs", "app/host.html"):
        if (workspace / relative).is_file():
            content = (workspace / relative).read_text(encoding="utf-8")
            if any(token in content for token in forbidden):
                errors.append({"code": "HOST_RUNTIME_UNSAFE_DEPENDENCY", "path": "/" + relative})
    return errors

def create_workspace(project: dict[str, Any], project_root: Path, parent: Path, *, version: str = "0.1.0") -> dict[str, Any]:
    kit_root = devkit._kit_root(project_root)
    if kit_root is None:
        raise StudioError("DEVKIT_ROOT_NOT_CONFIGURED", 503)
    spec = devkit.project_spec(project)
    errors = devkit.validate_project_spec(spec)
    if (project.get("solution") or {}).get("dependencies") and spec["backend"].get("mode") == "none":
        errors.append({"code": "BACKEND_CONTRACT_REQUIRED", "path": "/backend"})
    if errors:
        raise StudioError("DEVKIT_PROJECT_INVALID", 422)
    workspace = parent / "devkit-workspace"
    if workspace.exists():
        raise StudioError("DEVKIT_WORKSPACE_EXISTS", 409)
    workspace.parent.mkdir(parents=True, exist_ok=True)
    spec_path = parent / "project-spec.json"
    spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    generator = kit_root / "tools" / "app-builder" / "generate.mjs"
    try:
        result = subprocess.run(
            ["node", str(generator), "--spec", str(spec_path), "--out", str(workspace)],
            cwd=kit_root,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        shutil.rmtree(workspace, ignore_errors=True)
        spec_path.unlink(missing_ok=True)
        raise StudioError("DEVKIT_GENERATOR_UNAVAILABLE", 503) from error
    if result.returncode:
        shutil.rmtree(workspace, ignore_errors=True)
        spec_path.unlink(missing_ok=True)
        raise StudioError("DEVKIT_GENERATE_FAILED", 422)
    try:
        _set_version(workspace, version)
        mapping = _set_host_capabilities(workspace, project)
        runtime_errors = validate_host_runtime(workspace)
        if runtime_errors:
            raise StudioError("DEVKIT_HOST_RUNTIME_INVALID", 422)
        npm_result = subprocess.run(["npm", "ci"], cwd=workspace, capture_output=True, text=True, timeout=180, check=False, env={k: v for k, v in os.environ.items() if k in {"PATH", "LANG", "TMPDIR", "HOME", "USER", "TMP"}})
    except (OSError, subprocess.TimeoutExpired) as error:
        shutil.rmtree(workspace, ignore_errors=True)
        spec_path.unlink(missing_ok=True)
        raise StudioError("DEVKIT_DEPENDENCIES_UNAVAILABLE", 503) from error
    except BaseException:
        shutil.rmtree(workspace, ignore_errors=True)
        spec_path.unlink(missing_ok=True)
        raise
    npm = {"command": ["npm", "ci"], "exitCode": npm_result.returncode, "stdout": npm_result.stdout[-4000:], "stderr": npm_result.stderr[-4000:]}
    if npm["exitCode"]:
        shutil.rmtree(workspace, ignore_errors=True)
        spec_path.unlink(missing_ok=True)
        raise StudioError("DEVKIT_DEPENDENCIES_FAILED", 422)
    return {
        "root": str(workspace),
        "spec": spec,
        "specHash": devkit.digest(spec),
        "generation": json.loads((workspace / "generation-manifest.json").read_text(encoding="utf-8")),
        "hostCapabilities": mapping["hostCapabilities"],
        "capabilityGaps": mapping["gaps"],
    }


def mutable_files(workspace: Path) -> dict[str, str]:
    files = {}
    for relative in ("app/host.mjs", "app/host.html"):
        path = workspace / relative
        files[relative] = path.read_text(encoding="utf-8")
    return files


def apply_mutable_files(workspace: Path, files: dict[str, str]) -> None:
    allowed = {"app/host.mjs", "app/host.html"}
    if set(files) - allowed:
        raise StudioError("DEVKIT_SOURCE_PATH_DENIED", 422)
    for relative, content in files.items():
        if not isinstance(content, str) or len(content.encode()) > 524 * 1024:
            raise StudioError("DEVKIT_SOURCE_LIMIT", 422)
        (workspace / relative).write_text(content, encoding="utf-8")


def run_pipeline(workspace: Path) -> dict[str, Any]:
    runtime_errors = validate_host_runtime(workspace)
    if runtime_errors:
        raise StudioError("DEVKIT_HOST_RUNTIME_INVALID", 422)
    stages = {}
    for stage in PIPELINE:
        result = _run(workspace, stage)
        stages[stage] = result
        if result["exitCode"]:
            raise StudioError("DEVKIT_" + stage.upper() + "_FAILED", 422)
    packages = sorted((workspace / "local-packages").glob("*.zip"))
    if len(packages) != 1:
        raise StudioError("DEVKIT_PACKAGE_MISSING", 422)
    package = packages[0]
    payload = package.read_bytes()
    manifest = json.loads((workspace / "application.manifest.json").read_text(encoding="utf-8"))
    return {
        "stages": stages,
        "packageName": package.name,
        "packageSha256": hashlib.sha256(payload).hexdigest(),
        "packageBase64": base64.b64encode(payload).decode("ascii"),
        "manifest": manifest,
        "generationManifest": json.loads((workspace / "generation-manifest.json").read_text(encoding="utf-8")),
    }
