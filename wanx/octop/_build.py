"""Hatch build hook that carries the Studio backend into Octop distributions.

Studio's Python package lives at ``apps/builder/backend/wanx_studio`` in the
WANX workspace, outside this project root. Source builds reach it through the
workspace-relative path; builds from a source archive already contain the
staged ``wanx_studio/`` copy, so the hook only falls back to it there.
"""

from __future__ import annotations

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

WORKSPACE_PACKAGE = "../apps/builder/backend/wanx_studio"
ARCHIVE_PACKAGE = "wanx_studio"


class StudioDistributionHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict) -> None:
        # Editable wheels use dev-mode-dirs; a copied package would shadow the
        # canonical Builder source and break its project-relative resources.
        if self.target_name == "wheel" and version == "editable":
            return
        root = Path(self.root)
        source = root / WORKSPACE_PACKAGE
        if not source.is_dir():
            source = root / ARCHIVE_PACKAGE
        if source.is_dir():
            build_data["force_include"][str(source)] = ARCHIVE_PACKAGE
