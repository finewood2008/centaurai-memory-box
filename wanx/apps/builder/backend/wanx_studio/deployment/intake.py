"""Freeze an owner-scoped Kaiwu release directory before deployment.

The roots are trusted process configuration. Callers supply a release ID, never
a filesystem path. Runtime execution remains the deployment profile's job.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import hashlib
import base64
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time
from uuid import uuid4

from jsonschema import Draft7Validator

from ..contracts import StudioError, check_manifest, has_credentials
from .contracts import bundle_digest, canonicalize_json, validate_bundle
from ..standard_package import MAX_COMPRESSED, validate_standard_package
from .standard_client import is_standard, validate_client


PROFILE = "wanx-expert-app-v1"
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PATH = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$")
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
MAX_MANIFEST = 256 * 1024
MAX_FILE = 4 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
PRIVATE_LOCATOR = re.compile(r"/Users/|/Volumes/|/home/|192\.168\.\d+\.\d+|127\.0\.0\.1:\d+")


def sha(value):
    return "sha256:" + hashlib.sha256(canonicalize_json(value).encode()).hexdigest()


def _fail(code, status=422):
    raise StudioError(code, status)


def _unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def _json(raw):
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs)
        canonicalize_json(value)
        return value
    except (UnicodeError, ValueError, TypeError, StudioError):
        _fail("DIRECTORY_JSON_INVALID")


def _validator(name):
    schema = json.loads((Path(__file__).parent / "schemas" / name).read_text())
    Draft7Validator.check_schema(schema)
    return Draft7Validator(schema)


_RELEASE = _validator("release-directory.schema.json")
_CLIENT = _validator("client-payload.schema.json")


class ReleaseIntake:
    """Owner-scoped, immutable releases in the existing Studio Store."""

    def __init__(self, store, inbox_root, snapshots_root, *, backend_validator, runtime_namespace='workshop'):
        if runtime_namespace not in {'workshop','studio'}:raise ValueError('Unknown runtime namespace')
        self.store = store
        self.runtime_namespace = runtime_namespace
        self.backend_validator = backend_validator
        self.inbox = self._root(inbox_root)
        self.snapshots = self._root(snapshots_root)
        if self.inbox == self.snapshots or self.inbox in self.snapshots.parents or self.snapshots in self.inbox.parents:
            raise ValueError("Release roots must be separate")
        with self.store.lock:
            self.store.db.execute("CREATE TABLE IF NOT EXISTS directory_releases(owner TEXT, release_id TEXT, directory_digest TEXT NOT NULL, snapshot TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(owner,release_id))")
            self.store.db.execute("CREATE TABLE IF NOT EXISTS directory_release_artifacts(owner TEXT, source_id TEXT, release_id TEXT NOT NULL, artifact_id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(owner,source_id))")

    @staticmethod
    def _root(path):
        path = Path(path)
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.is_symlink():
            raise ValueError("Release root cannot be a symlink")
        path = path.resolve(strict=True)
        info = path.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, os.geteuid()} or info.st_mode & 0o022:
            raise ValueError("Unprotected release root")
        return path

    @staticmethod
    def owner_scope(owner):
        if not isinstance(owner, str) or not 1 <= len(owner) <= 256 or "\0" in owner:
            _fail("DIRECTORY_OWNER_INVALID")
        try:
            return hashlib.sha256(owner.encode()).hexdigest()
        except UnicodeError:
            _fail("DIRECTORY_OWNER_INVALID")

    @staticmethod
    def _id(value):
        if not isinstance(value, str) or not ID.fullmatch(value):
            _fail("DIRECTORY_RELEASE_INVALID")
        return value

    @staticmethod
    @contextmanager
    def _directory(parent, name=None):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open(parent, flags) if name is None else os.open(name, flags, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, os.geteuid()} or info.st_mode & 0o022:
                _fail("DIRECTORY_SOURCE_UNSAFE")
            yield fd
        finally:
            os.close(fd)

    @classmethod
    def _read(cls, root, path, limit):
        if not isinstance(path, str) or not PATH.fullmatch(path) or len(path) > 512:
            _fail("DIRECTORY_PATH_INVALID")
        parts = path.split("/")
        if len(parts) > 16:
            _fail("DIRECTORY_PATH_INVALID")
        if len(parts) > 1:
            with cls._directory(root, parts[0]) as child:
                return cls._read(child, "/".join(parts[1:]), limit)
        fd = os.open(parts[0], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=root)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid not in {0, os.geteuid()} or before.st_mode & 0o022:
                _fail("DIRECTORY_SOURCE_UNSAFE")
            if before.st_size < 1 or before.st_size > limit:
                _fail("DIRECTORY_SIZE_INVALID")
            chunks, size = [], 0
            while True:
                data = os.read(fd, min(65536, limit + 1 - size))
                if not data:
                    break
                chunks.append(data)
                size += len(data)
                if size > limit:
                    _fail("DIRECTORY_SIZE_INVALID")
            after = os.fstat(fd)
            evidence = lambda s: (s.st_dev, s.st_ino, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if evidence(before) != evidence(after) or size != before.st_size:
                _fail("DIRECTORY_SOURCE_CHANGED", 409)
            return b"".join(chunks)
        finally:
            os.close(fd)

    @classmethod
    def _tree(cls, root, prefix="", *, entries=None, visited=None):
        entries = [] if entries is None else entries
        visited = [0] if visited is None else visited
        with os.scandir(root) as children:
            for child in children:
                visited[0] += 1
                if visited[0] > 256:
                    _fail("DIRECTORY_SIZE_INVALID")
                name = child.name
                if not isinstance(name, str) or not PATH.fullmatch(name) or "/" in name:
                    _fail("DIRECTORY_PATH_INVALID")
                path = prefix + name
                info = os.stat(name, dir_fd=root, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    if path.count("/") > 15:
                        _fail("DIRECTORY_PATH_INVALID")
                    with cls._directory(root, name) as directory:
                        cls._tree(directory, path + "/", entries=entries, visited=visited)
                elif stat.S_ISREG(info.st_mode):
                    entries.append(path)
                    if len(entries) > 129:
                        _fail("DIRECTORY_SIZE_INVALID")
                else:
                    _fail("DIRECTORY_SOURCE_UNSAFE")
        return entries

    def _read_release(self, root, release_id):
        raw_manifest = self._read(root, "release.json", MAX_MANIFEST)
        manifest = _json(raw_manifest)
        if not _RELEASE.is_valid(manifest) or manifest["releaseId"] != release_id:
            _fail("DIRECTORY_MANIFEST_INVALID")
        if not VERSION.fullmatch(manifest["version"]):
            _fail("DIRECTORY_VERSION_UNSUPPORTED", 409)
        backend = manifest["backend"]
        if backend["kind"] != "expert" or backend["profileRef"] != {"id": PROFILE, "revision": 1}:
            _fail("DIRECTORY_PROFILE_UNSUPPORTED", 409)
        if manifest["client"]["mode"] != "install":
            _fail("DIRECTORY_CLIENT_UNSUPPORTED", 409)
        data = manifest["data"]
        if data != {"schemaVersion": "1", "upgradePolicy": "compatible", "taskPolicy": "none", "persistentPaths": []}:
            _fail("DIRECTORY_DATA_UNSUPPORTED", 409)
        resources = manifest["resources"]
        if len(resources) != 1 or resources[0]["kind"] != "model" or resources[0]["required"] is not True:
            _fail("DIRECTORY_RESOURCE_UNSUPPORTED", 409)
        descriptors = manifest["artifacts"]
        ids = {a["artifactId"]: a for a in descriptors}
        if len(ids) != len(descriptors) or len({a["path"] for a in descriptors}) != len(descriptors) or "release.json" in {a["path"] for a in descriptors}:
            _fail("DIRECTORY_ARTIFACT_INVALID")
        references = [(backend["artifactId"], "backend"), (manifest["client"]["artifactId"], "client")]
        package_id=manifest["client"].get("packageArtifactId")
        if package_id:references.append((package_id,"client"))
        references += [(manifest[key], "support") for key in ("configurationArtifactId", "dependencyLockArtifactId", "verificationArtifactId")]
        if len({ref for ref, _ in references}) != len(references) or set(ids) != {ref for ref, _ in references} or any(ids.get(ref, {}).get("role") != role for ref, role in references):
            _fail("DIRECTORY_ARTIFACT_INVALID")
        if any(a["mediaType"] != ("application/zip" if a["artifactId"]==package_id else "application/json") for a in descriptors):
            _fail("DIRECTORY_ARTIFACT_UNSUPPORTED", 409)
        if set(self._tree(root)) != {"release.json", *(a["path"] for a in descriptors)}:
            _fail("DIRECTORY_UNDECLARED_FILE")
        files, total = {"release.json": raw_manifest}, len(raw_manifest)
        for a in descriptors:
            raw = self._read(root, a["path"], MAX_COMPRESSED if a["artifactId"]==package_id else MAX_FILE)
            if len(raw) != a["sizeBytes"] or "sha256:" + hashlib.sha256(raw).hexdigest() != a["digest"]:
                _fail("DIRECTORY_ARTIFACT_CHANGED", 409)
            files[a["path"]] = raw
            total += len(raw)
            if total > MAX_TOTAL + (MAX_COMPRESSED if package_id else 0):
                _fail("DIRECTORY_SIZE_INVALID")
        if self._read(root, "release.json", MAX_MANIFEST) != raw_manifest:
            _fail("DIRECTORY_SOURCE_CHANGED", 409)
        payload = _json(files[ids[manifest["client"]["artifactId"]]["path"]])
        if package_id:
            validate_client(payload,archive=False)
            if payload['runtimeNamespace']!=self.runtime_namespace or payload['applicationId']!=manifest['applicationId'] or payload['version']!=manifest['version']:_fail('DIRECTORY_CLIENT_IDENTITY_MISMATCH')
            archive=files[ids[package_id]['path']]
            validate_standard_package(base64.b64encode(archive).decode(),payload['packageSha256'],payload['manifest'],application_id=manifest['applicationId'],version=manifest['version'])
        else:
            self._validate_client(manifest, payload)
        backend_value = _json(files[ids[backend["artifactId"]]["path"]])
        if canonicalize_json(backend_value) != canonicalize_json({"schemaVersion": 1, "format": "wanx-expert-backend-v1", "template": backend["template"], "mode": "ask"}):
            _fail("DIRECTORY_BACKEND_INVALID")
        validated = self.backend_validator(deepcopy(backend_value))
        if not isinstance(validated, dict) or canonicalize_json(validated) != canonicalize_json(backend_value) or validated.get("template") != backend["template"]:
            _fail("DIRECTORY_BACKEND_INVALID")
        config = _json(files[ids[manifest["configurationArtifactId"]]["path"]])
        if canonicalize_json(config) != canonicalize_json({"type": "object", "properties": {}, "additionalProperties": False}):
            _fail("DIRECTORY_CONFIGURATION_UNSUPPORTED", 409)
        lock = _json(files[ids[manifest["dependencyLockArtifactId"]]["path"]])
        if canonicalize_json(lock) != canonicalize_json({"schemaVersion": 1, "dependencies": [{"kind": "expert-template", **backend["template"]}]}):
            _fail("DIRECTORY_DEPENDENCY_INVALID")
        verification = _json(files[ids[manifest["verificationArtifactId"]]["path"]])
        self._validate_verification(verification)
        if any(has_credentials(raw.decode("utf-8")) for name,raw in files.items() if not package_id or name!=ids[package_id]["path"]):
            _fail("INPUT_CREDENTIAL_DETECTED")
        return manifest, payload, validated, lock, verification, files

    def _validate_client(self, manifest, payload):
        if not _CLIENT.is_valid(payload) or not payload["name"].strip():
            _fail("DIRECTORY_CLIENT_INVALID")
        if payload['runtimeNamespace']!=self.runtime_namespace:
            _fail('DIRECTORY_CLIENT_NAMESPACE_INVALID')
        if payload["applicationId"] != manifest["applicationId"] or payload["version"] != manifest["version"]:
            _fail("DIRECTORY_CLIENT_IDENTITY_MISMATCH")
        expected = hashlib.sha256(canonicalize_json({k: v for k, v in payload.items() if k != "artifactHash"}).encode()).hexdigest()
        if payload["artifactHash"] != expected:
            _fail("DIRECTORY_CLIENT_HASH_MISMATCH", 409)
        if set(payload["manifest"]) != {"schemaVersion", "name", "entry", "capabilities", "collections"}:
            _fail("DIRECTORY_CLIENT_INVALID")
        if type(payload["manifest"]["schemaVersion"]) is not int:
            _fail("DIRECTORY_CLIENT_INVALID")
        try:
            check_manifest(payload["manifest"])
        except (StudioError, TypeError, ValueError, KeyError):
            _fail("DIRECTORY_CLIENT_INVALID")
        caps = payload["manifest"]["capabilities"]
        if "foundation" not in caps or set(caps) - {"foundation", "data"} or len(set(caps)) != len(caps) or (payload["manifest"]["collections"] and "data" not in caps) or payload["name"] != payload["manifest"]["name"]:
            _fail("DIRECTORY_CLIENT_CAPABILITY_INVALID")
        generated = canonicalize_json({k: payload[k] for k in ("manifest", "bundle", "css")})
        if PRIVATE_LOCATOR.search(generated) or has_credentials(generated):
            _fail("DIRECTORY_CLIENT_PRIVATE_LOCATOR")

    @staticmethod
    def _validate_verification(value):
        if not isinstance(value, dict) or set(value) != {"schemaVersion", "checks"} or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or not isinstance(value["checks"], list) or len(value["checks"]) != 1:
            _fail("DIRECTORY_VERIFICATION_INVALID")
        check = value["checks"][0]
        if not isinstance(check, dict) or set(check) != {"id", "input", "expected"} or check["id"] != "text-roundtrip" or not isinstance(check["input"], dict) or set(check["input"]) != {"text"} or not isinstance(check["input"]["text"], str) or not 1 <= len(check["input"]["text"]) <= 4000 or not isinstance(check["expected"], dict) or set(check["expected"]) != {"contains"} or not isinstance(check["expected"]["contains"], str) or not 1 <= len(check["expected"]["contains"]) <= 512:
            _fail("DIRECTORY_VERIFICATION_INVALID")

    @staticmethod
    def _write(root, path, raw):
        parts = path.split("/")
        if len(parts) > 1:
            try:
                os.mkdir(parts[0], 0o700, dir_fd=root)
            except FileExistsError:
                pass
            with ReleaseIntake._directory(root, parts[0]) as child:
                ReleaseIntake._write(child, "/".join(parts[1:]), raw)
                os.fsync(child)
            os.fsync(root)
            return
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=root)
        try:
            offset = 0
            while offset < len(raw):
                offset += os.write(fd, raw[offset:])
            os.fsync(fd)
            os.fchmod(fd, 0o400)
        finally:
            os.close(fd)
        os.fsync(root)

    @staticmethod
    def _manifest_digest(manifest):
        return sha(manifest)

    def _bundle(self, owner, manifest, lock):
        content_digest = self._manifest_digest(manifest)
        provenance = "directory-" + hashlib.sha256(canonicalize_json([owner, manifest["releaseId"], content_digest]).encode()).hexdigest()
        descriptors = []
        for item in manifest["artifacts"]:
            source_id = "directory-artifact-" + hashlib.sha256(canonicalize_json([owner, manifest["releaseId"], item["artifactId"], item["digest"]]).encode()).hexdigest()
            descriptors.append({"artifactId": item["artifactId"], "role": "assets" if item["role"] == "support" else item["role"], "mediaType": item["mediaType"], "digest": item["digest"], "sizeBytes": item["sizeBytes"], "sourceRef": {"id": source_id, "digest": item["digest"]}, "platforms": deepcopy(item["platforms"])})
        backend = next(a for a in manifest["artifacts"] if a["artifactId"] == manifest["backend"]["artifactId"])
        bundle = {"schemaVersion": 1, "releaseId": manifest["releaseId"], "applicationId": manifest["applicationId"], "payloadKind": "packaged-app", "artifactDescriptors": descriptors, "dependencyLockDigest": sha(lock), "runtimeRequirements": {"runtimeRef": {"id": PROFILE, "revision": 1}, "platforms": deepcopy(backend["platforms"]), "resourceBudget": {"memoryBytes": 268435456, "storageBytes": MAX_TOTAL + sum(a["sizeBytes"] for a in manifest["artifacts"]) * 4}, "healthContractRef": {"id": PROFILE + "-health", "revision": 1}, "dataCompatibilityRef": {"id": "expert-app-additive-v1", "revision": 1}, "candidateMode": True}, "clientDelivery": {"mode":"install","artifactId":manifest["client"].get("packageArtifactId",manifest["client"]["artifactId"])}, "provenanceRef": {"id": provenance, "digest": content_digest}}
        bundle["bundleDigest"] = bundle_digest(bundle)
        return validate_bundle(bundle)

    def _record(self, owner, release_id):
        row = self.store.db.execute("SELECT directory_digest,snapshot,body FROM directory_releases WHERE owner=? AND release_id=?", (owner, release_id)).fetchone()
        if row is None:
            _fail("DIRECTORY_RELEASE_NOT_FOUND", 404)
        return row

    def _verify_snapshot(self, owner, release_id, row):
        scope = self.owner_scope(owner)
        if not re.fullmatch(r"[a-f0-9]{64}", row["snapshot"]):
            _fail("DIRECTORY_SNAPSHOT_CHANGED", 409)
        try:
            with self._directory(self.snapshots) as root, self._directory(root, scope) as owner_root, self._directory(owner_root, row["snapshot"]) as snapshot:
                manifest, base, backend, lock, verification, _ = self._read_release(snapshot, release_id)
        except OSError:
            _fail("DIRECTORY_SNAPSHOT_CHANGED", 409)
        frozen = {"owner": owner, "manifest": manifest, "directoryDigest": self._manifest_digest(manifest), "bundle": self._bundle(owner, manifest, lock), "base": base, "backend": backend, "verification": verification}
        if frozen["directoryDigest"] != row["directory_digest"] or canonicalize_json(frozen) != canonicalize_json(_json(row["body"].encode())):
            _fail("DIRECTORY_SNAPSHOT_CHANGED", 409)
        return frozen

    def ingest(self, owner, release_id):
        scope, release_id = self.owner_scope(owner), self._id(release_id)
        opened_source = False
        try:
            with self._directory(self.inbox) as root, self._directory(root, scope) as owner_root, self._directory(owner_root, release_id) as source:
                opened_source = True
                manifest, base, backend, lock, verification, files = self._read_release(source, release_id)
        except FileNotFoundError:
            if opened_source:
                _fail("DIRECTORY_SOURCE_INCOMPLETE", 409)
            # Once registered, a removed source is never needed to recover it.
            with self.store.lock:
                exists = self.store.db.execute("SELECT 1 FROM directory_releases WHERE owner=? AND release_id=?", (owner, release_id)).fetchone()
            if exists:
                return self.get(owner, release_id)
            _fail("DIRECTORY_RELEASE_NOT_FOUND", 404)
        except OSError:
            _fail("DIRECTORY_SOURCE_UNSAFE")
        digest = self._manifest_digest(manifest)
        frozen = {"owner": owner, "manifest": manifest, "directoryDigest": digest, "bundle": self._bundle(owner, manifest, lock), "base": base, "backend": backend, "verification": verification}
        with self.store.transaction():
            old = self.store.db.execute("SELECT directory_digest,snapshot,body FROM directory_releases WHERE owner=? AND release_id=?", (owner, release_id)).fetchone()
            if old:
                if old["directory_digest"] != digest:
                    _fail("DIRECTORY_RELEASE_CONFLICT", 409)
                return deepcopy(self._verify_snapshot(owner, release_id, old))
            total = sum(len(raw) for raw in files.values())
            if shutil.disk_usage(self.snapshots).free < total * 3 + MAX_TOTAL:
                _fail("INSUFFICIENT_RESOURCES", 409)
            snapshot_name = hashlib.sha256(canonicalize_json([release_id, digest]).encode()).hexdigest()
            with self._directory(self.snapshots) as root:
                try:
                    os.mkdir(scope, 0o700, dir_fd=root)
                except FileExistsError:
                    pass
                with self._directory(root, scope) as owner_root:
                    stage_name = ".intake-" + uuid4().hex
                    os.mkdir(stage_name, 0o700, dir_fd=owner_root)
                    try:
                        with self._directory(owner_root, stage_name) as stage:
                            for path, raw in files.items():
                                self._write(stage, path, raw)
                            staged, staged_base, staged_backend, staged_lock, staged_verification, _ = self._read_release(stage, release_id)
                            if staged != manifest or staged_base != base or staged_backend != backend or staged_lock != lock or staged_verification != verification:
                                _fail("DIRECTORY_SNAPSHOT_CHANGED", 409)
                            os.fsync(stage)
                        try:
                            os.stat(snapshot_name, dir_fd=owner_root, follow_symlinks=False)
                        except FileNotFoundError:
                            os.rename(stage_name, snapshot_name, src_dir_fd=owner_root, dst_dir_fd=owner_root)
                            os.fsync(owner_root)
                        # A crash may leave the same verified snapshot before its
                        # SQLite row is committed. Reverify it before adopting it.
                        row = {"directory_digest": digest, "snapshot": snapshot_name, "body": json.dumps(frozen, ensure_ascii=False)}
                        self._verify_snapshot(owner, release_id, row)
                        self.store.db.execute("INSERT INTO directory_releases VALUES(?,?,?,?,?,?)", (owner, release_id, digest, snapshot_name, row["body"], time.time()))
                        for artifact in frozen["bundle"]["artifactDescriptors"]:
                            self.store.db.execute("INSERT INTO directory_release_artifacts VALUES(?,?,?,?,?)", (owner, artifact["sourceRef"]["id"], release_id, artifact["artifactId"], artifact["digest"]))
                    finally:
                        # Only our random stage under the protected snapshot root.
                        shutil.rmtree(self.snapshots / scope / stage_name, ignore_errors=True)
        return deepcopy(frozen)

    def get(self, owner, release_id):
        self.owner_scope(owner)
        self._id(release_id)
        with self.store.lock:
            row = self._record(owner, release_id)
            return deepcopy(self._verify_snapshot(owner, release_id, row))

    def list(self, owner, limit=100):
        self.owner_scope(owner)
        if type(limit) is not int or not 1 <= limit <= 100:
            _fail("DIRECTORY_LIMIT_INVALID")
        with self.store.lock:
            rows = self.store.db.execute("SELECT release_id,directory_digest,body FROM directory_releases WHERE owner=? ORDER BY created DESC,release_id LIMIT ?", (owner, limit)).fetchall()
        items = []
        for row in rows:
            manifest = _json(row["body"].encode())["manifest"]
            items.append({"releaseId": row["release_id"], "applicationId": manifest["applicationId"], "version": manifest["version"], "profile": PROFILE, "directoryDigest": row["directory_digest"]})
        return {"items": items}

    def resolve_artifact(self, owner, source_ref):
        self.owner_scope(owner)
        if not isinstance(source_ref, dict) or set(source_ref) != {"id", "digest"} or not isinstance(source_ref["id"], str) or not ID.fullmatch(source_ref["id"]) or not isinstance(source_ref["digest"], str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", source_ref["digest"]):
            _fail("DIRECTORY_REFERENCE_INVALID")
        with self.store.lock:
            row = self.store.db.execute("SELECT release_id,artifact_id,digest FROM directory_release_artifacts WHERE owner=? AND source_id=?", (owner, source_ref["id"])).fetchone()
            if row is None or source_ref["digest"] != row["digest"]:
                _fail("DIRECTORY_ARTIFACT_NOT_FOUND", 404)
            frozen = self.get(owner, row["release_id"])
            artifact = next(a for a in frozen["manifest"]["artifacts"] if a["artifactId"] == row["artifact_id"])
            snapshot = self._record(owner, row["release_id"])["snapshot"]
            try:
                with self._directory(self.snapshots) as root, self._directory(root, self.owner_scope(owner)) as owner_root, self._directory(owner_root, snapshot) as directory:
                    raw = self._read(directory, artifact["path"], MAX_COMPRESSED if artifact["mediaType"]=="application/zip" else MAX_FILE)
            except OSError:
                _fail("DIRECTORY_SNAPSHOT_CHANGED", 409)
            if len(raw) != artifact["sizeBytes"] or "sha256:" + hashlib.sha256(raw).hexdigest() != source_ref["digest"]:
                _fail("DIRECTORY_SNAPSHOT_CHANGED", 409)
            return raw
