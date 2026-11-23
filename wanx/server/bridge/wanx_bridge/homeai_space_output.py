"""Bind a HomeAI inbox to a folder using the same authenticated WANX owner."""

import asyncio
import hashlib
import json
import re
import secrets
import time
from pathlib import Path

import httpx
from starlette.requests import ClientDisconnect, Request

from .config import BridgeAuthError
from .service_task_state import ServiceTaskState

HOMEAI_SERVICE = "wanx.homeai"
HOMEAI_BASE = "/api/services/wanx.homeai/v1"
FOLDERS_ROUTE = HOMEAI_BASE + "/space-destination/folders"
INBOX_ROUTE = HOMEAI_BASE + "/inbox-grants"
UPLOADS_ROUTE = HOMEAI_BASE + "/uploads"
OUTPUT_ROUTE = "/api/bridge/v1/homeai/space-output"
PERSONAL_SPACE = "/api/personal-space"
ID = re.compile("[a-f0-9]{32}")
GRANT_DURATION = 30 * 86400
CREDENTIAL = re.compile(r"[A-Za-z0-9_-]{43}")
SHA256 = re.compile(r"[a-f0-9]{64}")
CHUNK = 1024 * 1024
INBOX_TOKEN_PREFIX = "homeinbox_"
INBOX_TOKEN = re.compile(r"homeinbox_[A-Za-z0-9_-]{48}")
UPLOAD_PATH = re.compile(re.escape(UPLOADS_ROUTE) + r"/[A-Za-z0-9_-]{1,128}")


def is_inbox_upload(method: str, path: str) -> bool:
    if method == "POST":
        upload, _, action = path.rpartition("/")
        return path == UPLOADS_ROUTE or (
            action == "complete" and UPLOAD_PATH.fullmatch(upload) is not None
        )
    return method in {"GET", "PUT"} and UPLOAD_PATH.fullmatch(path) is not None


def folder_id(value: object) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise BridgeAuthError("HOMEAI_SPACE_INVALID_FOLDER", 400)
    return value


async def inbox_payload(request: Request) -> tuple[bytes, str | None]:
    body = bytearray()
    try:
        async with asyncio.timeout(15):
            async for chunk in request.stream():
                if len(body) + len(chunk) > 8192:
                    raise BridgeAuthError("BOX_PLATFORM_BODY_TOO_LARGE", 413)
                body.extend(chunk)
    except TimeoutError:
        raise BridgeAuthError("HOMEAI_SPACE_REQUEST_TIMEOUT", 408) from None
    except ClientDisconnect:
        raise BridgeAuthError("HOMEAI_SPACE_REQUEST_CANCELLED", 499) from None
    try:
        payload = json.loads(body) if body else None
    except (ValueError, UnicodeError):
        raise BridgeAuthError("HOMEAI_SPACE_INVALID_REQUEST", 400) from None
    if payload is None:
        return bytes(body), None
    if not isinstance(payload, dict):
        raise BridgeAuthError("HOMEAI_SPACE_INVALID_REQUEST", 400)
    if payload.get("driveFolderId") is None:
        return bytes(body), None
    if payload.get("source") != "mobile":
        raise BridgeAuthError("HOMEAI_SPACE_MOBILE_ONLY", 400)
    return bytes(body), folder_id(payload["driveFolderId"])


class SpaceOutput:
    def __init__(self, client: httpx.AsyncClient, origin: str, owner_token: str):
        self.client = client
        self.origin = origin
        self.owner_token = owner_token

    async def request(self, method: str, path: str, *, params=None, body=None, data=None) -> dict:
        if not self.owner_token:
            raise BridgeAuthError("HOMEAI_SPACE_SESSION_REQUIRED", 401)
        headers = {"Authorization": "Bearer " + self.owner_token}
        if data is not None:
            headers["Content-Type"] = "application/octet-stream"
            headers["X-Content-SHA256"] = hashlib.sha256(data).hexdigest()
        request = self.client.build_request(
            method,
            self.origin + path,
            headers=headers,
            params=params,
            json=body,
            content=data,
            timeout=10,
        )
        request.headers.pop("cookie", None)
        response = None
        try:
            async with asyncio.timeout(12):
                response = await self.client.send(request, stream=True)
                if response.status_code in {401, 403, 404}:
                    raise BridgeAuthError(
                        "HOMEAI_SPACE_ACCESS_DENIED",
                        401 if response.status_code == 401 else 403,
                    )
                if not response.is_success:
                    raise BridgeAuthError("HOMEAI_SPACE_UPSTREAM_ERROR", 502)
                output = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(output) + len(chunk) > 2 * 1024 * 1024:
                        raise BridgeAuthError("HOMEAI_SPACE_RESPONSE_TOO_LARGE", 502)
                    output.extend(chunk)
                value = json.loads(output) if output else {}
                if not isinstance(value, dict):
                    raise BridgeAuthError("HOMEAI_SPACE_INVALID_RESPONSE", 502)
                return value
        except (httpx.HTTPError, TimeoutError, ValueError):
            raise BridgeAuthError("HOMEAI_SPACE_UPSTREAM_ERROR", 502) from None
        finally:
            if response is not None:
                await response.aclose()

    async def folders(self, parent: str) -> dict:
        value = await self.request(
            "GET",
            PERSONAL_SPACE + "/files",
            params={"parent": folder_id(parent) if parent else "", "space_id": "personal"},
        )
        entries = value.get("items")
        if value.get("space_id") != "personal" or not isinstance(entries, list):
            raise BridgeAuthError("HOMEAI_SPACE_INVALID_RESPONSE", 502)
        return {
            "items": [
                {"id": folder_id(entry.get("id")), "name": entry["name"], "kind": "folder"}
                for entry in entries
                if isinstance(entry, dict)
                and entry.get("kind") == "folder"
                and entry.get("space_id") == "personal"
                and entry.get("trashed") is None
                and isinstance(entry.get("name"), str)
            ]
        }

    async def assert_folder(self, target: str) -> None:
        folder = await self.request("GET", PERSONAL_SPACE + "/files/" + target)
        if (
            folder.get("id") != target
            or folder.get("space_id") != "personal"
            or folder.get("kind") != "folder"
            or folder.get("trashed") is not None
        ):
            raise BridgeAuthError("HOMEAI_SPACE_INVALID_FOLDER", 400)


class SpaceOutputBroker:
    """Hold one bounded owner credential inside Bridge, never in the phone or HomeAI."""

    def __init__(self, path: Path, key: bytes, client, origin, validate):
        self.state = ServiceTaskState(path, b"homeai-space-output:" + key)
        self.client = client
        self.origin = origin
        self.validate = validate
        self.lock = asyncio.Lock()

    def leases(self):
        return [row for row in self.state.read() if row["expires"] > time.time()]

    async def bind(self, folder, owner, box, token, upstream_expires, authority):
        if type(upstream_expires) not in {int, float} or not isinstance(authority, dict):
            raise BridgeAuthError("HOMEAI_SPACE_SESSION_REQUIRED", 401)
        expires = int(min(time.time() + GRANT_DURATION, upstream_expires))
        if expires <= time.time():
            raise BridgeAuthError("HOMEAI_SPACE_SESSION_REQUIRED", 401)
        self.validate(authority)
        await SpaceOutput(self.client, self.origin, token).assert_folder(folder)
        credential = secrets.token_urlsafe(32)
        entry = {
            "id": secrets.token_hex(16),
            "folder": folder,
            "owner": owner,
            "box": box,
            "upstream": token,
            "authority": authority,
            "expires": expires,
            "digest": hashlib.sha256(credential.encode()).hexdigest(),
        }
        async with self.lock:
            self.validate(authority)
            leases = self.leases()
            if len(leases) >= 4096:
                raise BridgeAuthError("HOMEAI_SPACE_LEASE_CAPACITY", 503)
            self.state.write([*leases, entry])
        return {
            "folderId": folder,
            "leaseId": entry["id"],
            "credential": credential,
            "expiresAt": expires,
        }

    async def revoke(self, lease_id, owner, box):
        async with self.lock:
            leases = self.leases()
            self.state.write(
                [
                    row
                    for row in leases
                    if (row["id"], row["owner"], row["box"]) != (lease_id, owner, box)
                ]
            )

    async def transfer(self, request: Request, asset: str, operation: str):
        if request.client is None or request.client.host not in {"127.0.0.1", "::1"}:
            raise BridgeAuthError("HOMEAI_SPACE_OUTPUT_LOCAL_ONLY", 403)
        auth = request.headers.getlist("authorization")
        credential = auth[0].removeprefix("Bearer ") if len(auth) == 1 else ""
        if (
            len(auth) != 1
            or not auth[0].startswith("Bearer ")
            or not CREDENTIAL.fullmatch(credential)
        ):
            raise BridgeAuthError("HOMEAI_SPACE_LEASE_REQUIRED", 401)
        asset = folder_id(asset)
        body = bytearray()
        limit = CHUNK if operation == "chunk" else 8192
        try:
            async with asyncio.timeout(15):
                async for chunk in request.stream():
                    if len(chunk) + len(body) > limit:
                        raise BridgeAuthError("BOX_PLATFORM_BODY_TOO_LARGE", 413)
                    body.extend(chunk)
        except TimeoutError:
            raise BridgeAuthError("HOMEAI_SPACE_REQUEST_TIMEOUT", 408) from None
        except ClientDisconnect:
            raise BridgeAuthError("HOMEAI_SPACE_REQUEST_CANCELLED", 499) from None
        async with self.lock:
            hashed = hashlib.sha256(credential.encode()).hexdigest()
            lease = next(
                (row for row in self.leases() if secrets.compare_digest(row["digest"], hashed)),
                None,
            )
            if lease is None:
                raise BridgeAuthError("HOMEAI_SPACE_LEASE_EXPIRED", 401)
            self.validate(lease["authority"])
            client = SpaceOutput(self.client, self.origin, lease["upstream"])
            target = lease["folder"]
            upload = hashlib.sha256(f"wanx-homeai:{lease['id']}:{asset}".encode()).hexdigest()[:32]
            path = PERSONAL_SPACE + "/uploads"
            if operation == "chunk":
                offsets = request.query_params.getlist("offset")
                digest = request.headers.get("x-content-sha256")
                if (
                    len(offsets) != 1
                    or not re.fullmatch(r"[0-9]{1,15}", offsets[0])
                    or not body
                    or digest != hashlib.sha256(body).hexdigest()
                ):
                    raise BridgeAuthError("HOMEAI_SPACE_INVALID_CHUNK", 400)
                return await client.request(
                    "PUT", f"{path}/{upload}", params={"offset": offsets[0]}, data=bytes(body)
                )
            try:
                value = json.loads(body)
            except (ValueError, UnicodeError):
                raise BridgeAuthError("HOMEAI_SPACE_INVALID_REQUEST", 400) from None
            if not isinstance(value, dict):
                raise BridgeAuthError("HOMEAI_SPACE_INVALID_REQUEST", 400)
            if operation == "begin":
                name, size = value.get("name"), value.get("size")
                if (
                    set(value) != {"name", "size"}
                    or not isinstance(name, str)
                    or not 1 <= len(name) <= 240
                    or type(size) is not int
                    or not 0 <= size <= 2**53 - 1
                ):
                    raise BridgeAuthError("HOMEAI_SPACE_INVALID_REQUEST", 400)
                result = await client.request(
                    "POST",
                    path,
                    body={
                        "id": upload,
                        "name": name,
                        "size": size,
                        "parent": target,
                        "space_id": "personal",
                    },
                )
            else:
                digest = value.get("digest")
                if (
                    set(value) != {"digest"}
                    or not isinstance(digest, str)
                    or not SHA256.fullmatch(digest)
                ):
                    raise BridgeAuthError("HOMEAI_SPACE_INVALID_REQUEST", 400)
                result = await client.request(
                    "POST", f"{path}/{upload}/complete", body={"digest": digest}
                )
            if result.get("id") != upload or result.get("parent") != target:
                raise BridgeAuthError("HOMEAI_SPACE_INVALID_RECEIPT", 502)
            return result
