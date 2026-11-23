"""PRD-owned renderer trees cannot write platform files or escape app/."""


import pytest
from wanx_studio.app_sources import apply_sources, read_sources
from wanx_studio.contracts import StudioError
from wanx_studio.devkit_build import validate_host_runtime


@pytest.fixture
def workspace(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    (app / "host.html").write_text("<main>Baseline</main>")
    (app / "host.mjs").write_text("// Baseline")
    return tmp_path


def test_nested_sources_can_replace_layout_and_remove_old_pages(workspace):
    apply_sources(workspace, {"app/pages/old.mjs": "// obsolete"})
    (workspace / "app/logo.png").write_bytes(b"\x89PNG\x00")
    files = {
        "app/host.html": '<main class="report">Report</main>',
        "app/host.mjs": 'import "./pages/report.mjs";',
        "app/pages/report.mjs": "// PRD custom page",
        "app/theme.css": "main { display:grid; }",
    }
    apply_sources(workspace, files, replace=True)
    assert read_sources(workspace) == files
    assert not (workspace / "app/pages/old.mjs").exists()
    assert (workspace / "app/logo.png").read_bytes() == b"\x89PNG\x00"


@pytest.mark.parametrize(
    "name",
    [
        "app/../shell/main.cjs",
        "app//bad.js",
        "/app/bad.js",
        "shell/main.cjs",
        "src/app.js",
        "miniapp.manifest.json",
        "app/.env",
        "app/a%2fb.js",
        "app/a\\b.js",
        "app/CON.json",
    ],
)
def test_rejected_batch_leaves_application_unchanged(workspace, name):
    before = read_sources(workspace)
    with pytest.raises(StudioError, match="DEVKIT_SOURCE_PATH_DENIED"):
        apply_sources(workspace, {"app/host.mjs": "// changed", name: "denied"})
    assert read_sources(workspace) == before


def test_limits_case_collisions_and_symlink_parents_are_rejected(workspace, tmp_path):
    for files in [
        {"app/A.js": "", "app/a.js": ""},
        {"app/x.js": "x" * (512 * 1024 + 1)},
        {f"app/file{i}.js": "" for i in range(65)},
    ]:
        with pytest.raises(StudioError):
            apply_sources(workspace, files)
    outside = tmp_path / "outside"
    outside.mkdir()
    (workspace / "app/pages").symlink_to(outside, target_is_directory=True)
    with pytest.raises(StudioError, match="DEVKIT_SOURCE_PATH_DENIED"):
        apply_sources(workspace, {"app/pages/escape.js": "denied"})
    assert not list(outside.iterdir())


def test_new_nested_modules_obey_existing_runtime_dependency_guard(workspace):
    import json

    (workspace / "application.manifest.json").write_text(
        json.dumps(
            {
                "applicationId": "dev.wanx.test",
                "protocolVersion": 3,
                "entrypoint": "shell/main.cjs",
                "capabilities": [],
            }
        )
    )
    (workspace / "shell").mkdir()
    for name in ["main.cjs", "host.cjs", "preload.cjs"]:
        (workspace / "shell" / name).write_text("// fixed")
    apply_sources(
        workspace, {"app/pages/private.mjs": 'fetch("/api/app-studio/private")'}
    )
    errors = validate_host_runtime(workspace)
    assert {
        "code": "HOST_RUNTIME_UNSAFE_DEPENDENCY",
        "path": "/app/pages/private.mjs",
    } in errors


def test_case_only_file_and_directory_renames_keep_new_bytes(workspace):
    apply_sources(workspace, {"app/Pages/Report.mjs": "// old"})
    files = {
        "app/host.html": "<main>New</main>",
        "app/host.mjs": "// New",
        "app/pages/report.mjs": "// new",
    }
    apply_sources(workspace, files, replace=True)
    assert read_sources(workspace) == files


def test_conflicting_directory_casing_is_rejected_before_write(workspace):
    before = read_sources(workspace)
    with pytest.raises(StudioError, match="DEVKIT_SOURCE_PATH_DENIED"):
        apply_sources(workspace, {"app/Pages/a.js": "", "app/pages/b.js": ""})
    assert read_sources(workspace) == before
