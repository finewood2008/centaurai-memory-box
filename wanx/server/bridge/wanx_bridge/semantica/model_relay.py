"""Private STARLINK model callback with core-authorized team requests."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import sqlite3
import time
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import jsonschema
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from referencing.exceptions import Unresolvable
from starlette.requests import ClientDisconnect

from ..admin_client import BridgeUpstreamError
from ..model_reasoning import reasoning_metadata
from ..oidc import loopback_origin
from .desktop import (
    APPS,
    DesktopConfig,
    DesktopError,
    parse_model_output,
    request_json,
    strict_json,
)
from .desktop_routes import bounded_body, live_request
from .model_budget import InvalidModelOutputLimit, output_budget, truncated
from .model_options import inference_options, thinking_modes, thinking_overrides
from .output_diagnostics import (
    diagnostic,
    safe_output_metadata,
    sanitize_diagnostic,
    schema_diagnostic,
    termination_metadata,
)


def _invalid_output(kind, *, path=(), validator=None, metadata=None):
    error = DesktopError("MODEL_INVALID_OUTPUT", 502)
    error.output_diagnostic = diagnostic(kind, source="bridge", path=path, validator=validator)
    error.output_metadata = safe_output_metadata(metadata)
    return error


def _schema_failure(exc):
    error = _invalid_output("schema_validation")
    error.output_diagnostic = schema_diagnostic(exc)
    return error


_LOGGER = logging.getLogger(__name__)


def _log_model_failure(error: Exception, job_id: str | None, nonce: str) -> None:
    """Same closed diagnostic schema as core, without importing that wheel."""
    codes = {
        "MODEL_CALL_FAILED",
        "MODEL_BILLING_REQUIRED",
        "MODEL_INVALID_OUTPUT",
        "MODEL_INVALID_REQUEST",
        "MODEL_CONFIG_INVALID",
    }
    public = (
        error.code
        if isinstance(error, DesktopError) and error.code in codes
        else "MODEL_SERVICE_UNAVAILABLE"
        if isinstance(
            error, (httpx.HTTPError, BridgeUpstreamError, TimeoutError, OSError, sqlite3.Error)
        )
        else "UNKNOWN"
    )
    status = (
        getattr(error, "_model_upstream_status", None) if isinstance(error, DesktopError) else None
    )
    if type(status) is not int or not 100 <= status <= 599:
        status = None
    category = (
        "upstream_http"
        if status is not None
        else "invalid_output"
        if public == "MODEL_INVALID_OUTPUT"
        else "unknown"
    )
    if isinstance(error, (httpx.TimeoutException, TimeoutError)):
        category = "timeout"
    elif isinstance(error, httpx.RequestError):
        category = "network"
    job = (
        job_id
        if isinstance(job_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id)
        else None
    )
    _LOGGER.warning(
        encoded(
            {
                "event": "starlink_model_failure",
                "timestamp": int(time.time()),
                "publicCode": public,
                "category": category,
                "upstreamStatus": status,
                "jobHash": hashlib.sha256(job.encode()).hexdigest() if job else None,
                "requestHash": hashlib.sha256(nonce.encode()).hexdigest(),
                **({"outputDiagnostic": detail} if (public == "MODEL_INVALID_OUTPUT"
                    and (detail := sanitize_diagnostic(getattr(error, "output_diagnostic", None)))) else {}),
                **({"outputMetadata": metadata} if (public == "MODEL_INVALID_OUTPUT"
                    and (metadata := safe_output_metadata(getattr(error, "output_metadata", None)))) else {}),
            }
        )
    )


def encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def local(url: str) -> bool:
    hostname = urlsplit(url).hostname
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname or "").is_loopback
    except ValueError:
        return False


class ModelLedger:
    """Bridge-owned replay and usage records; contains no prompts or model credentials."""

    def __init__(self, directory: Path):
        self.path = directory / "semantica-models.sqlite3"

    def record(self, nonce: str | None = None, usage: dict | None = None) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with sqlite3.connect(self.path, timeout=10) as db:
            self.path.chmod(0o600)
            db.executescript("""
                CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, observed REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, recorded REAL NOT NULL, payload TEXT NOT NULL);
            """)
            now = time.time()
            if nonce is not None:
                db.execute("DELETE FROM nonces WHERE observed < ?", (now - 180,))
                try:
                    db.execute("INSERT INTO nonces VALUES (?, ?)", (nonce, now))
                except sqlite3.IntegrityError as exc:
                    raise DesktopError("MODEL_REPLAY_DENIED", 409) from exc
            if usage is not None:
                db.execute(
                    "INSERT INTO usage(recorded,payload) VALUES (?, ?)", (now, encoded(usage))
                )


class ModelRelay:
    def __init__(
        self,
        admin,
        config_file: Path,
        state_dir: Path,
        *,
        service_url: str | None = None,
        box_id: str | None = None,
        transport=None,
        gate_config=None,
    ):
        self.admin, self.config_file, self.service_url = admin, config_file, service_url
        self.box_id = box_id
        self.ledger = ModelLedger(state_dir)
        self.client = httpx.AsyncClient(
            trust_env=False, follow_redirects=False, transport=transport
        )
        self.slots = asyncio.Semaphore(4)
        self.users: dict[int | str, tuple[asyncio.Semaphore, int]] = {}
        self.pending = 0
        self.required = None
        if gate_config is not None:
            from .required_models import RequiredModelRelay

            self.required = RequiredModelRelay(self, gate_config)

    async def close(self):
        if self.required is not None:
            await self.required.close()
        await self.client.aclose()

    async def _team_callback(self, request: Request, raw: bytes) -> JSONResponse:
        # Team ownership and the initiating administrator are distinct. The core
        # verifies the original signature and owns admin/job checks and auditing.
        origin = loopback_origin(self.admin.base_url)
        headers = {
            name: request.headers[name]
            for name in ("x-starklink-time", "x-starklink-nonce", "x-starklink-signature")
        }
        headers["content-type"] = "application/json"

        async def work():
            outgoing = self.client.build_request(
                "POST",
                origin + "/internal/starklink/models",
                headers=headers,
                content=raw,
                timeout=320,
            )
            outgoing.headers.pop("cookie", None)
            response = await self.client.send(outgoing, stream=True)
            try:
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 2 * 1024 * 1024:
                        raise DesktopError("MODEL_SERVICE_UNAVAILABLE")
                try:
                    value = strict_json(data)
                    if not isinstance(value, dict):
                        raise ValueError()
                except ValueError as exc:
                    raise DesktopError("MODEL_SERVICE_UNAVAILABLE") from exc
                # Provider budget/finish metadata belongs to host logs only.
                value.pop("output_metadata", None)
                value.pop("outputMetadata", None)
                if "output_diagnostic" in value:
                    detail = sanitize_diagnostic(value.pop("output_diagnostic"))
                    if response.status_code == 502 and value.get("code") == "MODEL_INVALID_OUTPUT" and detail:
                        value["output_diagnostic"] = detail
                return JSONResponse(
                    value,
                    status_code=response.status_code,
                    headers={"Cache-Control": "no-store"},
                )
            finally:
                await response.aclose()

        drained = asyncio.Event()
        drained.set()
        async with asyncio.timeout(320):
            return await live_request(request, work(), asyncio.Event().wait(), drained)

    async def _get(self, path: str) -> list:
        response = await self.admin._admin("GET", path)
        if response.status_code != 200:
            raise DesktopError("MODEL_SERVICE_UNAVAILABLE")
        try:
            value = response.json()
        except ValueError as exc:
            raise DesktopError("MODEL_SERVICE_UNAVAILABLE") from exc
        if not isinstance(value, list):
            raise DesktopError("MODEL_SERVICE_UNAVAILABLE")
        return value

    async def _user(self, user_id: int):
        user = next((u for u in await self._get("/api/users") if u.get("id") == user_id), None)
        if (
            not user
            or user.get("disabled")
            or (
                user.get("role") != "admin"
                and "knowledge_bases" not in (user.get("permissions") or [])
            )
        ):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)

    async def _catalog(self):
        providers = {p["id"]: p for p in await self._get("/api/admin/providers")}
        models = await self._get("/api/providers/resolved")
        items = []
        for model in models:
            provider = providers.get(model.get("provider_id"))
            if not provider or not provider.get("enabled") or "text" not in model.get("input", []):
                continue
            if model.get("reasoning_config") is not None:
                try:
                    model = {**model, "reasoning_config": reasoning_metadata(model["reasoning_config"])}
                except (ValueError, TypeError):
                    raise DesktopError("MODEL_CONFIG_INVALID", 409) from None
            base = provider.get("base_url") or (
                "https://api.openai.com/v1" if provider.get("kind") == "openai" else ""
            )
            supported = provider.get("kind") in {"openai", "ollama"} and bool(base)
            location = (
                "local"
                if local(base)
                and not (provider.get("note") or "").startswith("wanx-admin-model-provider-v1:")
                else "external"
            )
            # Bind consent to this model's execution and destination contract.
            # Provider-wide model discovery and display metadata are not changes
            # to where this selected model sends material. Managed proxy keys
            # retain a trusted upstream authorization binding across restarts.
            revision = hashlib.sha256(
                encoded(
                    [
                        "wanx-model-contract-v2",
                        {key: provider.get(key) for key in ("id", "kind", "api_key")},
                        base,
                        {
                            **{key: model.get(key)
                               for key in ("model", "input", "context_window", "max_output_tokens")},
                            **({"reasoning_config": model["reasoning_config"]}
                               if model.get("reasoning_config") is not None else {}),
                        },
                        location,
                    ]
                ).encode()
            ).hexdigest()
            items.append(
                {
                    "id": f"{provider['id']}:{model['model']}",
                    "provider_id": provider["id"],
                    "model": model["model"],
                    "name": model.get("name", model["model"]),
                    "provider": provider["name"],
                    "location": location,
                    "revision": revision,
                    "available": supported,
                    "capabilities": ["text", "json_check_required"] if supported else [],
                    "context_window": model.get("context_window"),
                    "max_output_tokens": model.get("max_output_tokens"),
                    "reasoning_config": model.get("reasoning_config"),
                    "inference_options": {"thinking_modes": thinking_modes(provider, model)},
                }
            )
        return items, providers

    async def catalog_result(self, items):
        response = await self.admin._admin("GET", "/api/providers/application-defaults")
        if response.status_code == 404:
            policy = {"managed": False, "defaults": {}}
        elif response.status_code == 200:
            policy = response.json()
        else:
            raise DesktopError("MODEL_SERVICE_UNAVAILABLE")
        configured = policy.get("defaults", {}).get("starlink")
        reference = configured.get("model_ref") if configured and configured.get("available") else None
        if configured is None:
            active = await self.admin._admin("GET", "/api/providers/active-model")
            if active.status_code != 200:
                raise DesktopError("MODEL_SERVICE_UNAVAILABLE")
            value = active.json()
            if value.get("provider_name") and value.get("model"):
                reference = value["provider_name"] + "/" + value["model"]
        default = next((item for item in items if item["available"]
                        and f"{item['provider']}/{item['model']}" == reference), None)
        return {"items": items, "checked_at": time.time(), "managed": policy["managed"], "default": default}

    async def _authorize_job(
        self, config: DesktopConfig, actor: tuple[str, int], body: dict, selection: dict, nonce: str
    ):
        app, user_id = actor
        if body.get("purpose") not in {"extraction", "sensitive"}:
            raise DesktopError("MODEL_PURPOSE_DENIED", 403)
        if not isinstance(body.get("job_id"), str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{1,128}", body["job_id"]
        ):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        payload = {
            "operation_id": nonce,
            "job_id": body["job_id"],
            "purpose": body["purpose"],
            "model_id": selection["id"],
            "model_revision": selection["revision"],
            **({"inference_options": inference_options(body)}
               if inference_options(body)["thinking_mode"] != "auto" else {}),
        }
        _, value = await request_json(
            self.client,
            "POST",
            config.service_url + "/api/integration/processing/authorize",
            headers=config.headers(user_id, app, nonce),
            payload=payload,
            timeout=10,
        )
        options = inference_options(body)
        if (value.get("authorized") is not True
            or (options["thinking_mode"] != "auto" or "inference_options" in value)
            and value.get("inference_options") != options):
            raise DesktopError("MODEL_TASK_REVOKED", 403)

    async def _generate(
        self,
        provider: dict,
        selection: dict,
        text: str,
        schema: dict,
        body: dict,
        actor: tuple[str, int],
    ):
        try:
            jsonschema.validators.validator_for(schema).check_schema(schema)
        except jsonschema.SchemaError as exc:
            raise DesktopError("MODEL_INVALID_REQUEST", 422) from exc

        # Schemas are data; never allow validation to fetch a remote reference.
        def has_external_ref(value):
            if isinstance(value, dict):
                return any(
                    (
                        key in {"$ref", "$dynamicRef"}
                        and (not isinstance(item, str) or not item.startswith("#"))
                    )
                    or has_external_ref(item)
                    for key, item in value.items()
                )
            return isinstance(value, list) and any(has_external_ref(item) for item in value)

        if has_external_ref(schema):
            raise DesktopError("MODEL_INVALID_REQUEST", 422)
        base = provider.get("base_url") or "https://api.openai.com/v1"
        parsed = urlsplit(base)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise DesktopError("MODEL_CONFIG_INVALID", 409)
        messages = [
            {
                "role": "system",
                "content": "Return only a complete JSON object matching this schema. Never call tools.\n"
                + encoded(schema),
            },
            {"role": "user", "content": text},
        ]
        try:
            limit = output_budget(selection, body.get("max_output_tokens"))
        except InvalidModelOutputLimit as exc:
            raise DesktopError("MODEL_CONFIG_INVALID", 409) from exc
        except ValueError as exc:
            raise DesktopError("MODEL_INVALID_REQUEST", 422) from exc
        options = inference_options(body)
        overrides = thinking_overrides(provider, selection, options["thinking_mode"])
        if provider["kind"] == "ollama":
            url = base.rstrip("/").removesuffix("/v1") + "/api/chat"
            payload = {
                "model": selection["model"],
                "messages": messages,
                "format": schema,
                "stream": False,
                "think": options["thinking_mode"] == "on",
                "options": {"temperature": 0, "num_predict": limit},
            }
        else:
            url = base.rstrip("/") + "/chat/completions"
            payload = {
                "model": selection["model"],
                "messages": messages,
                "stream": False,
                "temperature": 0,
                "max_tokens": limit,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": "starklink_result", "schema": schema},
                },
            }
            payload.update(overrides.get("model_fields", {}))
            payload.update(overrides.get("extra_body", {}))
            if options["thinking_mode"] == "on":
                payload.pop("temperature", None)
        # Use a fresh request, without the shared client's response cookie jar.
        request = httpx.Request(
            "POST",
            url,
            headers={"authorization": "Bearer " + provider.get("api_key", "")},
            json=payload,
        )
        request.extensions["timeout"] = {"connect": 10, "read": 300, "write": 30, "pool": 10}
        async with asyncio.timeout(300):
            response = await self.client.send(request, stream=True)
            try:
                if response.status_code != 200:
                    error = (DesktopError("MODEL_BILLING_REQUIRED", 402)
                             if response.status_code == 402 else DesktopError("MODEL_CALL_FAILED", 502))
                    error._model_upstream_status = response.status_code
                    raise error
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 1024 * 1024:
                        raise _invalid_output("response_too_large", metadata={
                            "max_output_tokens": limit,
                            "requested_output_tokens": body.get("max_output_tokens"),
                            "response_bytes": len(raw),
                        })
            finally:
                await response.aclose()
        failure_kind = "invalid_response"
        output_metadata = {"max_output_tokens": limit,
                           "requested_output_tokens": body.get("max_output_tokens")}
        try:
            result = strict_json(raw)
            if not isinstance(result, dict):
                raise ValueError()
            usage = result.get("usage")
            if provider["kind"] == "ollama":
                usage = {
                    k: result[k] for k in ("prompt_eval_count", "eval_count") if k in result
                } or None
            if usage is not None:
                if not isinstance(usage, dict):
                    raise ValueError()
                # Store only counters, never arbitrary upstream metadata.
                usage = {
                    k: v
                    for k, v in usage.items()
                    if k
                    in {
                        "prompt_tokens",
                        "completion_tokens",
                        "total_tokens",
                        "prompt_eval_count",
                        "eval_count",
                    }
                    and type(v) is int
                    and v >= 0
                } or None
            await asyncio.to_thread(
                self.ledger.record,
                usage={
                    **({"principal_namespace": actor[1]} if actor[0] == "local-data" else {"user_id": actor[1]}),
                    "application_id": body.get("application_id", actor[0]) if actor[0] == "local-data" else actor[0],
                    "job_id": body.get("job_id"),
                    "purpose": body.get("purpose", "check"),
                    "model_id": selection["id"],
                    "revision": selection["revision"],
                    "inference_options": options,
                    "usage": usage,
                    "accounting": "reported" if usage else "not_returned",
                },
            )
            if provider["kind"] == "ollama":
                metadata = result
            else:
                choices = result.get("choices")
                if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
                    raise _invalid_output("invalid_response")
                metadata = choices[0]
            output_metadata.update(termination_metadata(metadata))
            if truncated(metadata):
                raise _invalid_output("truncated")
            message = (
                result["message"]
                if provider["kind"] == "ollama"
                else result["choices"][0]["message"]
            )
            if (
                not isinstance(message, dict)
                or message.get("tool_calls")
                or not isinstance(message.get("content"), str)
            ):
                raise ValueError()
            content = message["content"].strip()
            output_metadata["response_bytes"] = len(message["content"].encode())
            if content.startswith("```"):
                content = content.partition("\n")[2].rsplit("```", 1)[0].strip()
            failure_kind = "invalid_json"
            value = parse_model_output(content)
            failure_kind = "schema_validation"
            # Preserve the callback's object-only contract even for a loose schema.
            if not isinstance(value, dict):
                raise _invalid_output("schema_validation", validator="type")
            jsonschema.validate(value, schema)
        except jsonschema.ValidationError as exc:
            error = _schema_failure(exc)
            error.output_metadata = safe_output_metadata(output_metadata)
            raise error from exc
        except DesktopError as exc:
            if exc.code == "MODEL_INVALID_OUTPUT":
                exc.output_metadata = safe_output_metadata(output_metadata)
            raise
        except (
            ValueError,
            KeyError,
            IndexError,
            TypeError,
            Unresolvable,
        ) as exc:
            if isinstance(exc, json.JSONDecodeError):
                output_metadata["json_error_position"] = exc.pos
            raise _invalid_output(failure_kind, metadata=output_metadata) from exc
        return {
            "text": encoded(value),
            "usage": usage,
            "inference_options": options,
            **({"max_output_tokens": limit} if body.get("max_output_tokens") is not None else {}),
        }

    async def invoke(self, request: Request):
        if self.required is not None:
            return await self.required.invoke(request)
        from centuarai_local_data_gate.config import load_required_policy

        if load_required_policy() is not None:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        if request.headers.get("origin") is not None:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        # This callback belongs only to the private loopback listener. Never use
        # forwarded headers as proof that a request came from the local service.
        try:
            peer = ipaddress.ip_address(request.client.host if request.client else "")
        except ValueError as exc:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403) from exc
        if not (
            peer.is_loopback or getattr(peer, "ipv4_mapped", None) and peer.ipv4_mapped.is_loopback
        ):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        async with asyncio.timeout(30):
            raw = await bounded_body(request, 512 * 1024)
        config = await asyncio.to_thread(
            DesktopConfig.load, self.config_file, self.service_url, self.box_id
        )
        stamp, nonce, signature = (
            request.headers.get(k, "")
            for k in ("x-starklink-time", "x-starklink-nonce", "x-starklink-signature")
        )
        if (
            any(
                len(request.headers.getlist(k)) != 1
                for k in ("x-starklink-time", "x-starklink-nonce")
            )
            or not re.fullmatch(r"[0-9]{10,12}", stamp)
            or abs(time.time() - int(stamp)) > 60
            or not re.fullmatch(r"[a-f0-9]{32}", nonce)
        ):
            raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        # Legacy managed callers may still sign. Standalone relies on this
        # private listener plus WANX user checks and live task authorization.
        if "x-starklink-signature" in request.headers:
            expected = hmac.new(
                config.service_token.encode(),
                stamp.encode() + b"." + nonce.encode() + b"." + raw,
                hashlib.sha256,
            ).hexdigest()
            if (
                not config.service_token
                or len(request.headers.getlist("x-starklink-signature")) != 1
                or not re.fullmatch(r"[a-f0-9]{64}", signature)
                or not hmac.compare_digest(signature, expected)
            ):
                raise DesktopError("MODEL_AUTH_REQUIRED", 403)
        await asyncio.to_thread(self.ledger.record, nonce)
        try:
            body = strict_json(raw)
            box, app, actor = json.loads(body["owner"])
            if box != config.box_id or app != config.application_id:
                raise ValueError()
            action = body["action"]
            if action not in {"catalog", "check", "infer"}:
                raise ValueError()
            if actor == "team:wanx":
                if not signature:
                    raise ValueError()
                return await self._team_callback(request, raw)
            app_id, user_id = actor.rsplit(":", 1)
            if app_id not in APPS or not user_id.isdigit() or int(user_id) < 1:
                raise ValueError()
            actor = app_id, int(user_id)
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise DesktopError("MODEL_AUTH_REQUIRED", 403) from exc
        await self._user(actor[1])
        items, _ = await self._catalog()
        if action == "catalog":
            return await self.catalog_result(items)
        selected = body.get("selection")
        if not isinstance(selected, dict):
            raise DesktopError("MODEL_INVALID_REQUEST", 422)
        selection = next(
            (m for m in items if m["id"] == selected.get("id") and m["available"]), None
        )
        if selection is None:
            raise DesktopError("MODEL_UNAVAILABLE", 409)
        if selection["revision"] != selected.get("revision"):
            raise DesktopError("MODEL_CONFIG_CHANGED", 409)
        options = inference_options(body)
        if options["thinking_mode"] not in selection["inference_options"]["thinking_modes"]:
            raise DesktopError("MODEL_THINKING_UNSUPPORTED", 422)
        if action == "check":
            text = '合成连通性测试，请返回 {"ok":true}。不含用户资料。'
            schema = {
                "type": "object",
                "properties": {"ok": {"type": "boolean", "const": True}},
                "required": ["ok"],
                "additionalProperties": False,
            }
        else:
            text, schema = body.get("text"), body.get("schema")
            if (
                not isinstance(text, str)
                or not isinstance(schema, dict)
                or len(text.encode()) > 200000
            ):
                raise DesktopError("MODEL_INPUT_TOO_LARGE", 413)
        if self.pending >= 32:
            raise DesktopError("MODEL_BUSY", 429)
        self.pending += 1
        user_limit, users = self.users.get(actor[1], (asyncio.Semaphore(2), 0))
        self.users[actor[1]] = user_limit, users + 1

        async def permitted():
            await self._user(actor[1])
            latest, providers = await self._catalog()
            if not any(
                m["id"] == selection["id"]
                and m["revision"] == selection["revision"]
                and m["available"]
                for m in latest
            ):
                raise DesktopError("MODEL_CONFIG_CHANGED", 409)
            if action == "infer":
                await self._authorize_job(config, actor, body, selection, nonce)
            return providers[selection["provider_id"]]

        async def work():
            async with user_limit, self.slots:
                provider = await permitted()
                audit = {
                    "job_id": body["job_id"] if action == "infer" else None,
                    "purpose": body["purpose"] if action == "infer" else "check",
                    "inference_options": options,
                    **(
                        {"max_output_tokens": body["max_output_tokens"]}
                        if "max_output_tokens" in body
                        else {}
                    ),
                }
                try:
                    result = await self._generate(provider, selection, text, schema, audit, actor)
                except Exception as exc:
                    # permitted() has validated this exact live job before the
                    # model call. Do not log owner, body or exception strings.
                    # A diagnostic sink must never replace the model error.
                    with suppress(Exception):
                        _log_model_failure(
                            exc, body["job_id"] if action == "infer" else None, nonce
                        )
                    raise
                await permitted()
                return result

        async def watch():
            while True:
                await permitted()
                await asyncio.sleep(1)

        drained = asyncio.Event()
        drained.set()
        try:
            async with asyncio.timeout(320):
                return await live_request(request, work(), watch(), drained)
        finally:
            self.pending -= 1
            remaining = self.users[actor[1]][1] - 1
            if remaining:
                self.users[actor[1]] = user_limit, remaining
            else:
                self.users.pop(actor[1], None)

    def register(self, app: FastAPI):
        @app.post("/internal/starklink/models", include_in_schema=False)
        async def callback(request: Request):
            try:
                value = await self.invoke(request)
                if isinstance(value, Response):
                    return value
                return JSONResponse(value, headers={"Cache-Control": "no-store"})
            except DesktopError as exc:
                return JSONResponse(
                    {"code": exc.code, "message": exc.message,
                     **({"output_diagnostic": detail} if (exc.code == "MODEL_INVALID_OUTPUT"
                         and exc.status == 502 and (detail := sanitize_diagnostic(
                             getattr(exc, "output_diagnostic", None)))) else {})},
                    status_code=exc.status,
                    headers={"Cache-Control": "no-store"},
                )
            except ClientDisconnect:
                return Response(status_code=499)
            except (httpx.HTTPError, BridgeUpstreamError, TimeoutError, OSError, sqlite3.Error):
                return JSONResponse(
                    {"code": "MODEL_SERVICE_UNAVAILABLE", "message": None},
                    status_code=503,
                    headers={"Cache-Control": "no-store"},
                )
