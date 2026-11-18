"""Compile a verified standard ZIP to an inert, self-contained layout document.

This boundary reads source bytes and compiles them; it never imports or executes
application code, opens a business session, or rewrites the delivery package.
"""
from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path
import subprocess
import zipfile

from .contracts import StudioError
from .standard_package import validate_standard_package
from .versions import verify

MAX_FILES=256
MAX_FILE_BYTES=2*1024*1024
MAX_SOURCE_BYTES=8*1024*1024
MAX_DOCUMENT_BYTES=12*1024*1024
MAX_OUTPUT_BYTES=16*1024*1024


def compile_layout(project_root: Path, artifact: dict) -> dict:
    verify(artifact)
    package=artifact['devKitPackage']
    raw=validate_standard_package(package['packageBase64'],artifact['packageSha256'],artifact['manifest'],version=artifact['version'])
    files={};total=0
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for entry in archive.infolist():
            if entry.is_dir() or not entry.filename.startswith('app/'):continue
            total+=entry.file_size
            if len(files)>=MAX_FILES or entry.file_size>MAX_FILE_BYTES or total>MAX_SOURCE_BYTES:
                raise StudioError('STANDARD_PREVIEW_LIMIT_EXCEEDED',413)
            files[entry.filename]=base64.b64encode(archive.read(entry)).decode('ascii')
    if not {'app/host.html','app/host.mjs'}<=files.keys():
        raise StudioError('STANDARD_PREVIEW_INVALID',422)
    return compile_sources(project_root, files, artifact['manifest'], artifact['hash'], artifact['packageSha256'])


def workspace_sources(workspace: Path) -> dict[str, str]:
    files = {}; total = 0
    app = workspace / 'app'
    if app.is_symlink() or not app.is_dir():
        raise StudioError('STANDARD_PREVIEW_INVALID', 422)
    for path in sorted(app.rglob('*')):
        if path.is_symlink():
            raise StudioError('STANDARD_PREVIEW_INVALID', 422)
        if not path.is_file():
            continue
        size = path.stat().st_size; total += size
        if len(files) >= MAX_FILES or size > MAX_FILE_BYTES or total > MAX_SOURCE_BYTES:
            raise StudioError('STANDARD_PREVIEW_LIMIT_EXCEEDED', 413)
        files[path.relative_to(workspace).as_posix()] = base64.b64encode(path.read_bytes()).decode('ascii')
    return files


def compile_sources(project_root: Path, files: dict, manifest: dict, artifact_hash: str, package_sha256: str, *, delivery: bool = False) -> dict:
    root=Path(project_root).resolve();compiler=root/'tools'/'compile-standard-preview.mjs'
    if not compiler.is_file():raise StudioError('STANDARD_PREVIEW_UNAVAILABLE',503)
    request={'files':files,'manifest':manifest,'artifactHash':artifact_hash,'packageSha256':package_sha256}
    try:
        result=subprocess.run(['node','--max-old-space-size=256',str(compiler), *(['--validate-delivery'] if delivery else [])],
            input=json.dumps(request,ensure_ascii=False).encode(),capture_output=True,
            cwd=root,timeout=15,check=False,
            env={k:v for k,v in os.environ.items() if k in {'PATH','LANG','TMPDIR'}})
    except (OSError,subprocess.TimeoutExpired):
        raise StudioError('STANDARD_PREVIEW_UNAVAILABLE',503) from None
    if result.returncode or len(result.stdout)>MAX_OUTPUT_BYTES:
        code=result.stderr.decode('utf-8',errors='replace').strip()
        if delivery and code in {'STANDARD_DELIVERY_ES_MODULE_REQUIRED','STANDARD_DELIVERY_LINK_CSS_REQUIRED','STANDARD_DELIVERY_JSON_ATTRIBUTE_REQUIRED','STANDARD_DELIVERY_ASSET_REFERENCE_REQUIRED'}:
            raise StudioError(code,422)
        raise StudioError('STANDARD_PREVIEW_INVALID',422)
    try:value=json.loads(result.stdout)
    except (ValueError,UnicodeError):raise StudioError('STANDARD_PREVIEW_INVALID',422) from None
    if not isinstance(value,dict) or set(value)!={'format','artifactHash','packageSha256','document'} or value['format']!='wanx-standard-layout-v1' or value['artifactHash']!=artifact_hash or value['packageSha256']!=package_sha256 or not isinstance(value['document'],str) or not value['document'].strip() or len(value['document'].encode())>MAX_DOCUMENT_BYTES:
        raise StudioError('STANDARD_PREVIEW_INVALID',422)
    return value
