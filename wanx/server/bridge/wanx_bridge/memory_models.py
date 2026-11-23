"""Authenticated text model access for the WANX personal memory workspace.

Model construction uses the host's existing Provider bindings. Managed rows keep
using the leased loopback inference proxy, including its live authorization and
account-provider billing transport; no supplier credentials are copied here.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

TEXT_ROLES = ("memory_summary", "memory_evolution")


class MemoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    role: Literal["system", "user", "assistant"]
    content: str


class MemoryCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    messages: list[MemoryMessage] = Field(min_length=1, max_length=256)
    max_tokens: int = Field(ge=1, le=32768)
    json_mode: bool = False
    role: Literal["memory_summary", "memory_evolution"] | None = None
    model_ref: str | None = Field(default=None, min_length=1, max_length=512)


class MemoryModelStatus(BaseModel):
    model: str | None
    name: str | None
    provider: str | None
    capabilities: dict


class MemoryCompletionResult(BaseModel):
    text: str
    model: str
    finishReason: str | None = None
    usage: dict | None = None


def create_memory_model_router(*, current_user, get_server, application_id, model_host):
    router = APIRouter(prefix="/api/wanx/memory-model", tags=["wanx-memory"])

    def catalog(server, user):
        if application_id(user) != "wanx":
            raise HTTPException(403, detail="MEMORY_MODEL_FORBIDDEN")
        rows = server.services.provider_repo.list_all()
        by_id = {row.id: row for row in rows}
        models = []
        for entry in model_host.list_resolved_models(rows):
            row = by_id.get(entry.get("provider_id"))
            if row is None or "text" not in entry.get("input", []):
                continue
            # A projected managed name cannot silently turn into a direct
            # supplier connection if its local lease binding is malformed.
            if row.name.startswith("admin-managed-") and not model_host.managed_provider(row):
                continue
            models.append({
                "provider_name": row.name,
                "model": entry["model"],
                "name": entry.get("name") or entry["model"],
                "input": ["text"],
                **({"max_output_tokens": entry["max_output_tokens"]}
                   if entry.get("max_output_tokens") else {}),
            })
        return models, by_id

    def choose(server, user, reference=None):
        models, rows = catalog(server, user)
        if reference is None:
            provider, model = server.services.settings_repo.get_active_model()
            reference = f"{provider}/{model}"
        selected = next((item for item in models
                         if f"{item['provider_name']}/{item['model']}" == reference), None)
        if selected is None:
            raise HTTPException(409, detail="MEMORY_MODEL_NOT_CONFIGURED")
        row = next(row for row in rows.values() if row.name == selected["provider_name"])
        return selected, row, models

    @router.get("", summary="Read the active memory model", response_model=MemoryModelStatus)
    def status(user=Depends(current_user), server=Depends(get_server)):
        models, _ = catalog(server, user)
        provider, model = server.services.settings_repo.get_active_model()
        reference = f"{provider}/{model}"
        selected = next((item for item in models
                         if f"{item['provider_name']}/{item['model']}" == reference), None)
        if selected is None:
            reference = None
        inventory = getattr(model_host, "memory_model_inventory", None)
        capabilities = inventory(server) if inventory else {}
        capabilities.update({
            role: {"defaultRef": reference, "models": models} for role in TEXT_ROLES
        })
        return JSONResponse({
            "model": selected["model"] if selected else None,
            "name": selected["name"] if selected else None,
            "provider": selected["provider_name"] if selected else None,
            "capabilities": capabilities,
        }, headers={"Cache-Control": "no-store"})

    @router.post("/complete", summary="Generate text with the active memory model", response_model=MemoryCompletionResult)
    async def complete(request: Request, user=Depends(current_user), server=Depends(get_server)):
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 2 * 1024 * 1024:
                raise HTTPException(413, detail="MEMORY_MODEL_INPUT_TOO_LARGE")
            body.extend(chunk)
        try:
            payload = MemoryCompletion.model_validate_json(body)
            if payload.model_ref is not None and payload.role is None:
                raise ValueError()
        except (ValidationError, ValueError):
            raise HTTPException(422, detail="MEMORY_MODEL_INVALID_INPUT") from None
        selected, row, _ = await asyncio.to_thread(choose, server, user, payload.model_ref)
        messages = [(message.role, message.content) for message in payload.messages]
        if payload.json_mode:
            instruction = "Return only a valid JSON object, without Markdown fences."
            if messages[0][0] == "system":
                messages[0] = ("system", f"{messages[0][1]}\n\n{instruction}")
            else:
                messages.insert(0, ("system", instruction))
        async def revalidate_identity():
            # Revalidate the native bearer without current_user's per-request
            # cached principal. Revocation must also stop a long running call.
            scope = dict(request.scope)
            scope["state"] = {}
            fresh = await current_user(
                Request(scope), server=server,
                authorization=request.headers.get("authorization"), access_token=None,
            )
            if (fresh.id, application_id(fresh)) != (user.id, application_id(user)):
                raise HTTPException(403, detail="MEMORY_MODEL_FORBIDDEN")

        llm = None
        try:
            # Keep the existing host Provider protocol/headers and, for managed
            # providers, its opaque local relay credential. Never build a model
            # from the cloud provider lease or a caller-provided endpoint.
            llm = model_host.build_probe_chat_model(row, model_id=selected["model"])
            llm.max_retries = 0
            limit = min(payload.max_tokens, selected.get("max_output_tokens") or 32768)
            task = asyncio.create_task(llm.ainvoke(messages, max_tokens=limit))
            try:
                async with asyncio.timeout(115):
                    while not task.done():
                        if await request.is_disconnected():
                            raise HTTPException(499, detail="MEMORY_MODEL_CANCELLED")
                        await revalidate_identity()
                        await asyncio.wait({task}, timeout=0.25)
                    result = await task
                    await revalidate_identity()
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            # Re-read the enabled catalog before exposing the completion.
            await asyncio.to_thread(choose, server, user,
                                    f"{selected['provider_name']}/{selected['model']}")
            content = model_host.llm_text_content(result)
            if not content:
                raise ValueError("empty completion")
            return JSONResponse({
                "text": content, "model": selected["model"],
                "finishReason": result.response_metadata.get("finish_reason")
                or result.response_metadata.get("stop_reason"),
                "usage": result.usage_metadata,
            }, headers={"Cache-Control": "no-store"})
        except HTTPException:
            raise
        except TimeoutError:
            raise HTTPException(504, detail="MEMORY_MODEL_TIMEOUT") from None
        except Exception:
            raise HTTPException(502, detail="MEMORY_MODEL_UPSTREAM_FAILED") from None
        finally:
            if llm is not None:
                # Teardown must not hide a successful answer or the original error.
                with suppress(Exception):
                    await model_host.aclose_session_http_clients(llm)

    return router
