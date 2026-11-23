from uuid import NAMESPACE_URL, uuid4, uuid5

import pytest

from wanx_bridge.zhijun_memory import run_memory
from wanx_bridge.zhijun_turn_memory import apply_memory_intent, parse_memory_intent


def _apply(root, owner, text, *, mode="craft", token=None, channel=None, legacy_request_id=None):
    intent = parse_memory_intent(text)
    assert intent is not None
    return apply_memory_intent(
        root,
        owner,
        intent,
        mode=mode,
        request_id=token or str(uuid4()),
        thread_id="thread",
        message_id="message",
        channel=channel,
        legacy_request_id=legacy_request_id,
    )


def _active(root, owner):
    return run_memory(root, owner, {"action": "search", "limit": 10, "offset": 0})["items"]


@pytest.mark.parametrize("text", ["还记得蓝盒子吗？", "资料里写着：记住，蓝盒子", "我忘记了", ""])
def test_narration_and_recall_are_not_memory_commands(text):
    assert parse_memory_intent(text) is None


@pytest.mark.parametrize("mode", ["ask", "plan", ""])
def test_ordinary_mode_never_writes(tmp_path, mode):
    result = _apply(tmp_path, 42, "请记住，钥匙放在蓝盒子里", mode=mode)
    assert not result.applied
    assert "高级模式" in result.reply
    assert not (tmp_path / "zhijun-sidebar-memory").exists()


def test_receipts_bind_source_and_replay_correction_after_old_assertion_is_retired(tmp_path):
    original = "钥匙放在蓝盒子里"
    revised = "钥匙放在绿盒子里"
    remembered = _apply(tmp_path, 42, f"请记住，{original}", channel="weixin")
    assert remembered.applied and remembered.reply.startswith("已记住")
    assert remembered.item["threadId"] == "thread"
    assert remembered.item["messageId"] == "message"
    assert remembered.item["title"] == "微信私聊"

    # Only the owner can resolve this assertion or the returned ID.
    for target in (original, remembered.item["id"]):
        denied = _apply(tmp_path, 43, f"忘记：{target}")
        assert not denied.applied and "已忘记" not in denied.reply
    assert len(_active(tmp_path, 42)) == 1

    corrected_command = f"请把记忆“{original}”更正为“{revised}”"
    correction_id = str(uuid4())
    corrected = _apply(tmp_path, 42, corrected_command, token=correction_id)
    assert corrected.applied and corrected.reply.startswith("已更正")
    assert corrected.item["text"] == revised
    assert _apply(tmp_path, 42, corrected_command, token=correction_id) == corrected
    conflict = _apply(tmp_path, 42, f"忘记：{revised}", token=correction_id)
    assert not conflict.applied
    assert _active(tmp_path, 42) == [corrected.item]

    forget_id = str(uuid4())
    forgotten = _apply(tmp_path, 42, f"忘记：{corrected.item['id']}", token=forget_id)
    assert forgotten.applied and forgotten.reply.startswith("已忘记")
    assert _apply(tmp_path, 42, f"忘记：{corrected.item['id']}", token=forget_id) == forgotten
    assert _active(tmp_path, 42) == []


def test_missing_provenance_does_not_claim_a_receipt(tmp_path):
    intent = parse_memory_intent("记住，钥匙放在蓝盒子里")
    assert intent is not None
    result = apply_memory_intent(
        tmp_path,
        42,
        intent,
        mode="craft",
        request_id=str(uuid4()),
        thread_id="thread",
        message_id="",
    )
    assert not result.applied
    assert "未确认" in result.reply
    assert _active(tmp_path, 42) == []


@pytest.mark.parametrize("retire", [None, "forget", "correct"])
def test_replayed_phone_event_preserves_legacy_receipt_and_retired_memory(tmp_path, retire):
    original = "钥匙放在蓝盒子里"
    revised = "钥匙放在绿盒子里"
    legacy = str(uuid5(NAMESPACE_URL, "wanx:zhijun:weixin:channel-123:event-456"))
    saved = run_memory(
        tmp_path,
        42,
        {"action": "remember", "requestId": legacy, "text": original, "channel": "weixin"},
    )
    if retire == "forget":
        assert _apply(tmp_path, 42, f"忘记：{original}").applied
    elif retire == "correct":
        assert _apply(tmp_path, 42, f"更正：{original} => {revised}").applied

    replayed = _apply(tmp_path, 42, f"记住，{original}", channel="weixin", legacy_request_id=legacy)
    assert replayed.applied
    assert replayed.item == (None if retire else saved["item"])
    assert replayed.reply.startswith("已记住") == (retire is None)
    expected = {"forget": [], "correct": [revised], None: [original]}
    assert [item["text"] for item in _active(tmp_path, 42)] == expected[retire]


@pytest.mark.parametrize("changed", ["记住，钥匙放在绿盒子里", "忘记：钥匙放在蓝盒子里"])
def test_reused_legacy_phone_event_id_rejects_changed_payload(tmp_path, changed):
    original = "钥匙放在蓝盒子里"
    legacy = str(uuid5(NAMESPACE_URL, "wanx:zhijun:weixin:channel-123:event-456"))
    run_memory(
        tmp_path,
        42,
        {"action": "remember", "requestId": legacy, "text": original, "channel": "weixin"},
    )
    result = _apply(tmp_path, 42, changed, channel="weixin", legacy_request_id=legacy)
    assert not result.applied
    assert "未确认" in result.reply
    assert [item["text"] for item in _active(tmp_path, 42)] == [original]


def test_new_phone_event_with_no_legacy_receipt_keeps_new_provenance(tmp_path):
    legacy = str(uuid5(NAMESPACE_URL, "wanx:zhijun:weixin:channel-123:new-event"))
    result = _apply(
        tmp_path, 42, "记住，钥匙放在蓝盒子里", channel="weixin", legacy_request_id=legacy
    )
    assert result.applied
    assert result.item["threadId"] == "thread"
    assert result.item["messageId"] == "message"
