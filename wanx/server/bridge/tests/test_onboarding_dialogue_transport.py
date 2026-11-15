"""Real dialogue envelopes must cross both Bridge admission boundaries."""
import json

import pytest
from centuarai_local_data_gate import starlink_workbench as shared
from wanx_bridge.semantica import conversation_contract as contract
from wanx_bridge.semantica.desktop import DesktopError, decode
from wanx_bridge.semantica.transport_contract import grant_ttl, operation_timeout

BASE = "/workbench/conversations/conversation/onboarding"
OP = {"operation_id": "operation", "_native_operation_id": "operation"}
REV = {**OP, "expected_revision": 0, "draft_digest": "a" * 64}


@pytest.mark.parametrize("path,body", [
    ("/workbench/conversations", {**OP, "scenario": "onboarding"}),
    ("/workbench/conversations", {**OP, "scenario": "material"}),
    (BASE + "/start", REV),
    (BASE + "/turns", {**REV, "content": "研发部门"}),
    (BASE + "/turns", {**REV, "content": "", "question_actions": [{"question_id": "audience", "action": "answer", "answer": "部门"}]}),
    (BASE + "/turns", {**REV, "question_actions": [{"question_id": "purpose", "action": "skip"}]}),
    (BASE + "/turns", {**REV, "question_actions": [{"question_id": "purpose", "action": "uncertain"}]}),
    (BASE + "/preview", {**REV, "name": "研发规则"}),
    (BASE + "/publish", {**OP, "preview_id": "preview", "preview_digest": "b" * 64, "confirmed": True}),
])
def test_dialogue_envelopes_survive_both_contracts_unchanged(path, body):
    assert contract.prepare("POST", path, body, {}) == (body, "operation")
    shared.validate_query("POST", path, {})
    assert shared.validate_body("POST", path, body) == "operation"


@pytest.mark.parametrize("body", [
    REV,
    {**REV, "content": " "},
    {**REV, "expected_revision": -1, "content": "研发"},
    {**REV, "draft_digest": "bad", "content": "研发"},
    {**REV, "content": "研发", "workspace_id": "foreign"},
    {**REV, "content": "研发", "operation_id": "different"},
    {**REV, "question_actions": [{"question_id": "q", "action": "answer", "answer": ""}]},
    {**REV, "question_actions": [{"question_id": "q", "action": "skip", "answer": "不是回答"}]},
    {**REV, "question_actions": [{"question_id": "q", "action": "skip", "actor_id": "foreign"}]},
    {**REV, "question_actions": [{"question_id": "q", "action": "skip"}] * 2},
    {**REV, "question_actions": [{"question_id": str(i), "action": "skip"} for i in range(3)]},
    {**REV, "content": "文" * 8000, "question_actions": [{"question_id": "q", "action": "answer", "answer": "超"}]},
])
def test_invalid_turns_are_rejected_at_both_boundaries(body):
    with pytest.raises((ValueError, PermissionError)):
        contract.prepare("POST", BASE + "/turns", body, {})
    with pytest.raises(ValueError):
        shared.validate_body("POST", BASE + "/turns", body)


@pytest.mark.parametrize("confirmed", [False, "true", 1, None])
def test_publication_still_requires_explicit_boolean_confirmation(confirmed):
    body = {**OP, "preview_id": "preview", "preview_digest": "b" * 64, "confirmed": confirmed}
    with pytest.raises(ValueError):
        contract.prepare("POST", BASE + "/publish", body, {})
    with pytest.raises(ValueError):
        shared.validate_body("POST", BASE + "/publish", body)


def test_reads_resources_and_generation_budget():
    contract.prepare("GET", BASE, None, {"offset": "0", "limit": "50"})
    shared.validate_query("GET", BASE, {"offset": "0", "limit": "50"})
    assert shared.resource_ids("GET", BASE + "/turns/turn") == {"conversation_id": "conversation", "turn_id": "turn"}
    for path in (BASE + "/start", BASE + "/turns"):
        assert operation_timeout(path) == 285
        assert grant_ttl(operation_timeout(path)) == 300
    for path in (BASE, BASE + "/turns/turn", BASE + "/preview", BASE + "/publish"):
        assert operation_timeout(path) == 45


@pytest.mark.parametrize("code", sorted(c for c in contract.ERROR_CODES if c.startswith("MODELING_ONBOARDING_") or c == "MODELING_SCENARIO_MISMATCH"))
def test_onboarding_errors_keep_safe_codes_without_diagnostics(code):
    with pytest.raises(DesktopError) as error:
        decode(409, json.dumps({"detail": {"code": code, "message": "private diagnostics"}}).encode(), modeling=True)
    assert error.value.code == code
    assert "private diagnostics" not in str(error.value)


@pytest.mark.parametrize("code", ["MODELING_ONBOARDING_BUSY", "MODELING_ONBOARDING_STALE", "MODELING_ONBOARDING_QUESTION_STALE", "MODELING_OPERATION_CONFLICT", "MODELING_CONFIRMATION_REQUIRED"])
@pytest.mark.parametrize("status", [409, 422])
def test_both_host_adapters_preserve_recovery_codes_and_status(code, status):
    import httpx
    from wanx_bridge.semantica.client import SemanticaClient, SemanticaError
    response = httpx.Response(status, json={"detail": {"code": code, "message": "private diagnostics"}})
    with pytest.raises(SemanticaError) as error:
        SemanticaClient.decode(response, native_workbench=True)
    assert error.value.code == code
    assert error.value.status == status
    assert "private diagnostics" not in str(error.value)
    with pytest.raises(DesktopError) as error:
        decode(status, response.content, native_workbench=True, modeling=True)
    assert error.value.code == code
    assert error.value.status == status


def test_client_does_not_expose_unregistered_errors_or_enable_modeling_errors_on_public_calls():
    import httpx
    from wanx_bridge.semantica.client import SemanticaClient, SemanticaError
    for code, native in [("MODELING_UNKNOWN_PRIVATE", True), ("MODELING_ONBOARDING_BUSY", False), ({"secret": "private diagnostics"}, True)]:
        with pytest.raises(SemanticaError) as error:
            SemanticaClient.decode(httpx.Response(409, json={"detail": {"code": code, "message": "private diagnostics"}}), native_workbench=native)
        assert error.value.code == "SEMANTICA_VERSION_CONFLICT"
        assert "private diagnostics" not in str(error.value)


@pytest.mark.parametrize("path,body", [
    (BASE + "/start", {**REV, "expected_revision": 9007199254740992}),
    (BASE + "/preview", {**REV, "name": "   "}),
])
def test_bridge_and_shared_validation_agree_on_onboarding_bounds(path, body):
    with pytest.raises(ValueError):
        contract.prepare("POST", path, body, {})
    with pytest.raises(ValueError):
        shared.validate_body("POST", path, body)
