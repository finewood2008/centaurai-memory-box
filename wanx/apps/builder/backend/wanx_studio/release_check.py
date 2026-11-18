"""Validate the installed Builder before image publication, without real users or models."""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from .api import create_router
from .devkit import kit_info
from .devkit_build import (
    apply_mutable_files,
    create_workspace,
    mutable_files,
    run_pipeline,
)
from .service import StudioService


async def verify_api(root: Path, temporary: Path) -> None:
    service = StudioService(temporary / "state", root)
    app = FastAPI()
    app.include_router(create_router(service, lambda: "release-check"))
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://release-check"
        ) as client:
            reply = await client.get("/api/app-studio/deployment/capabilities")
            if reply.status_code != 200 or reply.json().get("schemaVersion") != 1:
                raise RuntimeError("BUILDER_DEPLOYMENT_API_MISSING")
    finally:
        await service.close()


def verify(*, pipeline: bool = False) -> None:
    root = Path(os.environ["WANX_STUDIO_ROOT"])
    if not kit_info(root)["available"]:
        raise RuntimeError("BUILDER_DEVKIT_UNAVAILABLE")
    subprocess.run(["npm", "--version"], check=True, capture_output=True, timeout=15)
    # These imports must resolve from the installed distribution, not an unused source copy.
    from .deployment.expert_runtime import ExpertRuntime
    from .deployment.standard_runtime import StandardRuntime

    assert ExpertRuntime and StandardRuntime
    with tempfile.TemporaryDirectory(prefix="wanx-release-check-") as directory:
        temporary = Path(directory)
        asyncio.run(verify_api(root, temporary))
        if pipeline:
            project = {
                "id": "a" * 32,
                "name": "Release check",
                "appId": "dev.wanx.release-check",
                "devKit": True,
                "solution": {"capabilities": ["data", "foundation"]},
                "deploymentExpert": {"profile": "wanx-expert-app-v1"},
            }
            result = create_workspace(project, root, temporary / "project")
            workspace = Path(result["root"])
            preload = (workspace / "shell/preload.cjs").read_text()
            if "expertContext" not in preload or "expertInvoke" not in preload:
                raise RuntimeError("BUILDER_EXPERT_BRIDGE_MISSING")
            generation = json.loads(
                (workspace / "generation-manifest.json").read_text()
            )
            if generation.get("uiTemplate") != {
                "id": "workspace-reference",
                "version": 1,
                "layoutEditable": True,
            }:
                raise RuntimeError("BUILDER_REFERENCE_TEMPLATE_MISSING")
            sources = mutable_files(workspace)
            required = {
                "app/styles.css",
                "app/pages/workspace.mjs",
                "app/pages/tasks.mjs",
            }
            if not required <= sources.keys():
                raise RuntimeError("BUILDER_REFERENCE_SOURCES_MISSING")

            # Exercise the shipped template and its actual preview compiler.
            def check_preview(result):
                with zipfile.ZipFile(
                    io.BytesIO(base64.b64decode(result["packageBase64"]))
                ) as archive:
                    files = {
                        entry.filename: base64.b64encode(archive.read(entry)).decode()
                        for entry in archive.infolist()
                        if entry.filename.startswith("app/") and not entry.is_dir()
                    }
                request = {
                    "files": files,
                    "manifest": result["manifest"],
                    "artifactHash": "a" * 64,
                    "packageSha256": result["packageSha256"],
                }
                compiled = subprocess.run(
                    ["node", str(root / "tools/compile-standard-preview.mjs")],
                    input=json.dumps(request),
                    text=True,
                    capture_output=True,
                    check=True,
                    timeout=30,
                )
                return json.loads(compiled.stdout)["document"]

            check_preview(run_pipeline(workspace, project_root=root))
            # A PRD may replace the entire layout and remove starter pages.
            sources = {
                "app/host.html": '<main id="report"></main><link rel="stylesheet" href="theme/report.css"><script type="module" src="host.mjs"></script>',
                "app/host.mjs": 'import {title} from "./pages/report.mjs"; document.getElementById("report").textContent=title;',
                "app/pages/report.mjs": 'export const title="PRD custom report";',
                "app/theme/report.css": "main { display:grid; grid-template-columns:1fr 2fr; }",
            }
            apply_mutable_files(workspace, sources, replace=True)
            shutil.rmtree(workspace / "dist")
            shutil.rmtree(workspace / "local-packages")
            document = check_preview(run_pipeline(workspace, project_root=root))
            if (
                "PRD custom report" not in document
                or (workspace / "app/pages/tasks.mjs").exists()
            ):
                raise RuntimeError("BUILDER_PRD_LAYOUT_NOT_EDITABLE")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pipeline",
        action="store_true",
        help="Generate, install, check, build and package a synthetic expert app",
    )
    verify(pipeline=parser.parse_args().pipeline)
    print("BUILDER_RELEASE_CHECK_OK")
