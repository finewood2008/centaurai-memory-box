"""Authorize explicit Zhijun memory writes and their conversation sources."""

from __future__ import annotations

import asyncio
from typing import Any

from octop.infra.agents.assistant_conversations import AssistantConversations, ConversationError
from octop.infra.agents.threads.fork import _msg_id


async def authorize_sidebar_memory_write(
    conversations: AssistantConversations,
    user: Any,
    *,
    conversation_id: str | None,
    requested_mode: str | None,
    thread_id: str | None,
    message_id: str | None,
) -> None:
    identity = conversation_id or thread_id
    if not identity:
        if requested_mode != "craft":
            raise ConversationError("ZHIJUN_ADVANCED_REQUIRED", 403)
        if message_id:
            raise ConversationError("ASSISTANT_INVALID_INPUT", 422)
        return

    state = await asyncio.to_thread(conversations.require_zhijun, user, identity)
    if thread_id and thread_id != identity:
        source = await asyncio.to_thread(conversations.require_zhijun, user, thread_id)
        if source["id"] != state["id"]:
            raise ConversationError("ASSISTANT_CONVERSATION_NOT_FOUND", 404)
    if state["conversation_mode"] != "craft" or (not conversation_id and not requested_mode):
        raise ConversationError("ZHIJUN_ADVANCED_REQUIRED", 403)

    if message_id:
        if not thread_id:
            raise ConversationError("ASSISTANT_INVALID_INPUT", 422)
        messages = await conversations.messages(state["agent_id"], thread_id)
        if not any(_msg_id(message) == message_id for message in messages):
            raise ConversationError("ASSISTANT_MESSAGE_NOT_FOUND", 404)
