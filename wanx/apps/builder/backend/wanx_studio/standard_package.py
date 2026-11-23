"""Verify an immutable standard Host ZIP without extracting or repackaging it."""
from __future__ import annotations
import base64
import binascii
import hashlib
import io
from itertools import chain
import json
import re
import stat
import unicodedata
import zipfile
from .contracts import StudioError, has_credentials

MAX_COMPRESSED = 32 * 1024 * 1024
MAX_EXTRACTED = 128 * 1024 * 1024
MAX_ENTRIES = 10000
_PRIVATE = re.compile(r"^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|secrets?(?:\..*)?)$|\.(?:pem|key|p12|pfx)$",re.I)

# Scan executable text and configuration, not images, archives, or public prose.
# Dependencies are included: their fixed runtime/env expressions are not literals.
_TEXT_SUFFIXES={'.js','.mjs','.cjs','.jsx','.ts','.tsx','.json','.html','.css','.yaml','.yml','.toml','.ini','.conf','.config','.xml','.sql'}
_SOURCE_SUFFIXES={'.js','.mjs','.cjs','.jsx','.ts','.tsx'}
_MAX_TEXT=8*1024*1024
_PRIVATE_LOCATOR=re.compile(r'/Users/|/Volumes/|/home/|192\.168\.\d+\.\d+|127\.0\.0\.1:\d+')
_LITERAL=re.compile(r"""(["'`])((?:\\.|(?!\1)[^\\])*)\1""",re.S)
_ASSIGNED_LITERAL=re.compile(r"""["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)["']?\s*[=:]\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1""",re.I|re.S)


def _check_text(name,content):
    suffix='.'+name.rsplit('.',1)[-1].lower() if '.' in name else ''
    if suffix not in _TEXT_SUFFIXES:return
    if len(content)>_MAX_TEXT:_invalid()
    text=content.decode('utf-8')
    if suffix in _SOURCE_SUFFIXES:
        values=chain((match[2] for match in _LITERAL.finditer(text)),(match[0] for match in _ASSIGNED_LITERAL.finditer(text)))
    else:values=[text]
    for value in values:
        if has_credentials(value) or _PRIVATE_LOCATOR.search(value.replace('\\/','/')):_invalid()


def _invalid():
    raise StudioError("STANDARD_PACKAGE_INVALID",422)


def _unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:_invalid()
        result[key]=value
    return result


def validate_standard_package(package_base64, package_sha256, manifest, *, application_id=None, version=None):
    """Return the original ZIP bytes. This generic helper grants no capabilities."""
    if not isinstance(package_base64,str) or len(package_base64)>4*((MAX_COMPRESSED+2)//3) or not isinstance(package_sha256,str) or not re.fullmatch(r"[a-f0-9]{64}",package_sha256):_invalid()
    if not isinstance(manifest,dict) or type(manifest.get("protocolVersion")) is not int or manifest.get("protocolVersion")!=3 or manifest.get("runtime")!="electron" or manifest.get("launchMode")!="shared" or manifest.get("entrypoint")!="shell/main.cjs":_invalid()
    if application_id is not None and manifest.get("applicationId")!=application_id:_invalid()
    if version is not None and manifest.get("version")!=version:_invalid()
    try:
        raw=base64.b64decode(package_base64,validate=True)
        if base64.b64encode(raw).decode()!=package_base64 or len(raw)>MAX_COMPRESSED or hashlib.sha256(raw).hexdigest()!=package_sha256:_invalid()
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries=archive.infolist()
            if not 1<=len(entries)<=MAX_ENTRIES or sum(entry.file_size for entry in entries)>MAX_EXTRACTED:_invalid()
            names=set();files={};total=0
            for entry in entries:
                name=entry.filename.rstrip("/")
                parts=name.split("/")
                portable=unicodedata.normalize("NFC",name).casefold()
                mode=entry.external_attr>>16
                if not name or len(name.encode())>4096 or any(part in {"",".",".."} or _PRIVATE.search(part) or re.search(r'[<>:"\\|?*\x00-\x1f]|[ .]$',part) for part in parts) or portable in names or entry.flag_bits&1 or stat.S_IFMT(mode) not in {0,stat.S_IFREG,stat.S_IFDIR}:_invalid()
                names.add(portable)
                if entry.is_dir():continue
                total+=entry.file_size
                if total>MAX_EXTRACTED:_invalid()
                # Reading every entry verifies CRC and actual decompression size.
                content=archive.read(entry)
                if len(content)!=entry.file_size:_invalid()
                _check_text(name,content)
                if name=="application.manifest.json":
                    if len(content)>256*1024:_invalid()
                    built=json.loads(content.decode("utf-8"),object_pairs_hook=_unique)
                    if built!=manifest:_invalid()
                files[name]=entry.file_size
            required={"application.manifest.json","shell/main.cjs","shell/host.cjs","shell/preload.cjs","app/host.html","app/host.mjs"}
            if not required<=files.keys():_invalid()
        return raw
    except (ValueError,TypeError,UnicodeError,binascii.Error,zipfile.BadZipFile,RuntimeError,NotImplementedError,OSError):
        raise StudioError("STANDARD_PACKAGE_INVALID",422) from None
