"""Explicit, owner-scoped Octop memory for the MemoBox sidebar."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from octop_memory.core import Memory
from octop_memory.types import AtomCard, MemoryNode

_LOCK = threading.Lock()
_HAN = re.compile(r"[\u3400-\u9fff]+")
_WORD = re.compile(r"[a-z0-9]+")
_QUERY_FILLER = "帮我找回知君记得记住请问我们上次之前聊过什么是谁还记得这件事哪儿从前的资料"
_CHANNEL_LABELS = {"weixin": "微信", "wecom": "企业微信", "feishu": "飞书", "dingtalk": "钉钉"}


class _HidePrivateAssertion(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # Octop 1.0 logs the first 60 characters of a manual assertion at INFO.
        if (
            isinstance(record.msg, str)
            and record.msg.startswith("memory.trigger create_atom")
            and isinstance(record.args, tuple)
            and record.args
            and record.args[0] == "zhijun_sidebar"
        ):
            return False
        return True


logging.getLogger("octop_memory").addFilter(_HidePrivateAssertion())


class MemoryConflict(ValueError):
    pass


class MemoryMissing(ValueError):
    pass


def _normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold().strip()


def _terms(text: str) -> set[str]:
    text = _normalize(text)
    result = {word for word in _WORD.findall(text) if len(word) >= 2}
    for segment in _HAN.findall(text):
        result.update(
            segment[i : i + 2]
            for i in range(len(segment) - 1)
            if segment[i : i + 2] not in _QUERY_FILLER
        )
    return result


def _evidence(memory: Memory, atom: AtomCard) -> dict[str, Any]:
    journal = memory.list_journal(target_atom_id=atom.id, limit=1)
    note = json.loads(journal[0].note) if journal else {}
    return {
        "id": atom.id,
        "text": atom.assertion,
        "createdAt": atom.created_at.isoformat(),
        "threadId": note.get("threadId"),
        "messageId": note.get("messageId"),
        **(
            {"title": _CHANNEL_LABELS[note["channel"]] + "私聊"}
            if note.get("channel") in _CHANNEL_LABELS
            else {}
        ),
    }


def _active(memory: Memory, atom_id: str) -> AtomCard | None:
    atom = memory.get_atom(atom_id)
    return atom if atom and atom.deprecated_at is None else None


def _resolve_turn_target(memory: Memory, target: str) -> str:
    if memory.get_atom(target) is not None:
        return target
    normalized = _normalize(target)
    matches = [
        atom.id for atom in memory.list_atoms(limit=-1) if _normalize(atom.assertion) == normalized
    ]
    if len(matches) != 1:
        raise MemoryMissing("memory target missing or ambiguous")
    return matches[0]


def _list(memory: Memory, query: str, limit: int, offset: int) -> dict[str, Any]:
    atoms = memory.list_atoms(limit=-1)
    if query:
        needle = _normalize(query)
        terms = _terms(query)

        def score(atom: AtomCard) -> int:
            # Rank only the current assertion. The original quote inherited by
            # replace_atom may contain facts the owner has explicitly corrected.
            text = _normalize(atom.assertion)
            return 10 * int(needle in text) + len(terms & _terms(text))

        ranked = [(score(atom), atom) for atom in atoms]
        atoms = [atom for rank, atom in sorted(ranked, key=lambda pair: -pair[0]) if rank > 0]
    return {
        "items": [_evidence(memory, atom) for atom in atoms[offset : offset + limit]],
        "hasMore": len(atoms) > offset + limit,
    }


def _eligible_references(
    memory: Memory, query: str, references: list[dict[str, str]]
) -> list[dict[str, str]]:
    if not references:
        return []
    atoms = memory.list_atoms(include_deprecated=True, limit=-1)
    kept = {_normalize(atom.assertion) for atom in atoms if atom.deprecated_at is None}
    retired = {
        _normalize(atom.assertion) for atom in atoms if atom.deprecated_at is not None
    } - kept
    query_terms = _terms(query)
    history_may_revive_retired_fact = any(query_terms & _terms(text) for text in retired)
    return [
        reference
        for reference in references
        if not (
            (reference["source"] == "memmy" and history_may_revive_retired_fact)
            or any(
                text in _normalize(reference["title"] + "\n" + reference["text"])
                for text in retired
            )
        )
    ]


def _receipt_digest(fields: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()


def _write(
    memory: Memory, fields: dict[str, Any], *, legacy_request_id: str | None = None
) -> dict[str, Any]:
    action = fields["action"]
    receipt_id = "zhijun-op-" + fields["requestId"]
    digest = _receipt_digest(fields)
    atom_id = fields.get("id")
    assertion = fields.get("text", "").strip()
    note = json.dumps(
        {
            "threadId": fields.get("threadId"),
            "messageId": fields.get("messageId"),
            "channel": fields.get("channel"),
        }
    )
    with memory.backend.transaction():
        receipt = memory.backend.get_node(receipt_id)
        if receipt is None and legacy_request_id is not None:
            receipt = memory.backend.get_node("zhijun-op-" + legacy_request_id)
            if receipt is not None:
                if action != "remember":
                    raise MemoryConflict("operation id already used")
                # Older phone writes omitted conversation provenance from the digest.
                digest = _receipt_digest(
                    {
                        "action": action,
                        "requestId": legacy_request_id,
                        "text": assertion,
                        "channel": fields["channel"],
                    }
                )
        if receipt:
            if receipt.metadata["digest"] != digest:
                raise MemoryConflict("operation id already used")
            previous = _active(memory, receipt.metadata["atomId"])
            item = _evidence(memory, previous) if previous and action != "forget" else None
            return {"item": item, "applied": True}

        if action == "remember":
            existing = next(
                (
                    atom
                    for atom in memory.list_atoms(limit=-1)
                    if _normalize(atom.assertion) == _normalize(assertion)
                ),
                None,
            )
            atom = existing or memory.create_atom(assertion, entity_name="知君记忆", note=note)[0]
        else:
            if "target" in fields:
                atom_id = _resolve_turn_target(memory, fields["target"])
            atom = _active(memory, atom_id)
            if not atom:
                if memory.get_atom(atom_id):
                    raise MemoryConflict("memory changed")
                raise MemoryMissing("memory not found")
            if action == "correct":
                replacement = memory.replace_atom(atom.id, assertion=assertion, note=note)
                if replacement is None:
                    raise MemoryConflict("memory changed")
                atom = replacement
            elif not memory.deprecate_atom(atom.id, note=note):
                raise MemoryConflict("memory changed")
        now = datetime.now(UTC)
        memory.backend.save_node(
            MemoryNode(
                id=receipt_id,
                parent_id=None,
                level="root",
                content="",
                topic=None,
                conversation_id=None,
                created_at=now,
                updated_at=now,
                metadata={"digest": digest, "atomId": atom.id},
            )
        )
        return {"item": None if action == "forget" else _evidence(memory, atom), "applied": True}


def run_memory(
    root: Path, owner_id: int, fields: dict[str, Any], *, legacy_request_id: str | None = None
) -> dict[str, Any]:
    directory = root / "zhijun-sidebar-memory"
    db = directory / f"user-{owner_id}.sqlite"
    action = fields["action"]
    references = fields.get("references")
    with _LOCK:
        if action == "search" and not db.is_file():
            result: dict[str, Any] = {"items": [], "hasMore": False}
            if references is not None:
                result["references"] = references
            return result
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        memory = Memory("zhijun_sidebar", backend_config={"db_path": str(db)})
        try:
            if action == "search":
                query = fields.get("query", "")
                result = _list(memory, query, fields["limit"], fields["offset"])
                if references is not None:
                    result["references"] = _eligible_references(memory, query, references)
                return result
            return _write(memory, fields, legacy_request_id=legacy_request_id)
        finally:
            saver = getattr(memory, "_checkpointer", None)
            if saver is not None:
                saver.conn.close()
            memory.backend.close()
