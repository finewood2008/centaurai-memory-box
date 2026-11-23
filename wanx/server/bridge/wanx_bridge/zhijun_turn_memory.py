"""Explicit Zhijun memory commands from an authorized, owner-authored turn."""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from .zhijun_memory import MemoryConflict, MemoryMissing, run_memory

MemoryAction = Literal["remember", "correct", "forget"]
_REMEMBER = re.compile(r"^(?:请帮我|请|帮我)?记住[：:，,\s]+(.+)$", re.DOTALL)
_CORRECT = re.compile(
    r"^(?:请帮我|请|帮我)?更正(?:这条)?(?:记忆)?[：:，,\s]+"
    r"(.+?)\s*(?:=>|→|更正为|改为)\s*(.+)$",
    re.DOTALL,
)
_CORRECT_QUOTED = re.compile(
    r"^(?:请帮我|请|帮我)?(?:把|将)记忆\s*“([^”]+)”\s*(?:更正为|改为|改成)\s*“([^”]+)”[。！]?$",
    re.DOTALL,
)
_FORGET = re.compile(r"^(?:请帮我|请|帮我)?忘记(?:这条)?(?:记忆)?[：:，,\s]+(.+)$", re.DOTALL)
_FORGET_QUOTED = re.compile(
    r"^(?:请帮我|请|帮我)?忘记(?:这条)?(?:记忆)?\s*“([^”]+)”[。！]?$", re.DOTALL
)


@dataclass(frozen=True)
class MemoryIntent:
    action: MemoryAction
    text: str | None = None
    target: str | None = None


@dataclass(frozen=True)
class MemoryTurnResult:
    action: MemoryAction
    reply: str
    applied: bool = False
    item: dict[str, Any] | None = None


def parse_memory_intent(text: str) -> MemoryIntent | None:
    """Recognize an explicit instruction in the current user's own text."""
    text = text.strip()
    if match := _REMEMBER.fullmatch(text):
        return MemoryIntent("remember", text=match[1].strip())
    if match := (_CORRECT_QUOTED.fullmatch(text) or _CORRECT.fullmatch(text)):
        return MemoryIntent("correct", text=_unquote(match[2]), target=_unquote(match[1]))
    if match := (_FORGET_QUOTED.fullmatch(text) or _FORGET.fullmatch(text)):
        return MemoryIntent("forget", target=_unquote(match[1]))
    return None


def _unquote(text: str) -> str:
    text = text.strip()
    if len(text) > 1 and {"“": "”", '"': '"'}.get(text[0]) == text[-1]:
        return text[1:-1].strip()
    return text


def apply_memory_intent(
    root: Path,
    owner_id: int,
    intent: MemoryIntent,
    *,
    mode: str,
    request_id: str,
    thread_id: str,
    message_id: str,
    channel: str | None = None,
    legacy_request_id: str | None = None,
) -> MemoryTurnResult:
    """Use the gateway's authorized mode and actual conversation provenance."""
    action = intent.action
    if mode != "craft":
        return MemoryTurnResult(action, "请在桌面打开这段对话并选择高级模式，再变更长期记忆。")
    fields: dict[str, Any] = {"action": action, "threadId": thread_id, "messageId": message_id}
    if channel:
        fields["channel"] = channel

    if action != "forget":
        if not intent.text or len(intent.text) > 3000 or "\0" in intent.text:
            return MemoryTurnResult(action, "请输入一条 3000 字以内的记忆。")
        fields["text"] = intent.text
    if action != "remember":
        if not intent.target or len(intent.target) > 3000 or "\0" in intent.target:
            return MemoryTurnResult(action, "请提供要变更的记忆原文或记忆 ID。")
        fields["target"] = intent.target

    failure = MemoryTurnResult(action, "本次记忆变更未确认，请稍后重试。")
    if not thread_id or not message_id:
        return failure
    try:
        fields["requestId"] = str(UUID(request_id))
        if legacy_request_id is not None:
            if not channel:
                return failure
            legacy_request_id = str(UUID(legacy_request_id))
    except ValueError:
        return failure
    try:
        receipt = run_memory(root, owner_id, fields, legacy_request_id=legacy_request_id)
    except MemoryMissing:
        return MemoryTurnResult(action, "没有找到唯一匹配的有效记忆。请核对记忆原文后重试。")
    except (MemoryConflict, OSError, sqlite3.Error):
        return failure
    if receipt.get("applied") is not True:
        return failure
    item = receipt["item"]
    if action == "forget":
        reply = "已忘记这条长期记忆。"
    elif item is None:
        reply = "这条请求已处理。想重新保存，可以再发一条。"
    else:
        verb = "已记住" if action == "remember" else "已更正"
        reply = f"{verb}：{item['text']}"
    return MemoryTurnResult(action, reply, applied=True, item=item)
