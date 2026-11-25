"""Bridge-to-service authentication for optional box services.

The service proves possession of its installation key once, then uses a short
lived Bridge-signed JWT.  User and space context is minted by Bridge and is
never accepted from an untrusted client header.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

import jwt
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from .config import BridgeAuthError
from .service_registry import SERVICE_ID, ServiceRecord, ServiceRegistry
from .service_task_state import ServiceTaskState

SERVICE_TOKEN_ISSUER = "wanx-bridge"
SERVICE_TOKEN_TTL = 300
MAX_NONCE_LENGTH = 256
DEFAULT_SCOPE = frozenset({"workbench:read", "workbench:write"})
ALLOWED_SCOPES = frozenset({*DEFAULT_SCOPE, "workbench:browser"})
TASK_TOKEN_TTL = 300
TASK_MIN_TTL = 30
TASK_MAX_TTL = 300
TASK_MAX_LIFETIME = 3600
_TASK_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")


@dataclass
class TaskLease:
    task_id: str
    service_id: str
    current_jti: str
    box_id: str
    user_id: str
    space_id: str | None
    scope: tuple[str, ...]
    max_expires_at: float
    renewal_digest: str
    revoked: bool = False
    authority: dict[str, Any] | None = None


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode_b64(value: str) -> bytes:
    if not isinstance(value, str) or len(value) > 1024:
        raise ValueError
    decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    if not decoded:
        raise ValueError
    return decoded


def service_proof_payload(service_id: str, protocol_version: int, nonce: str) -> bytes:
    """Canonical bytes signed by a boxd installation key."""
    if (
        not isinstance(service_id, str)
        or type(protocol_version) is not int
        or not isinstance(nonce, str)
        or not 1 <= len(nonce) <= MAX_NONCE_LENGTH
    ):
        raise ValueError("invalid service proof")
    return f"wanx-service-session-v1\n{service_id}\n{protocol_version}\n{nonce}".encode()


def service_proof_signature(private_key: Ed25519PrivateKey, service_id: str, protocol_version: int, nonce: str) -> str:
    return _b64(private_key.sign(service_proof_payload(service_id, protocol_version, nonce)))


def public_key_fingerprint(key: Ed25519PublicKey) -> str:
    return hashlib.sha256(
        key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    ).hexdigest()


def _claims_context(value: Mapping[str, Any]) -> tuple[str | None, str | None]:
    user_id = value.get("userId")
    space_id = value.get("spaceId")
    if user_id is not None and (not isinstance(user_id, str) or not 1 <= len(user_id) <= 256):
        raise BridgeAuthError("SERVICE_CONTEXT_INVALID", 400)
    if space_id is not None and (not isinstance(space_id, str) or not 1 <= len(space_id) <= 256):
        raise BridgeAuthError("SERVICE_CONTEXT_INVALID", 400)
    return user_id, space_id


def _scopes(value: Iterable[str], allowed: frozenset[str] = ALLOWED_SCOPES) -> list[str]:
    try:
        scopes = sorted(set(value))
    except (TypeError, ValueError):
        raise BridgeAuthError("SERVICE_SCOPE_INVALID", 403) from None
    if not scopes or any(not isinstance(item, str) or item not in allowed for item in scopes):
        raise BridgeAuthError("SERVICE_SCOPE_INVALID", 403)
    return scopes


class ServiceSessionVerifier:
    def __init__(
        self,
        registry: ServiceRegistry,
        signing_key: Ed25519PrivateKey,
        *,
        issuer: str = SERVICE_TOKEN_ISSUER,
        ttl: int = SERVICE_TOKEN_TTL,
        now: callable = time.time,
        state_path: Path | None = None,
        authority_validator: callable | None = None,
    ) -> None:
        self.registry = registry
        self.signing_key = signing_key
        self.issuer = issuer
        self.ttl = max(30, min(int(ttl), SERVICE_TOKEN_TTL))
        self.now = now
        self._nonces: dict[tuple[str, str], float] = {}
        # Delegated tokens never carry the upstream Octop credential.  The
        # short-lived in-memory binding lets the capability broker use the
        # already authenticated platform session without exposing that token
        # to huohua-boxd or to JWT consumers.
        self._delegated_upstream: dict[str, tuple[str, float]] = {}
        self._tasks: dict[str, TaskLease] = {}
        self._authority_validator = authority_validator
        self._delegated_authority: dict[str, tuple[dict[str, Any] | None, float | None]] = {}
        self._state = None
        self.recovery_error: str | None = None
        if state_path:
            try:
                self._state = ServiceTaskState(state_path, signing_key.private_bytes_raw())
                for item in self._state.read():
                    lease = TaskLease(**item["lease"])
                    if lease.max_expires_at <= float(self.now()):
                        continue
                    self._tasks[lease.task_id] = lease
                    if not lease.revoked:
                        self._delegated_upstream[lease.current_jti] = (
                            item["upstream"],
                            lease.max_expires_at,
                        )
            except (BridgeAuthError, KeyError, TypeError, ValueError, OSError):
                # An optional service's journal must not prevent base Bridge
                # login or other applications from starting. Never overwrite it.
                self._tasks.clear()
                self._delegated_upstream.clear()
                self.recovery_error = "TASK_STATE_INVALID"

    def _assert_task_state(self) -> None:
        if self.recovery_error:
            raise BridgeAuthError(self.recovery_error, 503)

    def _commit_tasks(self, tasks, upstream) -> None:
        self._assert_task_state()
        if self._state:
            self._state.write(
                [
                    {
                        "lease": asdict(lease),
                        "upstream": upstream.get(lease.current_jti, (None, 0))[0],
                    }
                    for lease in tasks.values()
                ]
            )
        # A failed durable write must leave the last issued credential retryable.
        self._tasks, self._delegated_upstream = tasks, upstream

    def _assert_task_authority(self, lease: TaskLease) -> None:
        self._record(lease.service_id)
        if self._authority_validator:
            if lease.authority is None:
                raise BridgeAuthError("TASK_AUTHORITY_REQUIRED", 401)
            self._authority_validator(lease.authority)

    def _record(self, service_id: str) -> ServiceRecord:
        record = self.registry.get(service_id)
        if record is None or not record.enabled:
            raise BridgeAuthError("SERVICE_NOT_INSTALLED", 404)
        return record

    def _public_key(self, record: ServiceRecord) -> Ed25519PublicKey:
        try:
            return Ed25519PublicKey.from_public_bytes(record.public_key_bytes())
        except (ValueError, TypeError) as exc:
            raise BridgeAuthError("SERVICE_REGISTRY_PUBLIC_KEY_INVALID", 503) from exc

    def _encode(self, claims: dict[str, Any]) -> str:
        return jwt.encode(
            claims,
            self.signing_key,
            algorithm="EdDSA",
            headers={"kid": public_key_fingerprint(self.signing_key.public_key())},
        )

    def _cleanup_tasks(self, now: float) -> None:
        expired = [
            task_id
            for task_id, lease in self._tasks.items()
            if lease.max_expires_at <= now
        ]
        for task_id in expired:
            lease = self._tasks.pop(task_id)
            self._delegated_upstream.pop(lease.current_jti, None)

    @staticmethod
    def _task_id(value: Any) -> str:
        if not isinstance(value, str) or _TASK_ID.fullmatch(value) is None:
            raise BridgeAuthError("TASK_ID_INVALID", 400)
        return value

    def _task(self, task_id: str, *, claims: Mapping[str, Any]) -> TaskLease:
        self._assert_task_state()
        lease = self._tasks.get(task_id)
        if lease is None or lease.service_id != claims.get("serviceId"):
            raise BridgeAuthError("TASK_NOT_FOUND", 404)
        if lease.revoked:
            raise BridgeAuthError("TASK_REVOKED", 401)
        if lease.current_jti != claims.get("jti"):
            raise BridgeAuthError("TASK_TOKEN_SUPERSEDED", 401)
        if lease.max_expires_at <= float(self.now()):
            raise BridgeAuthError("TASK_EXPIRED", 401)
        self._assert_task_authority(lease)
        return lease

    @staticmethod
    def _renewal_digest(value: str) -> str:
        if not isinstance(value, str) or not value.startswith("wanx-task-renewal."):
            raise BridgeAuthError("TASK_TOKEN_INVALID", 401)
        return hashlib.sha256(value.encode()).hexdigest()

    def _authorize_task_credential(
        self, token: str, *, task_id: str
    ) -> tuple[TaskLease, dict[str, Any] | None]:
        self._assert_task_state()
        task_id = self._task_id(task_id)
        try:
            claims = self.verify(token, service_id=SERVICE_ID)
        except BridgeAuthError as exc:
            lease = self._tasks.get(task_id)
            if (
                lease is None
                or not isinstance(token, str)
                or not token.startswith("wanx-task-renewal.")
            ):
                raise exc
            if not hmac.compare_digest(lease.renewal_digest, self._renewal_digest(token)):
                raise exc
            if lease.revoked:
                raise BridgeAuthError("TASK_REVOKED", 401) from None
            if lease.max_expires_at <= float(self.now()):
                raise BridgeAuthError("TASK_EXPIRED", 401) from None
            self._assert_task_authority(lease)
            return lease, None
        if claims.get("taskId") != task_id:
            raise BridgeAuthError("TASK_CONTEXT_FORBIDDEN", 403)
        return self._task(task_id, claims=claims), claims

    def issue(
        self,
        service_id: str,
        *,
        protocol_version: int,
        nonce: str,
        signature: str,
        box_id: str | None = None,
        user_id: str | None = None,
        space_id: str | None = None,
        scope: Iterable[str] | None = None,
    ) -> dict[str, Any]:
        record = self._record(service_id)
        if type(protocol_version) is not int or protocol_version != record.protocol_version:
            raise BridgeAuthError("SERVICE_PROTOCOL_INCOMPATIBLE", 409)
        if not isinstance(nonce, str) or not 1 <= len(nonce) <= MAX_NONCE_LENGTH:
            raise BridgeAuthError("SERVICE_PROOF_INVALID", 401)
        key = (service_id, nonce)
        now = float(self.now())
        self._nonces = {item: expires for item, expires in self._nonces.items() if expires > now}
        if key in self._nonces:
            raise BridgeAuthError("SERVICE_PROOF_REPLAY", 401)
        try:
            self._public_key(record).verify(_decode_b64(signature), service_proof_payload(service_id, protocol_version, nonce))
        except (InvalidSignature, ValueError, TypeError, UnicodeError):
            raise BridgeAuthError("SERVICE_PROOF_INVALID", 401) from None
        self._nonces[key] = now + self.ttl
        if box_id is None:
            box_id = str(record.uid)
        if not isinstance(box_id, str) or not 1 <= len(box_id) <= 256:
            raise BridgeAuthError("SERVICE_CONTEXT_INVALID", 400)
        context = {"userId": user_id, "spaceId": space_id}
        user_id, space_id = _claims_context(context)
        scopes = _scopes(scope if scope is not None else record.bootstrap_scopes, record.allowed_scopes)
        issued = int(now)
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "aud": record.token_audience,
            "serviceId": service_id,
            "boxId": box_id,
            "protocolVersion": protocol_version,
            "iat": issued,
            "exp": issued + self.ttl,
            "jti": secrets.token_urlsafe(18),
            "scope": scopes,
        }
        if user_id is not None:
            claims["userId"] = user_id
        if space_id is not None:
            claims["spaceId"] = space_id
        token = self._encode(claims)
        return {"access_token": token, "token_type": "Bearer", "expires_in": self.ttl, "claims": claims}

    def issue_delegated(
        self,
        service_id: str,
        *,
        protocol_version: int,
        box_id: str,
        user_id: str,
        space_id: str | None,
        scope: Iterable[str],
        upstream_token: str | None = None,
        authority: dict[str, Any] | None = None,
        upstream_expires_at: float | None = None,
        homeai_space_destination: dict[str, Any] | None = None,
    ) -> str:
        record = self._record(service_id)
        now = int(self.now())
        self._delegated_authority = {
            jti: binding
            for jti, binding in self._delegated_authority.items()
            if self._delegated_upstream.get(jti, (None, 0))[1] > now
        }
        if type(protocol_version) is not int or protocol_version != record.protocol_version:
            raise BridgeAuthError("SERVICE_PROTOCOL_INCOMPATIBLE", 409)
        if not isinstance(box_id, str) or not 1 <= len(box_id) <= 256:
            raise BridgeAuthError("SERVICE_CONTEXT_INVALID", 400)
        user_id, space_id = _claims_context({"userId": user_id, "spaceId": space_id})
        scopes = _scopes(scope, record.allowed_scopes)
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "aud": record.token_audience,
            "serviceId": service_id,
            "boxId": box_id,
            "protocolVersion": protocol_version,
            "iat": now,
            "exp": now + self.ttl,
            "jti": secrets.token_urlsafe(18),
            "scope": scopes,
            "userId": user_id,
        }
        if space_id is not None:
            claims["spaceId"] = space_id
        if homeai_space_destination is not None:
            if service_id != "wanx.homeai" or space_id != "personal":
                raise BridgeAuthError("HOMEAI_SPACE_ACCESS_DENIED", 403)
            claims["homeaiSpaceDestination"] = homeai_space_destination
        token = self._encode(claims)
        if upstream_token is not None:
            if not isinstance(upstream_token, str) or not upstream_token:
                raise BridgeAuthError("SERVICE_CONTEXT_INVALID", 400)
            self._delegated_upstream[claims["jti"]] = (upstream_token, float(claims["exp"]))
        self._delegated_authority[claims["jti"]] = (authority, upstream_expires_at)
        return token

    def issue_task(
        self,
        parent_token: str,
        *,
        task_id: str | None = None,
        ttl_seconds: int = TASK_TOKEN_TTL,
        scope: Iterable[str] | None = None,
    ) -> dict[str, Any]:
        """Create a bounded task lease under an already delegated user token."""
        self._assert_task_state()
        parent = self.verify(parent_token, service_id=SERVICE_ID)
        if parent.get("taskId") is not None:
            raise BridgeAuthError("TASK_NESTING_FORBIDDEN", 403)
        user_id, space_id = _claims_context(parent)
        if user_id is None:
            raise BridgeAuthError("SERVICE_CONTEXT_REQUIRED", 403)
        try:
            ttl = int(ttl_seconds)
        except (TypeError, ValueError):
            raise BridgeAuthError("TASK_TTL_INVALID", 400) from None
        if not TASK_MIN_TTL <= ttl <= TASK_MAX_TTL:
            raise BridgeAuthError("TASK_TTL_INVALID", 400)
        task_id = self._task_id(task_id or "task-" + secrets.token_urlsafe(18))
        now = float(self.now())
        self._cleanup_tasks(now)
        if task_id in self._tasks:
            raise BridgeAuthError("TASK_EXISTS", 409)
        parent_scope = set(parent["scope"])
        scopes = _scopes(scope if scope is not None else parent_scope)
        if not set(scopes).issubset(parent_scope):
            raise BridgeAuthError("SERVICE_SCOPE_FORBIDDEN", 403)
        upstream_token = self.delegated_upstream_token(parent_token)
        if upstream_token is None:
            raise BridgeAuthError("SERVICE_CONTEXT_EXPIRED", 401)
        authority, upstream_expiry = self._delegated_authority.get(parent["jti"], (None, None))
        if self._authority_validator:
            if authority is None:
                raise BridgeAuthError("TASK_AUTHORITY_REQUIRED", 401)
            self._authority_validator(authority)
        if len(self._tasks) >= 4096:
            raise BridgeAuthError("TASK_STATE_CAPACITY", 503)
        max_expires_at = min(
            now + TASK_MAX_LIFETIME,
            upstream_expiry if upstream_expiry is not None else now + TASK_MAX_LIFETIME,
        )
        if max_expires_at <= now:
            raise BridgeAuthError("SERVICE_CONTEXT_EXPIRED", 401)
        expires_at = min(now + ttl, max_expires_at)
        jti = secrets.token_urlsafe(18)
        renewal_token = "wanx-task-renewal." + secrets.token_urlsafe(32)
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "aud": "wanx-bridge",
            "serviceId": SERVICE_ID,
            "boxId": parent["boxId"],
            "protocolVersion": parent["protocolVersion"],
            "iat": int(now),
            "exp": int(expires_at),
            "jti": jti,
            "scope": scopes,
            "userId": user_id,
            "taskId": task_id,
            "taskExp": int(max_expires_at),
            "parentJti": parent["jti"],
        }
        if space_id is not None:
            claims["spaceId"] = space_id
        token = self._encode(claims)
        lease = TaskLease(
            task_id,
            SERVICE_ID,
            jti,
            str(parent["boxId"]),
            user_id,
            space_id,
            tuple(scopes),
            max_expires_at,
            self._renewal_digest(renewal_token),
            authority=authority,
        )
        self._commit_tasks(
            {**self._tasks, task_id: lease},
            {**self._delegated_upstream, jti: (upstream_token, max_expires_at)},
        )
        return {
            "access_token": token,
            "token_type": "Bearer",
            "expires_in": max(0, int(expires_at - now)),
            "taskId": task_id,
            "expiresAt": int(expires_at),
            "taskExpiresAt": int(max_expires_at),
            "renewal_token": renewal_token,
            "claims": claims,
        }

    def renew_task(
        self,
        token: str,
        *,
        task_id: str,
        ttl_seconds: int = TASK_TOKEN_TTL,
    ) -> dict[str, Any]:
        task_id = self._task_id(task_id)
        lease, claims = self._authorize_task_credential(token, task_id=task_id)
        try:
            ttl = int(ttl_seconds)
        except (TypeError, ValueError):
            raise BridgeAuthError("TASK_TTL_INVALID", 400) from None
        if not TASK_MIN_TTL <= ttl <= TASK_MAX_TTL:
            raise BridgeAuthError("TASK_TTL_INVALID", 400)
        now = float(self.now())
        expires_at = min(now + ttl, lease.max_expires_at)
        if expires_at <= now:
            raise BridgeAuthError("TASK_EXPIRED", 401)
        jti = secrets.token_urlsafe(18)
        if claims is None:
            record = self._record(lease.service_id)
            renewed = {
                "iss": self.issuer,
                "aud": record.token_audience,
                "serviceId": lease.service_id,
                "boxId": lease.box_id,
                "protocolVersion": record.protocol_version,
                "scope": list(lease.scope),
                "userId": lease.user_id,
                "taskId": task_id,
                "parentJti": "renewal",
            }
            if lease.space_id is not None:
                renewed["spaceId"] = lease.space_id
        else:
            renewed = dict(claims)
        renewed.update({"iat": int(now), "exp": int(expires_at), "jti": jti})
        renewed["taskExp"] = int(lease.max_expires_at)
        new_token = self._encode(renewed)
        old_jti = lease.current_jti
        upstream_token = self._delegated_upstream.get(old_jti, (None, 0))[0]
        if not upstream_token:
            raise BridgeAuthError("SERVICE_CONTEXT_EXPIRED", 401)
        renewal_token = "wanx-task-renewal." + secrets.token_urlsafe(32)
        next_lease = replace(
            lease, current_jti=jti, renewal_digest=self._renewal_digest(renewal_token)
        )
        upstream = {key: value for key, value in self._delegated_upstream.items() if key != old_jti}
        upstream[jti] = (upstream_token, lease.max_expires_at)
        self._commit_tasks({**self._tasks, task_id: next_lease}, upstream)
        return {
            "access_token": new_token,
            "token_type": "Bearer",
            "expires_in": max(0, int(expires_at - now)),
            "taskId": task_id,
            "expiresAt": int(expires_at),
            "taskExpiresAt": int(lease.max_expires_at),
            "renewal_token": renewal_token,
            "claims": renewed,
        }

    def revoke_task(self, token: str, *, task_id: str) -> dict[str, Any]:
        task_id = self._task_id(task_id)
        lease, _ = self._authorize_task_credential(token, task_id=task_id)
        self._commit_tasks(
            {**self._tasks, task_id: replace(lease, revoked=True)},
            {
                key: value
                for key, value in self._delegated_upstream.items()
                if key != lease.current_jti
            },
        )
        return {"taskId": task_id, "revoked": True}

    def assert_platform_task_authority(self, original: Mapping[str, Any]) -> None:
        """Validate a live browser lease across JWT rotation, never across task identity."""
        task_id = self._task_id(original.get("taskId"))
        lease = self._tasks.get(task_id)
        if lease is None:
            raise BridgeAuthError("TASK_NOT_FOUND", 404)
        if (lease.box_id, lease.user_id, lease.space_id, lease.service_id) != (
            original.get("boxId"), original.get("userId"), original.get("spaceId"), original.get("serviceId")
        ) or "workbench:browser" not in lease.scope:
            raise BridgeAuthError("PLATFORM_TASK_MISMATCH", 403)
        self._task(task_id, claims={**original, "jti": lease.current_jti})
        upstream = self._delegated_upstream.get(lease.current_jti)
        if upstream is None or upstream[1] <= float(self.now()):
            raise BridgeAuthError("SERVICE_CONTEXT_EXPIRED", 401)

    def delegated_upstream_token(self, token: str) -> str | None:
        """Return the bound upstream credential while the delegated token lives."""
        try:
            claims = self.verify(token, service_id=SERVICE_ID)
        except BridgeAuthError:
            return None
        now = float(self.now())
        self._delegated_upstream = {
            jti: value for jti, value in self._delegated_upstream.items() if value[1] > now
        }
        value = self._delegated_upstream.get(claims.get("jti"))
        return value[0] if value else None

    def verify(self, token: str, *, service_id: str | None = None, required_scope: str | None = None) -> dict[str, Any]:
        if not isinstance(token, str) or len(token) > 16384:
            raise BridgeAuthError("SERVICE_TOKEN_INVALID", 401)
        try:
            header = jwt.get_unverified_header(token)
            claims = jwt.decode(token, self.signing_key.public_key(), algorithms=["EdDSA"], issuer=self.issuer, audience="wanx-bridge", options={"require": ["iss", "aud", "serviceId", "boxId", "protocolVersion", "iat", "exp", "jti", "scope"]})
            if (
                header.get("alg") != "EdDSA"
                or header.get("kid") != public_key_fingerprint(self.signing_key.public_key())
                or claims.get("aud") != "wanx-bridge"
            ):
                raise ValueError
            if service_id is not None and claims.get("serviceId") != service_id:
                raise ValueError
            record = self._record(claims.get("serviceId"))
            if (
                type(claims.get("protocolVersion")) is not int
                or claims.get("protocolVersion") != record.protocol_version
                or not isinstance(claims.get("scope"), list)
            ):
                raise ValueError
            scope = claims["scope"]
            if (
                not scope
                or any(not isinstance(item, str) or item not in record.allowed_scopes for item in scope)
                or len(set(scope)) != len(scope)
            ):
                raise ValueError
            if required_scope is not None and required_scope not in claims["scope"]:
                raise BridgeAuthError("SERVICE_SCOPE_FORBIDDEN", 403)
            _claims_context(claims)
            task_id = claims.get("taskId")
            if task_id is not None:
                task_id = self._task_id(task_id)
                self._cleanup_tasks(float(self.now()))
                self._task(task_id, claims=claims)
            # Platform sessions bind to verified ownership, never request identity.
            if task_id is not None:
                authority = self._tasks[task_id].authority
            else:
                authority = self._delegated_authority.get(claims["jti"], (None, None))[0]
            if authority is not None:
                if self._authority_validator:
                    self._authority_validator(authority)
                claims["ownershipEpoch"] = authority.get("ownership_epoch")
            return dict(claims)
        except BridgeAuthError:
            raise
        except (jwt.PyJWTError, ValueError, TypeError, KeyError) as exc:
            raise BridgeAuthError("SERVICE_TOKEN_INVALID", 401) from exc

    @staticmethod
    def bearer(headers: Mapping[str, Any]) -> str:
        values = headers.getlist("authorization") if hasattr(headers, "getlist") else [headers.get("authorization")]
        if len(values) != 1 or not isinstance(values[0], str):
            raise BridgeAuthError("SERVICE_TOKEN_REQUIRED", 401)
        scheme, separator, token = values[0].partition(" ")
        if scheme.lower() != "bearer" or not separator:
            raise BridgeAuthError("SERVICE_TOKEN_REQUIRED", 401)
        if not token or token.strip() != token:
            raise BridgeAuthError("SERVICE_TOKEN_INVALID", 401)
        return token
