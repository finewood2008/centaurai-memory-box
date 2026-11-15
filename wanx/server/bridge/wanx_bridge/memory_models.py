"""Text model access for the WANX personal memory workspace."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class MemoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "user", "assistant"]
    content: str


class MemoryCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[MemoryMessage] = Field(min_length=1, max_length=256)
    max_tokens: int = Field(ge=1, le=32768)
    json_mode: bool = False


def create_memory_model_router(
    *, current_user, get_server, application_id, providers, build_chat_model, close_clients, text_content
):
    router = APIRouter(prefix="/api/wanx/memory-model", tags=["wanx-memory"])

    def select(server, user):
        if application_id(user) != "wanx":
            raise HTTPException(403, detail="MEMORY_MODEL_FORBIDDEN")
        services = server.services
        name, model_id = services.settings_repo.get_active_model()
        for provider in providers(services.provider_repo).build_harness_configs():
            if provider.id == name:
                for model in provider.models:
                    if model.id == model_id:
                        return provider, model
        raise HTTPException(409, detail="MEMORY_MODEL_NOT_CONFIGURED")

    @router.get("")
    def status(user=Depends(current_user), server=Depends(get_server)):
        provider, model = select(server, user)
        return {"model": model.id, "name": model.name or model.id, "provider": provider.name or provider.id}

    @router.post("/complete")
    async def complete(request: Request, user=Depends(current_user), server=Depends(get_server)):
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 2 * 1024 * 1024:
                raise HTTPException(413, detail="MEMORY_MODEL_INPUT_TOO_LARGE")
            body.extend(chunk)
        try:
            payload = MemoryCompletion.model_validate_json(body)
        except ValidationError:
            raise HTTPException(422, detail="MEMORY_MODEL_INVALID_INPUT") from None
        provider, model = await asyncio.to_thread(select, server, user)
        messages = [(message.role, message.content) for message in payload.messages]
        if payload.json_mode:
            instruction = "Return only a valid JSON object, without Markdown fences."
            if messages[0][0] == "system":
                messages[0] = ("system", f"{messages[0][1]}\n\n{instruction}")
            else:
                messages.insert(0, ("system", instruction))
        llm = None
        try:
            llm = build_chat_model(provider, replace(model, native_tool_search=False))
            result = await asyncio.wait_for(
                llm.ainvoke(messages, max_tokens=min(payload.max_tokens, model.max_output_tokens or 32768)),
                timeout=115,
            )
            text = text_content(result)
            if not text:
                raise ValueError("empty completion")
            return {
                "text": text,
                "model": model.id,
                "finishReason": result.response_metadata.get("finish_reason")
                or result.response_metadata.get("stop_reason"),
                "usage": result.usage_metadata,
            }
        except TimeoutError:
            raise HTTPException(504, detail="MEMORY_MODEL_TIMEOUT") from None
        except Exception:
            raise HTTPException(502, detail="MEMORY_MODEL_UPSTREAM_FAILED") from None
        finally:
            if llm is not None:
                await close_clients(llm)

    return router
