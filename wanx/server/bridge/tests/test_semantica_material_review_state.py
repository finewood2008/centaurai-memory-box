"""Material review metadata passes unchanged; read routes remain read-only and scoped."""
# ruff: noqa: F811
import json

import pytest
from pydantic import ValidationError
from test_semantica_desktop_contract import AUTH, BASE, W, desktop  # noqa: F401

from wanx_bridge.semantica import conversation_contract as contract
from wanx_bridge.semantica.conversation_responses import (
    MaterialDraftState,
    MaterialExtractionReview,
)

COUNTS = {"adoptable_entity_count": 60, "adoptable_relation_count": 50, "excluded_candidate_count": 34}
COUNT_CASES = [None, COUNTS, {**COUNTS, "adoptable_entity_count": 0,
                            "adoptable_relation_count": 0, "excluded_candidate_count": 144}]


@pytest.mark.parametrize("counts", COUNT_CASES, ids=["legacy", "mixed", "all-excluded"])
@pytest.mark.parametrize("listing", [False, True])
async def test_material_review_fields_forwarded_without_changing_policy(desktop, listing, counts):
    client, _, profile, seen, reply, _ = desktop
    workflow = {
        "document_id": "document", "stage": "awaiting_review", "processing_mode": "automatic",
        "draft": {"status": "editing", "revision": 1, "source_current": True,
                  "has_changes": False, "change_count": 0, "ontology_changed": False},
        "publication": {"id": "published-run", "status": "published", "entity_count": 44, "relation_count": 25},
        "publication_policy": "review_required",
        "extraction_review": {"run_id": "new-run", "reason_code": "EXTRACTION_COMPLETENESS_REVIEW",
            "message": "Review candidates", "next_action": "review_candidates",
            "entity_count": 73, "relation_count": 71,
            "publication_blockers": [{"code": "EXTRACTION_COMPLETENESS_REVIEW", "message": "Review candidates"}],
            "issues": [{"batch_index": 0, "stage": "relations", "reason": "NO_NEW_RESULTS",
                        "audit_rounds": 1, "message": "Coverage not confirmed"}]},
        "future_field": {"preserved": True},
    }
    if counts is not None:
        workflow["extraction_review"].update(counts)
    payload = {"items": [workflow], "total": 1, "offset": 0, "limit": 50} if listing else workflow
    reply.update(status=200, value=payload)
    path = BASE + W + "/workbench/conversations/materials" + ("" if listing else "/document")
    response = await client.get(path, headers=AUTH)
    assert response.status_code == 200
    assert response.json() == payload
    assert response.headers["cache-control"] == "no-store"
    assert len(seen) == 1 and seen[0].method == "GET"
    profile["permissions"] = []
    denied = await client.get(path, headers=AUTH)
    assert denied.status_code == 403
    assert len(seen) == 1


@pytest.mark.parametrize("suffix,query", [
    ("/workbench/conversations/materials/{document_id}", {}),
    ("/workbench/conversations/materials", contract.PAGE),
])
def test_openapi_documents_review_and_actual_change_fields(suffix, query):
    schema = contract.schema_extra("GET", suffix, None, query)
    response = schema["responses"]["200"]["content"]["application/json"]["schema"]
    if "items" in response["properties"]:
        response = response["properties"]["items"]["items"]
    props = response["properties"]
    draft = next(x for x in props["draft"]["anyOf"] if x.get("type") == "object")
    assert {"has_changes", "change_count", "ontology_changed"} <= draft["properties"].keys()
    review = next(x for x in props["extraction_review"]["anyOf"] if x.get("type") == "object")
    assert {"reason_code", "issues", "next_action", "entity_count", "relation_count", "publication_blockers"} <= review["properties"].keys()
    for name in COUNTS:
        field = review["properties"][name]
        assert name not in review["required"]
        assert "not zero" in field["description"]
        integer = next(x for x in field["anyOf"] if x.get("type") == "integer")
        assert integer["minimum"] == 0
    publication = next(x for x in props["publication"]["anyOf"] if x.get("type") == "object")
    assert {"entity_count", "relation_count"} <= publication["properties"].keys()
    assert "$ref" not in json.dumps(schema)


def test_old_owner_missing_fields_remain_unknown():
    old = MaterialDraftState(status="editing", revision=1, source_current=True)
    assert old.has_changes is None
    assert old.change_count is None


@pytest.mark.parametrize("counts", COUNT_CASES, ids=["legacy", "mixed", "all-excluded"])
async def test_current_extraction_metadata_forwarded_without_mutation(desktop, counts):
    client, _, profile, seen, reply, _ = desktop
    payload = {"run_id": "run", "review_reference": {"run_id": "run"},
        "entity_count": 73, "relation_count": 71,
        "publication_blockers": [{"code": "EXTRACTION_COMPLETENESS_REVIEW", "message": "Review candidates"}],
        "publication": {"id": "published", "entity_count": 44, "relation_count": 25}}
    reply.update(status=200, value=payload)
    if counts is not None:
        payload.update(counts)
    path = BASE + W + "/workbench/documents/document/corrections/current-extraction"
    response = await client.get(path, headers=AUTH)
    assert response.status_code == 200
    assert response.json() == payload
    assert len(seen) == 1 and seen[0].method == "GET"
    assert response.headers["cache-control"] == "no-store"
    profile["permissions"] = []
    denied = await client.get(path, headers=AUTH)
    assert denied.status_code == 403
    assert len(seen) == 1


def review_payload(**extra):
    return {"run_id": "run", "reason_code": "EXTRACTION_REVIEW_REQUIRED", "message": "Review",
            "issues": [], "next_action": "review_candidates", "entity_count": 73,
            "relation_count": 71, **extra}


@pytest.mark.parametrize("counts", COUNT_CASES)
def test_review_counts_remain_optional_and_preserve_total_semantics(counts):
    payload = review_payload(**(counts or {}))
    review = MaterialExtractionReview.model_validate(payload)
    assert review.model_dump(exclude_unset=True) == payload
    assert review.entity_count == 73 and review.relation_count == 71
    for name in COUNTS:
        assert getattr(review, name) == (counts[name] if counts is not None else None)


@pytest.mark.parametrize("name", list(COUNTS))
@pytest.mark.parametrize("value", [None, 0, 4])
def test_review_counts_accept_unknown_and_nonnegative_integers(name, value):
    review = MaterialExtractionReview.model_validate(review_payload(**{name: value}))
    assert getattr(review, name) == value


@pytest.mark.parametrize("name", list(COUNTS))
@pytest.mark.parametrize("value", [-1, True, 1.5, "3"])
def test_review_count_schema_rejects_invalid_values(name, value):
    with pytest.raises(ValidationError):
        MaterialExtractionReview.model_validate(review_payload(**{name: value}))
