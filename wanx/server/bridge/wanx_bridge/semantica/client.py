"""WANX supplies user-scoped context; Semantica remains the sole document owner."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import re
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from centuarai_local_data_gate import semantica_bootstrap, starlink_workbench

from wanx_bridge.semantica import conversation_contract, modeling_contract
from wanx_bridge.semantica import desktop_workbench as starlink_legacy_workbench
from wanx_bridge.semantica.document_contract import BLOCK_QUERY, validate_block_page
from wanx_bridge.semantica import annotation_contract
from wanx_bridge.semantica.maintenance import MaintenanceError, request_guard
from wanx_bridge.semantica.transport_contract import (
    grant_ttl, operation_timeout, owner_error, owner_error_message, private_import_error, private_search_error,
)

_NAMESPACE = uuid.UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514")
_READ = re.compile(
    r"^/(?:skills(?:/[a-z][a-z0-9-]{0,119}(?:/download)?)?|processing(?:/catalog)?|status|capabilities|documents|jobs|failure-events|graph|owner/graph|retrieval/status|sensitive/settings|documents/[a-zA-Z0-9_-]{1,128}(?:/(?:text|blob))?|jobs/[a-zA-Z0-9_-]{1,128}|evidence/[a-zA-Z0-9_-]{1,128}|operations/[a-zA-Z0-9_-]{1,128})$"
)
_WRITE = re.compile(
    r"^/(?:skills/(?:import|[a-z][a-z0-9-]{0,119}/delete)|reasoning/(?:discover|prepare|reference|scope|search|evidence|read-document|coverage)|processing(?:/check|/authorize|/reprocess)?|imports(?:/[a-zA-Z0-9_-]{1,128}(?:/commit)?)?|retrieval/indexes|documents/[a-zA-Z0-9_-]{1,128}/(?:correction|extraction)|jobs/[a-zA-Z0-9_-]{1,128}/(?:retry|cancel)|sensitive/settings)$"
)
_UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
_MANAGE_READ = re.compile(
    r"^/warehouses(?:/runtime|/transfers|/transfers/"
    + _UUID
    + r"(?:/blob)?|/"
    + _UUID
    + r"(?:/keys)?)?$"
)
_MANAGE_WRITE = re.compile(
    r"^/warehouses(?:/imports(?:/"
    + _UUID
    + r"(?:/commit)?)?|/"
    + _UUID
    + r"/(?:exports|clear(?:/prepare)?|delete(?:/prepare)?|keys(?:/"
    + _UUID
    + r"/revoke)?))?$"
)
_SCOPED = re.compile(r"^/warehouses/(?P<warehouse>" + _UUID + r")(?P<path>/.*)$")
_PUBLIC = re.compile(
    r"^/(?:warehouse|documents|graph|search|evidence/[a-zA-Z0-9_-]{1,128}|reasoning/(?:discover|prepare|reference|scope|search|evidence|read-document|coverage))$"
)


class SemanticaError(Exception):
    def __init__(self, code: str, status: int = 503, message: str | None = None):
        self.code, self.status, self.message = code, status, message
        super().__init__(code)


class SemanticaClient:
    def __init__(
        self,
        config: dict[str, Any],
        actor_id: int,
        application_id: str = "wanx",
        *,
        team: bool = False,
        home: Path | None = None,
    ):
        self.config = config
        self.maintenance_home = home
        address = urlsplit(str(config.get("service_url", "")))
        try:
            local = (
                address.hostname == "localhost"
                or ipaddress.ip_address(address.hostname or "").is_loopback
            )
        except ValueError:
            local = False
        if (
            address.scheme != "http"
            or not local
            or address.username
            or address.password
            or address.query
            or address.fragment
            or address.path not in {"", "/"}
        ):
            raise SemanticaError("SEMANTICA_CONFIG_INVALID")
        secret = config.get("service_token", "")
        if (
            not isinstance(secret, str)
            or (
                secret
                and (
                    len(secret) < 32
                    or not secret.isascii()
                    or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in secret)
                )
            )
            or not config.get("box_id")
            or not config.get("application_id")
        ):
            raise SemanticaError("SEMANTICA_CONFIG_INVALID")
        self.base_url = str(config["service_url"]).rstrip("/")
        self.actor = f"{application_id}:{actor_id}"
        self.team = team
        self.organization_permissions: list[str] = []
        self.resource = "team:wanx" if team else f"personal:{self.actor}"
        identity = json.dumps(
            [config["box_id"], config["application_id"], self.resource], separators=(",", ":")
        )
        self.workspace = str(uuid.uuid5(_NAMESPACE, identity))

    @classmethod
    def from_file(
        cls, path: Path, actor_id: int, application_id: str = "wanx", *, team: bool = False
    ) -> SemanticaClient:
        try:
            if path.stat().st_size > 16384:
                raise ValueError("invalid config")
            config = json.loads(path.read_text())
        except (OSError, ValueError):
            raise SemanticaError("SEMANTICA_NOT_CONFIGURED") from None
        return cls(config, actor_id, application_id, team=team, home=path.parent)

    def headers(
        self,
        operation_id: str | None = None,
        warehouse_id: str | None = None,
        *,
        owner_view: bool = False,
        ttl: int = 120,
    ) -> dict[str, str]:
        resource, workspace = self.resource, self.workspace
        if warehouse_id and warehouse_id != self.workspace:
            if not re.fullmatch(_UUID, warehouse_id):
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
            resource += ":warehouse:" + warehouse_id
            workspace = str(
                uuid.uuid5(
                    _NAMESPACE,
                    json.dumps(
                        [self.config["box_id"], self.config["application_id"], resource],
                        separators=(",", ":"),
                    ),
                )
            )
        claims = {
            "box_id": self.config["box_id"],
            "application_id": self.config["application_id"],
            "actor_id": self.actor,
            "workspace_id": workspace,
            "workspace_bindings": {workspace: resource},
            "ownership_epoch": 0,
            "permissions": ["read", "write"] if operation_id else ["read"],
            "owner_view": owner_view,
            "request_id": str(uuid.uuid4()),
            "operation_id": operation_id,
            "expires_at": int(time.time()) + min(ttl, 300),
        }
        if self.organization_permissions:
            claims["organization_permissions"] = self.organization_permissions
        if self.team:
            claims["resource_owner"] = "team:wanx"
        encoded = (
            base64.urlsafe_b64encode(
                json.dumps(
                    claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                ).encode()
            )
            .decode()
            .rstrip("=")
        )
        secret = self.config.get("service_token", "")
        if not secret:
            return {"x-semantica-scope": encoded}
        # Match the desktop adapter: standalone needs no legacy signature.
        return {
            "authorization": f"Bearer {secret}",
            "x-semantica-scope": encoded,
            "x-semantica-signature": hmac.new(
                secret.encode(), encoded.encode(), hashlib.sha256
            ).hexdigest(),
        }

    async def request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        try:
            with request_guard(self.maintenance_home, method, "/api/integration" + path):
                return await self._request(method, path, payload=payload, query=query)
        except MaintenanceError:
            raise SemanticaError("SEMANTICA_MAINTENANCE") from None

    async def _request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        warehouse_id = None
        renaming = method == "PATCH" and re.fullmatch(r"/warehouses/" + _UUID, path) is not None
        onboarding_root = any(
            method == verb and re.fullmatch(pattern, path)
            for verb, pattern, _ in modeling_contract.ROOT_RULES
        )
        managed = onboarding_root or renaming or (_MANAGE_WRITE if method != "GET" else _MANAGE_READ).fullmatch(path)
        if onboarding_root:
            if self.team:
                raise SemanticaError("MODELING_HOST_CREATION_REQUIRED", 403)
            try:
                modeling_contract.prepare(method, path, payload, query or {})
            except PermissionError as exc:
                raise SemanticaError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403) from exc
            except ValueError as exc:
                raise SemanticaError("MODELING_INVALID_REQUEST", 422) from exc
        if renaming:
            try:
                semantica_bootstrap.validate_query(method, path, query or {})
                semantica_bootstrap.validate_body(method, path, payload)
            except ValueError as exc:
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422) from exc
        if not managed and (scoped := _SCOPED.fullmatch(path)):
            warehouse_id, path = scoped["warehouse"], scoped["path"]
        scoped_modeling = False
        if warehouse_id is not None and path.startswith("/modeling/"):
            scoped_path = f"/modeling/warehouses/{warehouse_id}" + path.removeprefix("/modeling")
            scoped_modeling = semantica_bootstrap.operation_name(method, scoped_path) in {
                "classify_assistant_intent",
                "get_modeling_suggestion_context", "publish_warehouse_scope",
                "confirm_modeling_answers", "generate_modeling_suggestions",
                "get_modeling_suggestion", "get_modeling_suggestion_rules",
                "prepare_modeling_rules", "publish_modeling_rules",
            }
            if scoped_modeling:
                if self.team:
                    raise SemanticaError("MODELING_HOST_CREATION_REQUIRED", 403)
                try:
                    semantica_bootstrap.validate_query(method, scoped_path, query or {})
                    semantica_bootstrap.validate_body(method, scoped_path, payload)
                except ValueError as exc:
                    raise SemanticaError("MODELING_INVALID_REQUEST", 422) from exc
        # This legacy scoped HTTP adapter retains correction transport checks;
        # Semantica still owns the domain DTO/revision validation and errors.
        # Required gateway requests independently use the full shared contract
        # before their signed native hop, so this is not a required fallback.
        legacy_correction = re.match(
            r"/workbench/documents/[A-Za-z0-9_-]{1,128}/corrections(?:/|$)", path
        )
        shared_workbench = warehouse_id is not None and not legacy_correction and (
            starlink_workbench.query_keys(method, path) is not None
        )
        native_workbench = shared_workbench or (
            warehouse_id is not None
            and starlink_legacy_workbench.query_keys(method, path) is not None
        )
        # The loopback Host uses this adapter rather than desktop.resolve().
        # Reuse the finite conversation DTOs for new routes missing from the
        # older workbench tables, including source confirmation/index retries.
        conversation_route = (
            conversation_contract.entry(method, path)
            if warehouse_id is not None and not native_workbench and not scoped_modeling
            else None
        )
        if self.team and (
            conversation_route is not None
            or (
                shared_workbench
                and starlink_workbench.operation_name(method, path) in starlink_workbench.PERSONAL_PROCESSING_OPERATIONS
            )
        ):
            raise SemanticaError("MODELING_HOST_CREATION_REQUIRED", 403)
        if conversation_route is not None:
            try:
                conversation_contract.prepare(method, path, payload, query or {})
            except PermissionError as exc:
                raise SemanticaError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403) from exc
            except ValueError as exc:
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422) from exc
            native_workbench = True
        deleting_document = (
            method == "DELETE"
            and warehouse_id is not None
            and bool(re.fullmatch(r"/documents/[a-zA-Z0-9_-]{1,128}", path))
        )
        if method == "DELETE":
            if not deleting_document:
                raise SemanticaError("SEMANTICA_OPERATION_NOT_ALLOWED", 405)
            if (
                query
                or not isinstance(payload, dict)
                or set(payload) - {"operation_id", "expected_version_id"}
                or not isinstance(payload.get("operation_id"), str)
                or not re.fullmatch(r"[0-9a-f-]{36}", payload["operation_id"])
                or (
                    payload.get("expected_version_id") is not None
                    and (
                        not isinstance(payload["expected_version_id"], str)
                        or not re.fullmatch(_UUID, payload["expected_version_id"])
                    )
                )
            ):
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
        searching = method == "POST" and path == "/search"
        annotation_route = method in {"GET", "PUT"} and warehouse_id is not None and re.fullmatch(r"/documents/[A-Za-z0-9_-]{1,128}/source-annotation", path)
        if annotation_route:
            try:
                annotation_contract.validate(method, payload, query or {})
            except ValueError as exc:
                raise SemanticaError('SEMANTICA_INVALID_REQUEST', 422) from exc
        write = method in {"POST", "PUT", "PATCH", "DELETE"} and not searching
        if (
            not managed
            and not searching
            and not deleting_document
            and not native_workbench
            and not annotation_route
            and not scoped_modeling
            and not (_WRITE if write else _READ).fullmatch(path)
        ):
            raise SemanticaError("SEMANTICA_OPERATION_NOT_ALLOWED", 404)
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            raise SemanticaError("SEMANTICA_OPERATION_NOT_ALLOWED", 405)
        if shared_workbench:
            if starlink_workbench.selectable_scope(payload):
                raise SemanticaError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403)
            try:
                starlink_workbench.validate_query(method, path, query or {})
                starlink_workbench.validate_body(method, path, payload)
            except ValueError as exc:
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422) from exc
        elif native_workbench and conversation_route is None:
            try:
                starlink_legacy_workbench.prepare(method, path, payload, query or {})
            except PermissionError as exc:
                raise SemanticaError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403) from exc
            except ValueError as exc:
                raise SemanticaError("SEMANTICA_OPERATION_ID_REQUIRED", 422) from exc
        body = dict(payload or {})
        operation = (
            body.get("_native_operation_id")
            if native_workbench and write
            else body.get("operation_id")
            if write
            else None
        )
        if write and (
            not isinstance(operation, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,120}", operation)
        ):
            raise SemanticaError("SEMANTICA_OPERATION_ID_REQUIRED", 422)
        if "workspace_id" in body or "workspace_ids" in body:
            raise SemanticaError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403)
        allowed_query = {
            "limit",
            "offset",
            "after",
            "entity_id",
            "segment_offset",
            "segment_limit",
            "version_id",
            "start",
            "end",
            "length",
            "page_number",
            "expected_sha256",
            "expected_origin_revision",
            "expected_version_id",
            "warehouse_id",
            "keyword",
            "path",
        }
        if method == "GET" and re.fullmatch(r"/documents/[a-zA-Z0-9_-]{1,128}", path):
            allowed_query |= BLOCK_QUERY
            try:
                validate_block_page(query or {})
            except ValueError as exc:
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422) from exc
        if conversation_route is not None:
            allowed_query = set(conversation_route[4])
        elif native_workbench:
            contract = starlink_workbench if shared_workbench else starlink_legacy_workbench
            allowed_query = set(contract.query_keys(method, path) or ())
        if set(query or {}) - allowed_query:
            raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
        if searching:
            keys = {"query", "document_ids", "entity_types", "limit"}
            if warehouse_id is not None and not self.team:
                keys.add("annotation_search")
            if set(body) - keys:
                raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
            if "annotation_search" in body:
                try:
                    annotation_contract.AnnotationSearch.model_validate(body["annotation_search"])
                except ValueError as exc:
                    raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422) from exc
            body["delivery_mode"] = "masked"
        if method == "PATCH" and (
            path.startswith("/imports/") or path.startswith("/warehouses/imports/")
        ):
            body.pop("operation_id")
        timeout = 285 if scoped_modeling and method == "POST" and path == "/modeling/answer-suggestions" else operation_timeout(path)
        headers = self.headers(operation, warehouse_id, owner_view=path == "/owner/graph", ttl=grant_ttl(timeout))
        upstream_path = modeling_contract.upstream_path(path, headers) if scoped_modeling else path
        try:
            async with (
                asyncio.timeout(timeout),
                httpx.AsyncClient(
                    timeout=timeout,
                    follow_redirects=False,
                    trust_env=False,
                ) as client,
            ):
                response = await client.request(
                    method,
                    self.base_url + "/api/integration" + upstream_path,
                    headers=headers,
                    params=query,
                    json=body if method != "GET" else None,
                )
        except (TimeoutError, httpx.TimeoutException):
            raise SemanticaError("SEMANTICA_SERVICE_TIMEOUT", 504) from None
        except httpx.HTTPError:
            raise SemanticaError("SEMANTICA_SERVICE_UNAVAILABLE") from None
        if renaming and response.status_code == 405:
            raise SemanticaError("SEMANTICA_UPGRADE_REQUIRED", 409)
        return self.decode(response, native_workbench=native_workbench or onboarding_root or scoped_modeling)

    async def search(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.request("POST", "/search", payload=payload)

    async def public_read(
        self,
        method: str,
        path: str,
        token: str,
        *,
        payload: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        try:
            with request_guard(self.maintenance_home, method, "/api/open/v1" + path):
                return await self._public_read(method, path, token, payload=payload, query=query)
        except MaintenanceError:
            raise SemanticaError("SEMANTICA_MAINTENANCE") from None

    async def _public_read(
        self,
        method: str,
        path: str,
        token: str,
        *,
        payload: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if (
            not _PUBLIC.fullmatch(path)
            or method != ("POST" if path == "/search" or path.startswith("/reasoning/") else "GET")
            or not isinstance(token, str)
            or not re.fullmatch(r"xg_[A-Za-z0-9_-]{30,80}", token)
        ):
            raise SemanticaError("ACCESS_KEY_INVALID", 403)
        if set(query or {}) - {"limit", "offset", "entity_id"}:
            raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
        if payload is not None and set(payload) - (
            {"arguments"}
            if path.startswith("/reasoning/")
            else {
                "query",
                "document_ids",
                "entity_types",
                "limit",
            }
        ):
            raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
        try:
            async with httpx.AsyncClient(
                timeout=320 if path.startswith("/reasoning/") else 90,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = await client.request(
                    method,
                    self.base_url + "/api/open/v1" + path,
                    headers={"Authorization": "Bearer " + token},
                    params=query,
                    json=payload if method == "POST" else None,
                )
        except httpx.HTTPError:
            raise SemanticaError("SEMANTICA_SERVICE_UNAVAILABLE") from None
        if response.status_code == 401:
            raise SemanticaError("ACCESS_KEY_INVALID", 403)
        return self.decode(response, public=True)

    @staticmethod
    def decode(response: httpx.Response, *, native_workbench: bool = False, public: bool = False) -> dict[str, Any]:
        if response.status_code == 401:
            # Service authentication failure must never revoke the WANX user's Host session.
            raise SemanticaError("SEMANTICA_SERVICE_AUTH_FAILED")
        if response.status_code >= 400 or 300 <= response.status_code < 400:
            try:
                error = response.json()
                detail = error.get("detail")
                # Preserve only the known legacy hint; arbitrary detail may contain secrets.
                if detail == "当前模型尚不可用或需要重新确认，请打开模型与处理":
                    raise SemanticaError("MODEL_UNAVAILABLE", response.status_code, detail)
                error = detail if isinstance(detail, dict) else error
                if not public and (import_code := private_import_error(response.status_code, error)):
                    raise SemanticaError(import_code, response.status_code)
                if not public and (search_code := private_search_error(response.status_code, error)):
                    raise SemanticaError(search_code, response.status_code)
                code = error.get("code", "")
                if isinstance(code, str) and (native_workbench or code in {
                    "MODELING_ROUND_ATOMIC_REQUIRED", "MODELING_ROUND_SINGLE_MATERIAL",
                }) and code in (
                    conversation_contract.ERROR_CODES | modeling_contract.ERROR_CODES
                ) and 400 <= response.status_code < 600:
                    # Keep conflict/busy/recovery distinctions for both host
                    # adapters, but never expose upstream diagnostics.
                    raise SemanticaError(code, response.status_code)
                if code == "MODELING_CONFIRMATION_REQUIRED":
                    raise SemanticaError(code, 409)
                if native_workbench and owner_error(code) and 400 <= response.status_code < 600:
                    raise SemanticaError(code, response.status_code, owner_error_message(code, error.get("message")))
                if isinstance(code, str) and re.fullmatch(
                    r"(?:WAREHOUSE|MIGRATION|ACCESS_KEY|MODEL|SKILL|REASONING)_[A-Z_]+", code
                ):
                    message = error.get("message")
                    raise SemanticaError(
                        code,
                        response.status_code,
                        message if isinstance(message, str) and len(message) <= 200 else None,
                    )
            except (ValueError, AttributeError):
                pass
            codes = {
                403: "SEMANTICA_RESOURCE_FORBIDDEN",
                404: "SEMANTICA_RESOURCE_NOT_FOUND",
                409: "SEMANTICA_VERSION_CONFLICT",
                413: "SEMANTICA_FILE_TOO_LARGE",
                422: "SEMANTICA_INVALID_REQUEST",
            }
            raise SemanticaError(
                codes.get(response.status_code, "SEMANTICA_SERVICE_ERROR"),
                response.status_code if response.status_code in codes else 503,
            )
        try:
            value = response.json()
            if not isinstance(value, dict):
                raise ValueError("not an object")
        except ValueError:
            raise SemanticaError("SEMANTICA_INVALID_RESPONSE") from None
        return value
