"""Device-local, task-authorized access to WANX's existing Provider models."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from functools import partial
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlsplit

import httpx

from .client import SemanticaClient, SemanticaError
from .desktop import parse_model_output
from .model_budget import InvalidModelOutputLimit, output_budget, truncated
from .model_options import inference_options, thinking_overrides
from .output_diagnostics import (
    diagnostic,
    safe_output_metadata,
    sanitize_diagnostic,
    schema_diagnostic,
    termination_metadata,
)

_host = None


def configure_host(bindings):
    """Receive existing model/permission services from the hosting application."""
    global _host
    _host = bindings


def _host_call(name, *args, **kwargs):
    if _host is None:
        raise RuntimeError("Semantica model host bindings are not registered")
    return getattr(_host, name)(*args, **kwargs)


managed_provider = partial(_host_call, "managed_provider")
read_application_defaults = partial(_host_call, "read_application_defaults")
build_probe_chat_model = partial(_host_call, "build_probe_chat_model")
reasoning_request_parameters = partial(_host_call, "reasoning_request_parameters")
list_resolved_models = partial(_host_call, "list_resolved_models")
user_has_permission = partial(_host_call, "user_has_permission")
llm_text_content = partial(_host_call, "llm_text_content")
aclose_session_http_clients = partial(_host_call, "aclose_session_http_clients")

_NONCES: dict[str, float] = {}
_LIMIT = asyncio.Semaphore(4)
_USER_LIMITS: dict[int, asyncio.Semaphore] = {}
_LOGGER = logging.getLogger(__name__)


def _invalid_output(kind, *, validator=None):
    error = SemanticaError("MODEL_INVALID_OUTPUT", 502)
    error.output_diagnostic = diagnostic(kind, source="bridge", validator=validator)
    return error


def _provider_status(error: BaseException) -> int | None:
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
    elif type(error).__module__ in {"openai", "openai._exceptions"} and any(
        base.__name__ == "APIStatusError" for base in type(error).__mro__
    ):
        status = getattr(error, "status_code", None)
    else:
        return None
    return status if type(status) is int and 100 <= status <= 599 else None


def _log_model_failure(error: Exception, job_id: str | None, nonce: str) -> None:
    """Log only authorized correlation hashes and closed failure metadata."""
    category, status = "unknown", None
    public = (
        error.code
        if isinstance(error, SemanticaError) and error.code in {"MODEL_INVALID_OUTPUT", "MODEL_BILLING_REQUIRED"}
        else "MODEL_CALL_FAILED"
    )
    if public == "MODEL_INVALID_OUTPUT":
        category = "invalid_output"
    cause: BaseException | None = error
    seen: set[int] = set()
    for _ in range(6):
        if cause is None or id(cause) in seen:
            break
        seen.add(id(cause))
        sdk = type(cause).__module__ in {"openai", "openai._exceptions"}
        status = _provider_status(cause)
        if status is not None:
            category = "upstream_http"
            break
        if (
            isinstance(cause, (httpx.TimeoutException, TimeoutError))
            or sdk
            and type(cause).__name__ == "APITimeoutError"
        ):
            category = "timeout"
        elif (
            isinstance(cause, httpx.RequestError)
            or sdk
            and type(cause).__name__ == "APIConnectionError"
        ):
            category = "network"
        cause = cause.__cause__ or cause.__context__
    job = (
        job_id
        if isinstance(job_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id)
        else None
    )
    _LOGGER.warning(
        _json(
            {
                "event": "starlink_model_failure",
                "timestamp": int(time.time()),
                "publicCode": public,
                "category": category,
                "upstreamStatus": status,
                "jobHash": hashlib.sha256(job.encode()).hexdigest() if job else None,
                "requestHash": hashlib.sha256(nonce.encode()).hexdigest(),
                **({"outputDiagnostic": detail} if public == "MODEL_INVALID_OUTPUT"
                   and (detail := sanitize_diagnostic(getattr(error, "output_diagnostic", None))) else {}),
                **({"outputMetadata": metadata} if public == "MODEL_INVALID_OUTPUT"
                   and (metadata := safe_output_metadata(getattr(error, "output_metadata", None))) else {}),
            }
        )
    )


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _local(url: str | None) -> bool:
    parsed = urlsplit(url or "")
    if parsed.hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        return False


def _inference_options(body: dict[str, Any]) -> dict[str, str]:
    return inference_options(body, error=SemanticaError)


def _thinking_overrides(row: Any, selection: dict[str, Any], mode: str) -> dict[str, Any]:
    return thinking_overrides(row, selection, mode,
                              builder=reasoning_request_parameters, error=SemanticaError)


def _thinking_modes(row: Any, entry: dict[str, Any]) -> list[str]:
    modes = ["auto"]
    for mode in ("on", "off"):
        try:
            _thinking_overrides(row, entry, mode)
        except SemanticaError:
            continue
        modes.append(mode)
    return modes


def _catalog(services: Any) -> tuple[list[dict[str, Any]], dict[int, Any]]:
    rows = services.provider_repo.list_all()
    by_id = {r.id: r for r in rows}
    items = []
    for entry in list_resolved_models(rows):
        row = by_id[entry["provider_id"]]
        if "text" not in entry["input"]:
            continue
        leased = managed_provider(row)
        location = "local" if _local(row.base_url) and not leased else "external"
        revision = hashlib.sha256(
            _json(
                # Admin lease credentials rotate without changing the model or
                # recipient. Ordinary provider credentials remain identity-bound.
                [
                    row.id,
                    row.kind,
                    row.base_url,
                    None if leased else row.api_key,
                    row.extra_json,
                    entry,
                    location,
                ]
            ).encode()
        ).hexdigest()
        items.append(
            {
                "id": str(row.id) + ":" + entry["model"],
                "provider_id": row.id,
                "model": entry["model"],
                "name": entry["name"],
                "provider": row.name,
                "location": location,
                "revision": revision,
                "available": True,
                "capabilities": ["text", "json_check_required"],
                "context_window": entry.get("context_window"),
                "max_output_tokens": entry.get("max_output_tokens"),
                "reasoning_config": entry.get("reasoning_config"),
                "inference_options": {"thinking_modes": _thinking_modes(row, entry)},
            }
        )
    return items, by_id


async def _generate(
    row: Any,
    selection: dict[str, Any],
    text: str,
    schema: dict[str, Any],
    record_usage: Callable[[Any], Awaitable[None]],
    max_output_tokens: int | None = None,
) -> dict[str, Any]:
    from langchain_core.messages import HumanMessage, SystemMessage

    try:
        output = output_budget(selection, max_output_tokens)
    except InvalidModelOutputLimit as exc:
        raise SemanticaError("MODEL_CONFIG_INVALID", 409) from exc
    except ValueError as exc:
        raise SemanticaError("MODEL_INVALID_REQUEST", 422) from exc
    model = build_probe_chat_model(row, model_id=selection["model"])
    mode = selection.get("thinking_mode", "auto")
    overrides = _thinking_overrides(row, selection, mode)
    if overrides:
        updates = dict(overrides.get("model_fields", {}))
        if overrides.get("extra_body"):
            updates["extra_body"] = {
                **(getattr(model, "extra_body", None) or {}),
                **overrides["extra_body"],
            }
        model = model.model_copy(update=updates)
    model.max_retries = 0
    if mode != "on" and hasattr(model, "temperature"):
        model.temperature = 0
    messages = [
        SystemMessage(
            content="Return only a complete JSON object matching this schema. Never call tools.\n"
            + _json(schema)
        ),
        HumanMessage(content=text),
    ]
    metadata = {"max_output_tokens": output, "requested_output_tokens": max_output_tokens}
    try:
        kwargs = {"max_tokens": output}
        if _local(row.base_url) and (row.kind == "ollama" or ":11434" in (row.base_url or "")):
            if mode == "auto":
                # Preserve the historical local-model default for old tasks.
                kwargs["extra_body"] = {"think": False}
                kwargs["reasoning_effort"] = "none"
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "starklink_result", "schema": schema},
            }
        answer = await asyncio.wait_for(model.ainvoke(messages, **kwargs), timeout=300)
        await record_usage(getattr(answer, "usage_metadata", None))
        response_metadata = getattr(answer, "response_metadata", None)
        if response_metadata is None:
            response_metadata = {}
        if not isinstance(response_metadata, dict):
            raise _invalid_output("invalid_response")
        metadata.update(termination_metadata(response_metadata))
        if truncated(response_metadata):
            raise _invalid_output("truncated")
        if getattr(answer, "tool_calls", None):
            raise _invalid_output("invalid_response")
        content = llm_text_content(answer)
        if not isinstance(content, str):
            raise _invalid_output("invalid_response")
        metadata["response_bytes"] = len(content.encode())
        if metadata["response_bytes"] > 512 * 1024:
            raise _invalid_output("response_too_large")
        cleaned = content.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.partition("\n")[2].rsplit("```", 1)[0].strip()
        try:
            value = parse_model_output(cleaned)
        except ValueError as exc:
            if isinstance(exc, json.JSONDecodeError):
                metadata["json_error_position"] = exc.pos
            raise _invalid_output("invalid_json") from exc
        if not isinstance(value, dict):
            raise _invalid_output("schema_validation", validator="type")
        import jsonschema

        try:
            jsonschema.validate(value, schema)
        except jsonschema.ValidationError as exc:
            error = _invalid_output("schema_validation")
            error.output_diagnostic = schema_diagnostic(exc)
            raise error from exc
        return {
            "text": _json(value),
            "usage": getattr(answer, "usage_metadata", None),
            **({"max_output_tokens": output} if max_output_tokens is not None else {}),
        }
    except SemanticaError as exc:
        if exc.code == "MODEL_INVALID_OUTPUT":
            exc.output_metadata = safe_output_metadata(metadata)
        raise
    except (ValueError, KeyError) as exc:
        error = _invalid_output("invalid_response")
        error.output_metadata = safe_output_metadata(metadata)
        raise error from exc
    except Exception as exc:
        if _provider_status(exc) == 402:
            raise SemanticaError("MODEL_BILLING_REQUIRED", 402) from exc
        raise
    finally:
        await aclose_session_http_clients(model)


async def internal(
    raw: bytes,
    headers: Mapping[str, str],
    services: Any,
    is_disconnected: Callable[[], Awaitable[bool]],
) -> dict[str, Any]:
    try:
        if headers.get("origin"):
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        if len(raw) > 512 * 1024:
            raise SemanticaError("MODEL_INPUT_TOO_LARGE", 413)
        config = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: json.loads((services.paths.root / "semantica.json").read_text()),
        )
        stamp = headers.get("x-starklink-time", "")
        nonce = headers.get("x-starklink-nonce", "")
        if (
            not re.fullmatch(r"[0-9]{10,12}", stamp)
            or abs(time.time() - int(stamp)) > 60
            or not re.fullmatch(r"[0-9a-f]{32}", nonce)
        ):
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        # The HTTP host restricts this callback to loopback. Standalone sends
        # time/nonce without a signature; validate legacy signatures when supplied.
        if "x-starklink-signature" in headers:
            secret = config.get("service_token", "")
            expected = hmac.new(
                secret.encode(),
                stamp.encode() + b"." + nonce.encode() + b"." + raw,
                hashlib.sha256,
            ).hexdigest()
            if not secret or not hmac.compare_digest(expected, headers["x-starklink-signature"]):
                raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        now = time.time()
        for key in list(_NONCES):
            if _NONCES[key] < now - 120:
                del _NONCES[key]
        if nonce in _NONCES:
            raise SemanticaError("MODEL_REPLAY_DENIED", 409)
        _NONCES[nonce] = now
        body = json.loads(raw)
        box, app, actor = json.loads(body["owner"])
        if box != config["box_id"] or app != config["application_id"]:
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        team = actor == "team:wanx"
        if team:
            actor = body.get("actor_id", "")
            if not isinstance(actor, str) or not re.fullmatch(r"wanx:[1-9][0-9]*", actor):
                raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        app_id, user_id = actor.rsplit(":", 1)
        if app_id not in {"wanx", "semantica", "centaurai.wanx.semantica"} or not user_id.isdigit():
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        user = await asyncio.get_running_loop().run_in_executor(
            None, services.user_repo.get, int(user_id)
        )
        if (
            not user
            or (team and user.role != "admin")
            or user.disabled
            or not user_has_permission(
                SimpleNamespace(is_admin=user.role == "admin", permissions=user.permissions),
                "knowledge_bases",
            )
        ):
            raise SemanticaError("MODEL_AUTH_REQUIRED", 403)
        items, rows = await asyncio.get_running_loop().run_in_executor(None, _catalog, services)
        if body["action"] == "catalog":
            policy = await asyncio.get_running_loop().run_in_executor(
                None, read_application_defaults, services
            )
            configured = policy["defaults"].get("starlink")
            source = "application" if configured else "wanx_active"
            if configured:
                reference = configured["model_ref"] if configured["available"] else None
            else:
                provider, model = await asyncio.get_running_loop().run_in_executor(
                    None, services.settings_repo.get_active_model
                )
                reference = f"{provider}/{model}" if provider and model else None
            default = next(
                (
                    item
                    for item in items
                    if reference and f"{item['provider']}/{item['model']}" == reference
                ),
                None,
            )
            return {
                "items": items,
                "checked_at": now,
                "managed": policy["managed"],
                "default": default,
                "default_source": source,
                "default_error": None if default else "MODEL_DEFAULT_UNAVAILABLE",
            }
        requested = body["selection"]
        selection = next((m for m in items if m["id"] == requested["id"]), None)
        if selection is None:
            raise SemanticaError("MODEL_UNAVAILABLE", 409)
        if selection["revision"] != requested["revision"]:
            raise SemanticaError("MODEL_CONFIG_CHANGED", 409)
        options = _inference_options(body)
        if options["thinking_mode"] not in selection["inference_options"]["thinking_modes"]:
            raise SemanticaError("MODEL_THINKING_UNSUPPORTED", 422)
        selection = {**selection, "thinking_mode": options["thinking_mode"]}
        action = body["action"]
        if action == "check":
            text = '合成连通性测试，请返回 {"ok":true}。不含用户资料。'
            schema = {
                "type": "object",
                "properties": {"ok": {"type": "boolean", "const": True}},
                "required": ["ok"],
                "additionalProperties": False,
            }
        elif action == "infer":
            if body.get("purpose") not in {"extraction", "sensitive"}:
                raise SemanticaError("MODEL_PURPOSE_DENIED", 403)
            service = SemanticaClient(
                config, int(user_id), app_id, team=team, home=services.paths.root
            )
            grant = await service.request(
                "POST",
                "/processing/authorize",
                payload={
                    "operation_id": nonce,
                    "job_id": body["job_id"],
                    "purpose": body["purpose"],
                    "model_id": selection["id"],
                    "model_revision": selection["revision"],
                    **(
                        {"inference_options": options} if options["thinking_mode"] != "auto" else {}
                    ),
                },
            )
            if (
                grant.get("authorized") is not True
                or options["thinking_mode"] != "auto"
                and grant.get("inference_options") != options
            ):
                raise SemanticaError("MODEL_TASK_REVOKED", 403)
            text = body["text"]
            schema = body["schema"]
            if (
                not isinstance(text, str)
                or not isinstance(schema, dict)
                or len(text.encode()) > 200000
            ):
                raise SemanticaError("MODEL_INPUT_TOO_LARGE", 413)
        else:
            raise SemanticaError("MODEL_OPERATION_DENIED", 403)

        async def record_usage(usage: Any) -> None:
            # Provider usage is retained even when JSON validation fails. Do not
            # invent zero usage or create a conversation/Agent for accounting.
            await asyncio.get_running_loop().run_in_executor(
                None,
                partial(
                    services.audit_repo.write,
                    actor=user.username,
                    action="starklink.model.usage",
                    target=str(body.get("job_id") or "model-check"),
                    payload=_json(
                        {
                            "application_id": app,
                            "warehouse_id": body.get("warehouse_id"),
                            "purpose": body.get("purpose", "check"),
                            "model": selection["model"],
                            "provider_id": selection["provider_id"],
                            "revision": selection["revision"],
                            "location": selection["location"],
                            "usage": usage,
                            "inference_options": options,
                            "accounting": "reported" if usage else "not_returned",
                        }
                    ),
                ),
            )

        user_limit = _USER_LIMITS.setdefault(int(user_id), asyncio.Semaphore(2))
        async with user_limit, _LIMIT:
            latest, rows = await asyncio.get_running_loop().run_in_executor(
                None, _catalog, services
            )
            if not any(
                m["id"] == selection["id"] and m["revision"] == selection["revision"]
                for m in latest
            ):
                raise SemanticaError("MODEL_CONFIG_CHANGED", 409)
            # Re-check authorization after waiting for a capacity slot.
            if action == "infer":
                grant = await service.request(
                    "POST",
                    "/processing/authorize",
                    payload={
                        "operation_id": nonce,
                        "job_id": body["job_id"],
                        "purpose": body["purpose"],
                        "model_id": selection["id"],
                        "model_revision": selection["revision"],
                        **(
                            {"inference_options": options}
                            if options["thinking_mode"] != "auto"
                            else {}
                        ),
                    },
                )
                if (
                    grant.get("authorized") is not True
                    or options["thinking_mode"] != "auto"
                    and grant.get("inference_options") != options
                ):
                    raise SemanticaError("MODEL_TASK_REVOKED", 403)
            task = asyncio.create_task(
                _generate(
                    rows[selection["provider_id"]],
                    selection,
                    text,
                    schema,
                    record_usage,
                    **(
                        {"max_output_tokens": body["max_output_tokens"]}
                        if "max_output_tokens" in body
                        else {}
                    ),
                )
            )
            try:
                while not task.done():
                    if await is_disconnected():
                        task.cancel()
                        raise SemanticaError("MODEL_CANCELLED", 409)
                    await asyncio.wait({task}, timeout=0.25)
                try:
                    result = await task
                except Exception as exc:
                    # Both live job grants above succeeded. Never log request
                    # dictionaries, actor identities or provider exceptions.
                    # A diagnostic sink must never replace the model error.
                    with suppress(Exception):
                        _log_model_failure(
                            exc, body["job_id"] if action == "infer" else None, nonce
                        )
                    raise
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        return {**result, "inference_options": options}
    except SemanticaError:
        raise
    except Exception:
        raise SemanticaError("MODEL_CALL_FAILED", 502) from None
