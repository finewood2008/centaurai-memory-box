"""Registration, scope, recovery and readable OpenAPI for the three review pages."""

# ruff: noqa: F811
import json

import httpx
import pytest
from fastapi import FastAPI
from test_semantica_desktop_contract import AUTH, BASE, W, claims, desktop  # noqa: F401
from wanx_bridge.semantica import conversation_contract as contract
from wanx_bridge.semantica.desktop import DesktopError, decode, resolve

EDITOR = {"session": "s" * 32, "generation": "1"}
OP = {"operation_id": "action", "_native_operation_id": "action"}
REV = {**OP, "expected_revision": 1}
SCHEMA = {"entity_types": [], "relation_types": []}


@pytest.mark.parametrize(
    "suffix", ["/onboarding/start", "/onboarding/turns", "/ontology-edit/turns"]
)
@pytest.mark.parametrize(
    "field", ["llm_context_tokens", "context_tokens", "max_tokens", "max_output_tokens"]
)
async def test_dialogue_requests_do_not_expose_a_token_override(desktop, suffix, field):
    client, _, _, seen, _, _ = desktop
    body = {**OP, "expected_revision": 0, "draft_digest": "c" * 64, field: 16384}
    if suffix.endswith("/ontology-edit/turns"):
        body["instruction"] = "修改类型"
    response = await client.post(
        BASE + W + concrete(contract.ONE) + suffix, headers=AUTH, json=body
    )
    assert response.status_code == 422
    assert seen == []


@pytest.mark.parametrize("suffix", ["/onboarding/turns/turn", "/ontology-edit/turns/turn"])
async def test_budget_failure_diagnostics_pass_through_without_private_text(desktop, suffix):
    client, _, _, _, reply, _ = desktop
    info = dict(
        context_tokens=4096,
        input_tokens=3500,
        schema_tokens=1600,
        reserve_tokens=128,
        min_output_tokens=1536,
        max_output_tokens=4096,
        available_output_tokens=-1132,
        required_context_tokens=6764,
        output_token_budget=0,
    )
    payload = {"status": "failed", "error_code": "MODELING_CONTEXT_BUDGET", "context_budget": info}

    async def upstream(request):
        return httpx.Response(200, json=payload)

    reply["handler"] = upstream
    response = await client.get(BASE + W + concrete(contract.ONE) + suffix, headers=AUTH)
    assert response.status_code == 200
    assert response.json() == payload
    from wanx_bridge.semantica.conversation_responses import DialogueContextBudget

    assert DialogueContextBudget.model_validate(info).available_output_tokens == -1132


BODIES = {
    contract.OnboardingStart: {**OP, "expected_revision": 0, "draft_digest": "c" * 64},
    contract.OnboardingTurn: {
        **OP,
        "expected_revision": 0,
        "draft_digest": "c" * 64,
        "content": "为法务部门整理合同",
    },
    contract.OnboardingPreview: {
        **OP,
        "expected_revision": 1,
        "draft_digest": "c" * 64,
        "name": "合同本体",
    },
    contract.OnboardingPublish: {
        **OP,
        "preview_id": "preview",
        "preview_digest": "c" * 64,
        "confirmed": True,
    },
    contract.ChangeRead: {"_native_operation_id": "read-change", "_native_editor": EDITOR},
    contract.ChangeContext: {
        "_native_operation_id": "context",
        "draft_id": "draft",
        "_native_editor": EDITOR,
    },
    contract.GenerateChange: {
        **OP,
        "context_digest": "a" * 64,
        "instruction": "补充付款日期属性",
        "_native_editor": EDITOR,
    },
    contract.ApplyChange: {
        **OP,
        "proposal_digest": "b" * 64,
        "confirmed": True,
        "_native_editor": EDITOR,
    },
    contract.CreateConversation: {**OP, "scenario": "onboarding"},
    contract.OnboardingStart: {**OP, "expected_revision": 0, "draft_digest": "a" * 64},
    contract.OnboardingTurn: {**REV, "draft_digest": "a" * 64, "question_actions": [{"question_id": "audience", "action": "answer", "answer": "研发部门"}]},
    contract.OnboardingPreview: {**REV, "draft_digest": "a" * 64, "name": "研发本体"},
    contract.OnboardingPublish: {**OP, "preview_id": "preview", "preview_digest": "b" * 64, "confirmed": True},
    contract.SendMessage: {**REV, "content": "核对合同付款义务"},
    contract.NativeRevision: REV,
    contract.CreateIntent: REV,
    contract.Analyze: {**OP, "document_version_id": "version"},
    contract.Goal: {
        **REV,
        "expected_conversation_revision": 2,
        "goal": "付款义务",
        "confirmed": True,
    },
    contract.ConfirmPlan: {
        **REV,
        "expected_conversation_revision": 2,
        "plan_digest": "a" * 64,
        "confirmed": True,
    },
    contract.ReviewPlan: {"_native_operation_id": "preview", "_native_editor": EDITOR},
    contract.MergeReview: {
        **REV,
        "_native_editor": EDITOR,
        "plan_digest": "a" * 64,
        "confirmed": True,
    },
    contract.PrepareRules: {
        "operation_id": "draft",
        "proposal_id": "proposal",
        "name": "合同规则",
        "schema": SCHEMA,
        "decisions": [],
    },
    contract.PublishRules: {
        "operation_id": "publish",
        "schema_digest": "a" * 64,
        "confirmed": True,
    },
    contract.Impact: {"base_ontology_id": "base", "schema": SCHEMA},
    contract.ValidateImpact: {
        "base_ontology_id": "base",
        "schema": SCHEMA,
        "preview_token": "a" * 64,
    },
    contract.ExecuteRules: {
        "operation_id": "execute",
        "confirmed": True,
        "mode": "selected",
        "name": "合同规则",
        "preview": {
            "base_ontology_id": "base",
            "schema": SCHEMA,
            "document_ids": ["document"],
            "preview_token": "a" * 64,
        },
    },
    contract.RetryRules: {"operation_id": "retry", "confirmed": True},
}


BODIES.update(contract.material_processing_contract.EXAMPLES)
BODIES.update(contract.source_preparation_contract.EXAMPLES)
BODIES.update(contract.dialogue_round_contract.EXAMPLES)
BODIES.update(contract.ontology_edit_contract.EXAMPLES)


BODIES.update({
    contract.instruction_contract.Read: {"_native_operation_id": "read-plan"},
    contract.instruction_contract.Context: {"_native_operation_id": "context", "intent_id": "intent", "allowed_scopes": ["goal", "extract"]},
    contract.instruction_contract.Interpret: {**OP, "intent_id": "intent", "allowed_scopes": ["goal", "extract"], "context_digest": "a" * 64, "instruction": "修改目标后重新抽取"},
    contract.instruction_contract.ListPlans: {"_native_operation_id": "list", "intent_id": "intent"},
    contract.instruction_contract.Step: REV,
    contract.instruction_contract.Confirm: {**REV, "step_digest": "a" * 64, "confirmed": True},
})


def test_instruction_generation_and_prepare_have_model_budget():
    path = W + concrete(contract.ONE) + "/instruction-plans"
    assert resolve("POST", path).timeout == 285
    assert resolve("POST", path + "/plan/prepare").timeout == 285
    assert resolve("POST", path + "/plan/read").timeout == 45
    assert resolve("POST", path + "/plan/confirm").timeout == 45


def concrete(path):
    return path.format(
        transition_id="transition",
        round_id="round",
        document_id="document",
        conversation_id="conversation",
        intent_id="intent",
        turn_id="turn",
        suggestion_id="suggestion",
        preview_id="preview",
        execution_id="execution",
        proposal_id="proposal",
        plan_id="plan",
    )


def test_change_generation_budget_is_long_but_reads_and_apply_are_short():
    path = W + concrete(contract.INTENT) + "/change-proposals"
    assert resolve("POST", path).timeout == 285
    assert resolve("POST", path + "/proposal/read").timeout == 45
    assert resolve("POST", path + "/proposal/apply").timeout == 45


def test_onboarding_scenario_and_operation_budget():
    assert (
        contract.CreateConversation.model_validate({**OP, "scenario": "onboarding"}).scenario
        == "onboarding"
    )
    path = W + concrete(contract.ONE) + "/onboarding"
    assert resolve("POST", path + "/turns").timeout == 285
    assert resolve("POST", path + "/start").timeout == 285
    assert resolve("GET", path).timeout == 45
    assert resolve("GET", path + "/turns/round").timeout == 45
    assert resolve("POST", path + "/publish").timeout == 45


def test_ontology_copilot_has_bounded_generation_and_shared_change_scenario():
    assert (
        contract.CreateConversation.model_validate({**OP, "scenario": "change"}).scenario
        == "change"
    )
    path = W + concrete(contract.ONE) + "/ontology-edit"
    assert resolve("POST", path + "/turns").timeout == 285
    assert resolve("POST", path + "/preview").timeout == 45
    assert resolve("POST", path + "/execute").timeout == 45


@pytest.mark.parametrize(
    "changes",
    [
        {"workspace_id": "foreign"},
        {"_native_operation_id": "mismatch"},
        {"expected_revision": True},
        {"selected": [{"kind": "fact", "type_kind": "entity", "type_name": "PERSON"}]},
        {
            "selected": [
                {
                    "kind": "entity",
                    "type_kind": "entity",
                    "type_name": "PERSON",
                    "actor_id": "foreign",
                }
            ]
        },
        {"selected": [{"kind": "entity", "type_kind": "entity", "type_name": "PERSON"}] * 21},
        {"instruction": "x" * 8001},
        {"_source": {"conversation_id": "forged"}},
    ],
)
async def test_ontology_edit_rejects_untrusted_scope_and_invalid_selection(desktop, changes):
    client, _, _, seen, _, _ = desktop
    response = await client.post(
        BASE + W + concrete(contract.ONE) + "/ontology-edit/turns",
        headers=AUTH,
        json=BODIES[contract.ontology_edit_contract.Turn] | changes,
    )
    assert response.status_code in (403, 422)
    assert seen == []


def test_question_identity_history_and_scope_only_ontology_are_preserved():
    from wanx_bridge.semantica.conversation_responses import OnboardingDraft

    question = dict(
        question_id="q",
        field="material_sources",
        text="需要历史版本吗？",
        previous_texts=["是否包括历史合同？"],
        status="skipped",
        examples=[],
        answer="",
        source="model",
    )
    scope = dict(
        industry="",
        occupation="",
        service_objects=[],
        purposes=[],
        material_sources=[],
        questions_to_answer=[],
        excluded_scope=[],
        uncertain_items=[],
    )
    payload = dict(
        revision=2,
        round=1,
        base_ontology_id="base",
        purpose_revision=0,
        scope=scope,
        schema=SCHEMA,
        questions=[],
        question_states=[question],
        ontology_proposed=True,
        changes=[],
        scope_changes=[],
    )
    response = OnboardingDraft.model_validate(payload).model_dump(by_alias=True)
    assert response["question_states"][0]["previous_texts"] == question["previous_texts"]
    assert response["question_states"][0]["question_id"] == "q"
    assert response["ontology_proposed"] is True
    assert response["schema"] == SCHEMA


def test_onboarding_recovery_fields_are_documented_and_preserved():
    from wanx_bridge.semantica.conversation_responses import OnboardingState

    scope = dict(
        industry="",
        occupation="",
        service_objects=[],
        purposes=[],
        material_sources=[],
        questions_to_answer=[],
        excluded_scope=[],
        uncertain_items=[],
    )
    payload = dict(
        conversation_id="conversation",
        status="guiding",
        draft_digest="c" * 64,
        draft=dict(
            revision=1,
            round=1,
            base_ontology_id="base",
            purpose_revision=0,
            scope=scope,
            schema=SCHEMA,
            questions=[],
            changes=[],
            scope_changes=[],
        ),
        can_preview=False,
        active_turn_id="pending-round",
        seed={"profile": {"background": "原始背景"}},
        progress={},
        turns={"items": [], "has_more": False, "next_offset": 1},
        publication=None,
        publication_effective=False,
        publication_performed=False,
    )
    wire = OnboardingState.model_validate(payload).model_dump(by_alias=True)
    assert wire["active_turn_id"] == "pending-round"
    assert wire["seed"] == payload["seed"]
    properties = OnboardingState.model_json_schema()["properties"]
    assert "active_turn_id" in properties
    assert "seed" in properties
    legacy = payload.copy()
    legacy.pop("active_turn_id")
    legacy.pop("seed")
    assert OnboardingState.model_validate(legacy).active_turn_id is None


@pytest.mark.parametrize(
    "changes",
    [
        {"workspace_id": "foreign"},
        {"_native_operation_id": "different"},
        {"expected_revision": True},
        {"draft_digest": "bad"},
        {"content": "x" * 8001},
        {"permissions": ["write"]},
        {"_native_editor": EDITOR},
        {"question_actions": [{"question_id": "q", "action": "publish"}]},
        {"question_actions": [{"question_id": "q", "action": "skip", "workspace_id": "foreign"}]},
        {"question_actions": [{"question_id": "q", "action": "skip"}] * 3},
    ],
)
async def test_onboarding_rejects_untrusted_scope_and_invalid_body(desktop, changes):
    client, _, _, seen, _, _ = desktop
    response = await client.post(
        BASE + W + concrete(contract.ONE) + "/onboarding/turns",
        headers=AUTH,
        json=BODIES[contract.OnboardingTurn] | changes,
    )
    assert response.status_code in (403, 422)
    assert seen == []


async def test_question_actions_are_passed_without_inventing_answers(desktop):
    client, _, _, seen, _, _ = desktop
    actions = [{"question_id": "q", "action": "uncertain"}]
    response = await client.post(
        BASE + W + concrete(contract.ONE) + "/onboarding/turns",
        headers=AUTH,
        json={**BODIES[contract.OnboardingTurn], "content": "", "question_actions": actions},
    )
    assert response.status_code == 200
    assert json.loads(seen[0].content)["question_actions"] == actions


@pytest.mark.parametrize("method,path,summary,model,query", contract.ROUTES)
async def test_registration_and_scoped_transport(desktop, method, path, summary, model, query):
    client, _, _, seen, _, app = desktop
    body = BODIES.get(model)
    route = W + concrete(path)
    response = await client.request(method, BASE + route, headers=AUTH, json=body)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    request = seen[0]
    grant = claims(request)
    assert grant["actor_id"] == "wanx:7"
    assert grant["operation_id"] == (body or {}).get(
        "operation_id", (body or {}).get("_native_operation_id")
    )
    assert (json.loads(request.content) if body else None) == body
    if path.startswith("/modeling/"):
        assert (
            request.url.path
            == "/api/integration/modeling/warehouses/"
            + grant["workspace_id"]
            + concrete(path)[len("/modeling") :]
        )
    else:
        assert request.url.path == "/api/integration" + concrete(path)
    doc = app.openapi()["paths"][BASE + contract.PREFIX + path][method.lower()]
    assert doc["summary"] == summary
    assert str(contract.success_status(method, path)) in doc["responses"]
    response_schema = doc["responses"][str(contract.success_status(method, path))]["content"][
        "application/json"
    ]["schema"]
    assert response_schema["properties"]
    assert response_schema["required"]
    assert "$ref" not in json.dumps(response_schema)
    assert "$ref" not in json.dumps(doc.get("requestBody"))
    assert {p["name"] for p in doc["parameters"] if p["in"] == "query"} == set(query)
    if model:
        assert (
            doc["requestBody"]["content"]["application/json"]["schema"]["additionalProperties"]
            is False
        )


@pytest.mark.parametrize("method,path,summary,model,query", contract.ROUTES)
async def test_team_new_endpoints_do_not_fall_back_to_core(
    desktop, method, path, summary, model, query
):
    client, _, _, seen, _, _ = desktop
    response = await client.request(
        method,
        BASE + W + concrete(path),
        headers={**AUTH, "x-wanx-data-context": "team"},
        json=BODIES.get(model),
    )
    assert response.status_code == 403
    assert seen == []


@pytest.mark.parametrize(
    "changes",
    [
        {"_native_operation_id": "wrong"},
        {"expected_revision": True},
        {"content": "x" * 8001},
        {"workspace_id": "other"},
        {"extra": {"actor_id": "other"}},
        {"_native_editor": EDITOR},
    ],
)
async def test_invalid_dialogue_payload_never_reaches_owner(desktop, changes):
    client, _, _, seen, _, _ = desktop
    response = await client.post(
        BASE + W + concrete(contract.ONE) + "/messages",
        headers=AUTH,
        json=BODIES[contract.SendMessage] | changes,
    )
    assert response.status_code in {403, 422}
    assert seen == []


@pytest.mark.parametrize(
    "query",
    [
        "limit=51",
        "offset=-1",
        "offset=true",
        "offset=9007199254740992",
        "limit=2&limit=3",
        "workspace_id=other",
        "after_sequence=1",
    ],
)
async def test_bounded_queries(desktop, query):
    client, _, _, seen, _, _ = desktop
    response = await client.get(BASE + W + contract.C + "?" + query, headers=AUTH)
    assert response.status_code == 422
    assert seen == []


@pytest.mark.parametrize(
    "body",
    [
        {"_native_operation_id": "preview"},
        {
            "_native_operation_id": "preview",
            "_native_editor": {"session": "short", "generation": "1"},
        },
        {"_native_operation_id": "preview", "_native_editor": {**EDITOR, "generation": 1}},
        {**BODIES[contract.ReviewPlan], "path": "/api/settings"},
    ],
)
async def test_review_plan_is_not_an_arbitrary_read_or_editor_header_proxy(desktop, body):
    client, _, _, seen, _, _ = desktop
    response = await client.post(
        BASE + W + concrete(contract.INTENT) + "/review-plan", headers=AUTH, json=body
    )
    assert response.status_code == 422
    assert seen == []


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", contract.C),
        ("GET", contract.INTENT + "/review-plan"),
        ("DELETE", contract.ONE),
        ("POST", contract.ONE + "/publish"),
        ("GET", "/modeling/rule-executions"),
        ("POST", contract.ONE + "/../intents"),
    ],
)
def test_no_unscoped_or_unused_operations(method, path):
    target = concrete(path)
    if path != contract.C:
        target = W + target
    with pytest.raises(DesktopError):
        resolve(method, target)


async def test_account_switch_origin_size_and_mount(desktop):
    client, _, profile, seen, reply, app = desktop
    path = BASE + W + contract.C
    assert (await client.get(path, headers={**AUTH, "origin": "http://bridge"})).status_code == 403
    assert (
        await client.post(
            path,
            headers={**AUTH, "content-type": "application/json"},
            content=b" " * (128 * 1024 + 1),
        )
    ).status_code == 413
    assert not seen
    parent = FastAPI()
    parent.mount("/box", app)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=parent), base_url="http://bridge"
    ) as mounted:
        assert (await mounted.get("/box" + path, headers=AUTH)).status_code == 200
    assert "/box/" not in seen[-1].url.path

    async def switch(request):
        profile["id"] = 8
        return httpx.Response(200, json={"private": "original-user-message"})

    reply["handler"] = switch
    response = await client.get(path, headers=AUTH)
    assert response.status_code == 403
    assert "original-user-message" not in response.text


@pytest.mark.parametrize("code", sorted(contract.ERROR_CODES))
def test_safe_domain_errors(code):
    with pytest.raises(DesktopError) as error:
        decode(
            409,
            json.dumps({"code": code, "detail": "private", "message": "private"}).encode(),
            modeling=True,
        )
    assert error.value.code == code
    assert error.value.message is None


@pytest.mark.parametrize(
    "code,status", [("LLM_NOT_CONFIGURED", 409), ("MODELING_CONTEXT_BUDGET", 422)]
)
async def test_actionable_plan_errors_are_not_generic_conflicts(desktop, code, status):
    client, _, _, _, reply, _ = desktop

    async def fail(request):
        return httpx.Response(
            status,
            json={"code": code, "detail": "private model connection", "message": "private goal"},
        )

    reply["handler"] = fail
    response = await client.get(BASE + W + concrete(contract.INTENT) + "/plan", headers=AUTH)
    assert response.status_code == status
    assert response.json() == {"code": code, "message": None}


async def test_warehouse_guidance_progress_and_deferred_questions_pass_through(desktop):
    client, _, _, seen, reply, app = desktop
    progress = {
        "round": 7,
        "suggested_rounds": [0, 5],
        "covered_fields": ["industry", "occupation"],
        "missing_fields": [],
        "forced_round_limit": True,
        "guidance_rounds": 5,
        "max_guidance_rounds": 5,
        "remaining_rounds": 0,
        "questions_per_round": 1,
        "scope_level": "warehouse",
        "next_priority_field": None,
        "guidance_complete": True,
    }
    payload = {
        "progress": progress,
        "draft": {
            "questions": [],
            "question_states": [
                {
                    "question_id": "deferred-q",
                    "field": "ontology",
                    "text": "后续补充属性？",
                    "status": "deferred",
                }
            ],
        },
    }

    async def upstream(request):
        return httpx.Response(200, json=payload)

    reply["handler"] = upstream
    response = await client.get(BASE + W + concrete(contract.ONE) + "/onboarding", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == payload
    assert seen
    from wanx_bridge.semantica.conversation_responses import (
        OnboardingProgress,
        OnboardingQuestion,
        OnboardingState,
    )

    assert OnboardingProgress.model_validate(progress).scope_level == "warehouse"
    assert (
        OnboardingQuestion.model_validate(payload["draft"]["question_states"][0]).status
        == "deferred"
    )
    assert "OnboardingProgress" in OnboardingState.model_json_schema()["$defs"]
