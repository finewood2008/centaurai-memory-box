"""Editable Octop installs must use the canonical Builder backend source."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


class OctopEditableTests(unittest.TestCase):
    def test_editable_install_imports_builder_from_its_project(self):
        uv = shutil.which("uv")
        self.assertIsNotNone(
            uv, "Editable regression requires the repository's uv toolchain"
        )
        with tempfile.TemporaryDirectory(prefix="wanx-octop-editable-") as temporary:
            target = Path(temporary) / "installed"
            installed = subprocess.run(
                [
                    uv,
                    "pip",
                    "install",
                    "--python",
                    sys.executable,
                    "--target",
                    str(target),
                    "--no-deps",
                    "--reinstall-package",
                    "octop",
                    "--editable",
                    str(REPO / "octop"),
                ],
                cwd=temporary,
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(
                installed.returncode, 0, installed.stdout + installed.stderr
            )
            # Process the installed .pth in isolation. Existing environment
            # packages and PYTHONPATH must not conceal a copied Studio package.
            imported = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-S",
                    "-c",
                    """
import site, sys
from pathlib import Path

site.addsitedir(sys.argv[1])
import octop
import wanx_studio

repo = Path(sys.argv[2]).resolve()
actual = Path(wanx_studio.__file__).resolve()
expected = repo / "apps" / "builder" / "backend" / "wanx_studio" / "__init__.py"
assert actual == expected, f"Editable Studio import shadowed: {actual} != {expected}"
assert actual.parents[2] == repo / "apps" / "builder"
assert Path(octop.__file__).resolve() == repo / "octop" / "src" / "octop" / "__init__.py"
""",
                    str(target),
                    str(REPO),
                ],
                cwd=temporary,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(imported.returncode, 0, imported.stdout + imported.stderr)


if __name__ == "__main__":
    unittest.main()
