"""Finite owner-workbench transport contract shared by WANX and its box bridge."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

ID = r"[A-Za-z0-9_-]{1,128}"
PAGE = frozenset({"limit", "offset"})
SAFE_INTEGER = 9007199254740991
CONVERSATION = rf"/workbench/conversations/(?P<conversation_id>{ID})"
INTENT = CONVERSATION + rf"/intents/(?P<intent_id>{ID})"
TURN = CONVERSATION + rf"/turns/(?P<turn_id>{ID})"
CORRECTION = rf"/workbench/documents/(?P<document_id>{ID})/corrections"
DRAFT = CORRECTION + rf"/(?P<draft_id>{ID})"
REVISION_PAGE = PAGE | {"revision"}

# Every method, path and operation is registered explicitly. Resource IDs are
# only references; the service must also check their actual warehouse and
# parent membership under the verified principal before calling the domain.
MATERIAL_ROUTES: tuple[tuple[str, str, frozenset[str], str], ...] = (
    ("GET", rf"/workbench/knowledge/runs/(?P<run_id>{ID})", frozenset(), "get_knowledge_run"),
    ("POST", "/workbench/ontology-suggestions/generate", frozenset(), "generate_ontology_suggestions"),
    ("POST", "/workbench/ontology-suggestions/draft", frozenset(), "draft_ontology_suggestions"),
    ("POST", rf"/workbench/ontology-suggestions/(?P<suggestion_preview_id>{ID})/validate", frozenset(), "validate_ontology_suggestions"),
    ("POST", r"/workbench/conversations", frozenset(), "create_conversation"),
    ("GET", r"/workbench/conversations", PAGE, "list_conversations"),
    ("GET", r"/workbench/conversations/materials", PAGE, "list_material_workflows"),
    ("GET", rf"/workbench/conversations/materials/(?P<document_id>{ID})", frozenset(), "get_material_workflow"),
    ("GET", CONVERSATION + "/onboarding", PAGE, "get_onboarding_state"),
    ("POST", CONVERSATION + "/onboarding/start", frozenset(), "start_onboarding"),
    ("POST", CONVERSATION + "/onboarding/turns", frozenset(), "send_onboarding_turn"),
    ("GET", CONVERSATION + rf"/onboarding/turns/(?P<turn_id>{ID})", frozenset(), "get_onboarding_turn"),
    ("POST", CONVERSATION + "/onboarding/preview", frozenset(), "preview_onboarding"),
    ("POST", CONVERSATION + "/onboarding/publish", frozenset(), "publish_onboarding"),
    ("GET", CONVERSATION, frozenset({"intent_offset"}), "get_conversation"),
    ("GET", CONVERSATION + "/intents", PAGE, "list_conversation_intents"),
    ("GET", CONVERSATION + "/messages", frozenset({"after_sequence", "limit"}), "list_conversation_messages"),
    ("POST", CONVERSATION + "/messages", frozenset(), "send_conversation_message"),
    ("GET", CONVERSATION + "/turns", PAGE, "list_conversation_turns"),
    ("GET", TURN, frozenset(), "get_conversation_turn"),
    ("POST", TURN + "/cancel", frozenset(), "cancel_conversation_turn"),
    ("POST", TURN + "/retry", frozenset(), "retry_conversation_turn"),
    ("POST", CONVERSATION + "/intents", frozenset(), "create_material_intent"),
    ("GET", INTENT, frozenset(), "get_material_intent"),
    ("POST", INTENT + "/goal", frozenset(), "prepare_material_goal"),
    ("POST", INTENT + "/analyze", frozenset(), "analyze_material"),
    ("POST", INTENT + "/cancel", frozenset(), "cancel_material_intent"),
    ("GET", INTENT + "/plan", frozenset(), "plan_material_extraction"),
    ("POST", INTENT + "/confirm", frozenset(), "confirm_material_extraction"),
    ("GET", INTENT + "/candidates", PAGE, "list_material_candidates"),
    ("POST", INTENT + "/retry", frozenset(), "retry_material_extraction"),
    ("POST", INTENT + "/review-plan", PAGE | {"draft_id"}, "preview_material_review"),
    ("POST", INTENT + "/review", frozenset(), "merge_material_review"),
    ("POST", INTENT + "/change-context", frozenset(), "get_material_change_context"),
    ("POST", INTENT + "/change-proposals", frozenset(), "generate_material_change"),
    ("POST", INTENT + rf"/change-proposals/(?P<proposal_id>{ID})/read", frozenset(), "read_material_change"),
    ("POST", INTENT + rf"/change-proposals/(?P<proposal_id>{ID})/apply", frozenset(), "apply_material_change"),
    ("POST", "/workbench/_correction_read", frozenset(), "correction_read"),
    ("POST", CORRECTION + "/sessions", frozenset(), "create_correction_session"),
    ("GET", CORRECTION + "/leases", frozenset(), "list_correction_leases"),
    ("GET", CORRECTION + "/current-extraction", frozenset(), "get_correction_current_extraction"),
    ("POST", CORRECTION + "/current-extraction/draft", frozenset(), "open_correction_extraction_review"),
    ("POST", CORRECTION, frozenset(), "open_correction_draft"),
    ("GET", CORRECTION + "/events", frozenset({"after_id", "limit"}), "list_correction_events"),
    ("GET", CORRECTION + r"/events/(?P<event_id>[0-9]{1,16})", PAGE, "get_correction_event"),
    ("GET", DRAFT, frozenset(), "get_correction_draft"),
    ("GET", DRAFT + "/items", REVISION_PAGE | {"kind", "keyword"}, "list_correction_items"),
    ("GET", DRAFT + rf"/items/(?P<item_id>{ID})", frozenset({"revision"}), "get_correction_item"),
    ("GET", DRAFT + rf"/items/(?P<item_id>{ID})/relations", REVISION_PAGE, "list_correction_item_relations"),
    ("GET", DRAFT + "/sources", REVISION_PAGE, "list_correction_sources"),
    ("GET", DRAFT + rf"/sources/(?P<segment_id>{ID})", frozenset({"revision", "start"}), "get_correction_source"),
    ("GET", DRAFT + "/preview", REVISION_PAGE, "preview_correction_draft"),
    ("GET", DRAFT + "/suggestions", REVISION_PAGE | {"kind"}, "list_correction_suggestions"),
    ("GET", DRAFT + "/extraction-results", REVISION_PAGE | {"kind"}, "list_correction_extraction_results"),
    ("GET", DRAFT + "/publication", frozenset(), "get_correction_publication"),
)
CORRECTION_ACTIONS = (
    ("claim", "claim_correction_draft"),
    ("heartbeat", "heartbeat_correction_draft"),
    ("release", "release_correction_draft"),
    ("save", "save_correction_draft"),
    ("discard", "discard_correction_draft"),
    ("submit", "submit_correction_draft"),
    ("rebase", "rebase_correction_draft"),
    ("ontology", "select_correction_ontology"),
    ("rules", "prepare_correction_rules"),
    ("apply", "apply_correction_review"),
    ("suggestions/adopt", "adopt_correction_suggestion"),
    ("extraction-results/adopt", "adopt_correction_extraction_result"),
    ("publication/retry", "retry_correction_publication"),
    (rf"items/(?P<item_id>{ID})/reset", "reset_correction_item"),
)
ROUTES: tuple[tuple[str, str, frozenset[str], str], ...] = (
    ("GET", r"/workbench/settings/status", frozenset(), "workbench_status"),
    ("GET", r"/workbench/jobs", PAGE, "list_jobs"),
    ("GET", r"/workbench/documents", PAGE, "list_documents"),
    (
        "GET",
        rf"/workbench/documents/{ID}",
        frozenset({"segment_offset", "segment_limit"}),
        "get_document",
    ),
    ("GET", r"/workbench/ontologies", frozenset(), "list_ontologies"),
    ("POST", r"/workbench/ontologies", frozenset(), "create_ontology"),
    ("POST", rf"/workbench/ontologies/{ID}/publish", frozenset(), "publish_ontology"),
    (
        "GET",
        rf"/workbench/ontology-updates/{ID}",
        frozenset({"offset", "scope"}),
        "read_ontology_impact",
    ),
    (
        "POST",
        rf"/workbench/ontology-updates/(?P<ontology_id>{ID})/start",
        frozenset(),
        "start_ontology_update",
    ),
) + MATERIAL_ROUTES + tuple(
    ("POST", DRAFT + "/" + path, frozenset(), operation)
    for path, operation in CORRECTION_ACTIONS
)
_SELECTORS = frozenset(
    {
        "workspace_id",
        "workspace_ids",
        "workspaceId",
        "workspaceIds",
        "warehouse_id",
        "warehouse_ids",
        "warehouseId",
        "warehouseIds",
        "actor_id",
        "actorId",
        "principal_id",
        "principalId",
        "principalNamespace",
        "principal_namespace",
        "box_id",
        "boxId",
        "application_id",
        "applicationId",
        "resource_owner",
        "resourceOwner",
        "organization_permissions",
        "organizationPermissions",
        "ownership_epoch",
        "ownershipEpoch",
        "permissions",
        "owner_view",
        "ownerView",
    }
)


def query_keys(method: str, path: str) -> frozenset[str] | None:
    for allowed_method, pattern, keys, _ in ROUTES:
        if method == allowed_method and re.fullmatch(pattern, path):
            return keys
    return None


def operation_name(method: str, path: str) -> str | None:
    for allowed_method, pattern, _, operation in ROUTES:
        if method == allowed_method and re.fullmatch(pattern, path):
            return operation
    return None


def selectable_scope(value: Any) -> bool:
    # The envelope selects authority; schema is opaque business data validated
    # by Semantica, and its property names must never select a request scope.
    return isinstance(value, dict) and bool(_SELECTORS & value.keys())


def validate_query(method: str, path: str, query: Mapping[str, str]) -> None:
    keys = query_keys(method, path)
    if keys is None or set(query) - keys:
        raise ValueError("workbench query is not allowed")
    operation = operation_name(method, path)
    limit = 200 if path == "/workbench/jobs" else 500 if path == "/workbench/documents" else 50
    if operation == "list_conversation_messages":
        limit = 100
    page_bounds = {
        "limit": (1, limit),
        "offset": (0, SAFE_INTEGER if operation in MATERIAL_OPERATIONS else 2147483647),
        "segment_limit": (1, 200),
        "segment_offset": (0, 2147483647),
        "intent_offset": (0, SAFE_INTEGER),
        "after_sequence": (0, SAFE_INTEGER),
        "after_id": (0, SAFE_INTEGER),
        "revision": (1, SAFE_INTEGER),
        "start": (0, SAFE_INTEGER),
    }
    for name, (minimum, maximum) in page_bounds.items():
        if name not in query:
            continue
        value = query[name]
        if (
            not isinstance(value, str)
            or len(value) > 16
            or re.fullmatch(r"0|[1-9][0-9]*", value) is None
            or not minimum <= int(value) <= maximum
        ):
            raise ValueError("workbench page is not allowed")
    if method == "GET" and path.startswith("/workbench/ontology-updates/") and query.get("scope") != "selectable":
        raise ValueError("workbench impact is read-only selectable scope")
    if any(not isinstance(value, str) for value in query.values()):
        raise ValueError("workbench query values must be strings")
    if "draft_id" in query and re.fullmatch(ID, query["draft_id"]) is None:
        raise ValueError("workbench draft reference is invalid")
    if "kind" in query and query["kind"] not in {"entity", "relation"}:
        raise ValueError("workbench correction kind is invalid")
    if "keyword" in query and len(query["keyword"]) > 200:
        raise ValueError("workbench correction keyword is too long")
    if "revision" in keys and "revision" not in query:
        raise ValueError("workbench correction revision is required")


def validate_body(method: str, path: str, body: dict[str, Any] | None) -> str | None:
    if query_keys(method, path) is None:
        raise ValueError("workbench operation is not allowed")
    if method == "GET":
        if body is not None:
            raise ValueError("workbench read cannot carry a body")
        return None
    operation_name_value = operation_name(method, path)
    if operation_name_value in MATERIAL_OPERATIONS:
        return _material_body(operation_name_value, body)
    expected = {"_native_operation_id"}
    if path == "/workbench/ontologies":
        expected |= {"name", "schema"}
    if operation_name_value == "start_ontology_update":
        expected |= {"operation_id", "confirmed", "selections"}
    if not isinstance(body, dict) or set(body) != expected or selectable_scope(body):
        raise ValueError("workbench body is not allowed")
    operation = body["_native_operation_id"]
    if not isinstance(operation, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,120}", operation) is None:
        raise ValueError("workbench operation id is required")
    if operation_name_value == "start_ontology_update":
        selections = body["selections"]
        if (body["operation_id"] != operation or body["confirmed"] is not True
                or not isinstance(selections, list) or not 1 <= len(selections) <= 20):
            raise ValueError("workbench ontology update requires confirmed selections")
        document_ids = set()
        for selection in selections:
            if (not isinstance(selection, dict) or set(selection) != {"document_id", "preview_token"}
                    or not isinstance(selection["document_id"], str)
                    or re.fullmatch(ID, selection["document_id"]) is None
                    or not isinstance(selection["preview_token"], str)
                    or re.fullmatch(r"[0-9a-f]{64}", selection["preview_token"]) is None
                    or selection["document_id"] in document_ids):
                raise ValueError("workbench ontology update selection is invalid")
            document_ids.add(selection["document_id"])
    if path == "/workbench/ontologies" and (
        not isinstance(body["name"], str)
        or not 1 <= len(body["name"]) <= 120
        or not isinstance(body["schema"], dict)
    ):
        raise ValueError("workbench ontology envelope is invalid")
    return operation


MATERIAL_OPERATIONS = frozenset(row[3] for row in MATERIAL_ROUTES) | frozenset(
    operation for _, operation in CORRECTION_ACTIONS
)

# Required business fields / optional business fields. The private transport
# operation and permitted editor credentials are added separately below.
_BODY_FIELDS = {
    "generate_ontology_suggestions": ({"document_ids", "base_ontology_id", "schema"}, set()),
    "draft_ontology_suggestions": ({"operation_id", "preview_ids", "name", "schema"}, {"reviewed_preview_ids"}),
    "validate_ontology_suggestions": (set(), set()),
    "create_conversation": ({"operation_id"}, {"scenario"}),
    "start_onboarding": ({"operation_id", "expected_revision", "draft_digest"}, set()),
    "send_onboarding_turn": ({"operation_id", "expected_revision", "draft_digest"}, {"content", "question_actions"}),
    "preview_onboarding": ({"operation_id", "expected_revision", "draft_digest"}, {"name"}),
    "publish_onboarding": ({"operation_id", "preview_id", "preview_digest", "confirmed"}, set()),
    "send_conversation_message": ({"operation_id", "expected_revision", "content"}, set()),
    "create_material_intent": ({"operation_id", "expected_revision"}, {"document_id"}),
    "analyze_material": ({"operation_id", "document_version_id"}, set()),
    "prepare_material_goal": ({"operation_id", "expected_revision", "expected_conversation_revision", "goal", "confirmed"}, {"instructions"}),
    "confirm_material_extraction": ({"operation_id", "expected_revision", "expected_conversation_revision", "plan_digest", "confirmed"}, set()),
    "preview_material_review": (set(), set()),
    "merge_material_review": ({"operation_id", "expected_revision", "plan_digest", "confirmed"}, {"draft_id", "deferred_policy"}),
    "get_material_change_context": (set(), {"draft_id", "ontology_draft_id", "selected_item_ids", "proposal_offset"}),
    "generate_material_change": ({"operation_id", "context_digest", "instruction"}, {"draft_id", "ontology_draft_id", "selected_item_ids"}),
    "read_material_change": (set(), set()),
    "apply_material_change": ({"operation_id", "proposal_digest", "confirmed"}, set()),
    "correction_read": ({"path", "query"}, set()),
    "create_correction_session": ({"operation_id"}, set()),
    "open_correction_draft": ({"operation_id"}, set()),
    "open_correction_extraction_review": ({"operation_id", "review_reference"}, set()),
    "claim_correction_draft": ({"operation_id", "expected_revision"}, {"legacy_confirmed"}),
    "save_correction_draft": ({"operation_id", "expected_revision"}, {"upserts", "remove_ids", "note"}),
    "select_correction_ontology": ({"operation_id", "expected_revision", "ontology_id"}, {"note"}),
    "prepare_correction_rules": ({"operation_id", "expected_revision", "base_ontology_id", "schema"}, {"preview_ids", "reviewed_preview_ids", "note"}),
    "apply_correction_review": ({"operation_id", "expected_revision", "confirmed"}, {"note"}),
    "adopt_correction_suggestion": ({"operation_id", "expected_revision", "run_id", "candidate_id"}, {"target_item_id", "note"}),
    "adopt_correction_extraction_result": ({"operation_id", "expected_revision", "run_id", "candidate_id"}, {"target_item_id", "note"}),
    "retry_correction_publication": ({"operation_id"}, set()),
}
for _operation in ("cancel_conversation_turn", "retry_conversation_turn", "cancel_material_intent", "retry_material_extraction"):
    _BODY_FIELDS[_operation] = ({"operation_id", "expected_revision"}, set())
for _operation in ("heartbeat_correction_draft", "release_correction_draft"):
    _BODY_FIELDS[_operation] = ({"operation_id", "expected_revision"}, set())
for _operation in ("discard_correction_draft", "submit_correction_draft", "rebase_correction_draft", "reset_correction_item"):
    _BODY_FIELDS[_operation] = ({"operation_id", "expected_revision"}, {"note"})

_OPTIONAL_EDITOR = frozenset({"get_material_change_context", "generate_material_change", "read_material_change", "apply_material_change"})
_REQUIRED_EDITOR = frozenset({"preview_material_review", "merge_material_review", "correction_read", "open_correction_draft", "open_correction_extraction_review"}) | frozenset(
    operation for _, operation in CORRECTION_ACTIONS
)


def _string(value: Any, minimum: int, maximum: int) -> bool:
    return isinstance(value, str) and minimum <= len(value) <= maximum


def _integer(value: Any, minimum: int = 1) -> bool:
    return type(value) is int and minimum <= value <= SAFE_INTEGER


def _editor(value: Any) -> bool:
    return (isinstance(value, dict) and set(value) == {"session", "generation"}
        and isinstance(value["session"], str) and re.fullmatch(r"[A-Za-z0-9_-]{20,200}", value["session"]) is not None
        and isinstance(value["generation"], str) and re.fullmatch(r"[0-9]{1,12}", value["generation"]) is not None)


def _correction_target(body: dict[str, Any]) -> str:
    target, query = body.get("path"), body.get("query")
    if (not isinstance(target, str) or not target.startswith("/api/documents/")
            or not isinstance(query, dict)):
        raise ValueError("workbench correction read target is invalid")
    path = "/workbench" + target[len("/api"):]
    operation = operation_name("GET", path)
    if operation is None or operation not in MATERIAL_OPERATIONS or "correction" not in operation:
        raise ValueError("workbench correction read target is not registered")
    validate_query("GET", path, query)
    return path


def _material_body(operation: str, body: dict[str, Any] | None) -> str:
    if operation not in _BODY_FIELDS or not isinstance(body, dict) or selectable_scope(body):
        raise ValueError("workbench material body is invalid")
    required, optional = _BODY_FIELDS[operation]
    required = required | {"_native_operation_id"}
    if operation in _REQUIRED_EDITOR:
        required = required | {"_native_editor"}
    elif operation in _OPTIONAL_EDITOR:
        optional = optional | {"_native_editor"}
    if not required <= body.keys() or body.keys() - (required | optional):
        raise ValueError("workbench material fields are invalid")
    native = body["_native_operation_id"]
    if not isinstance(native, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,120}", native) is None:
        raise ValueError("workbench operation id is required")
    if "operation_id" in body and body["operation_id"] != native:
        raise ValueError("workbench business operation does not match transport")
    if "_native_editor" in body and not (
            body["_native_editor"] is None and operation in _OPTIONAL_EDITOR) and not _editor(body["_native_editor"]):
        raise ValueError("workbench editor credentials are invalid")
    if operation == "open_correction_extraction_review":
        reference = body["review_reference"]
        if (not isinstance(reference, dict) or set(reference) != {
                "document_id", "document_version_id", "run_id", "knowledge_generation", "processing_generation"}
                or any(not _string(reference[key], 1, 200) for key in ("document_id", "document_version_id", "run_id"))
                or reference["knowledge_generation"] is not None and not _string(reference["knowledge_generation"], 1, 2000)
                or reference["processing_generation"] is not None and not _integer(reference["processing_generation"], 0)):
            raise ValueError("workbench extraction review reference is invalid")
    for name in ("expected_revision", "expected_conversation_revision", "proposal_offset"):
        if name in body and not _integer(body[name], 0 if name == "proposal_offset" or operation in {"start_onboarding", "send_onboarding_turn", "preview_onboarding"} else 1):
            raise ValueError("workbench revision or offset is invalid")
    for name in ("confirmed", "legacy_confirmed"):
        if name in body and type(body[name]) is not bool:
            raise ValueError("workbench confirmation must be a boolean")
    for name in ("context_digest", "proposal_digest", "plan_digest", "draft_digest", "preview_digest"):
        if name in body and (not isinstance(body[name], str) or re.fullmatch(r"[0-9a-f]{64}", body[name]) is None):
            raise ValueError("workbench digest is invalid")
    for name, minimum, maximum in (("content", 0 if operation == "send_onboarding_turn" else 1, 8000), ("goal", 1, 8000), ("instructions", 0, 8000),
            ("instruction", 1, 4000), ("note", 0, 1500 if operation.startswith("adopt_") else 2000)):
        if name in body and not _string(body[name], minimum, maximum):
            raise ValueError("workbench text is invalid")
    for name in ("document_id", "draft_id", "ontology_draft_id", "target_item_id"):
        if name in body and body[name] is not None and not _string(body[name], 1, 200 if name == "target_item_id" else 120):
            raise ValueError("workbench resource reference is invalid")
    for name in ("document_version_id", "ontology_id", "base_ontology_id", "run_id", "candidate_id"):
        if name in body and not _string(body[name], 1, 200 if name in {"run_id", "candidate_id"} else 120):
            raise ValueError("workbench resource reference is invalid")
    if "scenario" in body and body["scenario"] not in ("material", "onboarding", "change"):
        raise ValueError("workbench conversation scenario is invalid")
    if operation == "send_onboarding_turn":
        actions = body.get("question_actions", [])
        if not isinstance(actions, list) or len(actions) > 2:
            raise ValueError("workbench question actions are invalid")
        ids, total = set(), len(body.get("content", ""))
        for action in actions:
            if (not isinstance(action, dict) or not {"question_id", "action"} <= action.keys()
                    or action.keys() - {"question_id", "action", "answer"}
                    or not _string(action["question_id"], 1, 64) or not action["question_id"].strip()
                    or action["question_id"] in ids or action["action"] not in ("answer", "skip", "uncertain")):
                raise ValueError("workbench question action is invalid")
            answer = action.get("answer", "")
            if (not _string(answer, 0, 4000) or (action["action"] == "answer" and not answer.strip())
                    or (action["action"] != "answer" and answer != "")):
                raise ValueError("workbench question answer is invalid")
            ids.add(action["question_id"])
            total += len(answer)
        if total > 8000 or (not ids and not body.get("content", "").strip()):
            raise ValueError("workbench onboarding turn is empty or too long")
    if operation == "preview_onboarding" and (not _string(body.get("name", "建仓对话本体"), 1, 120)
            or not body.get("name", "建仓对话本体").strip()):
        raise ValueError("workbench onboarding name is invalid")
    if operation == "publish_onboarding" and (not _string(body["preview_id"], 1, 120) or body["confirmed"] is not True):
        raise ValueError("workbench onboarding publication requires a confirmed preview")
    if "deferred_policy" in body and body["deferred_policy"] not in (None, "keep_existing"):
        raise ValueError("workbench deferred policy is invalid")
    if "schema" in body and not isinstance(body["schema"], dict):
        raise ValueError("workbench ontology schema is invalid")
    if operation == "generate_ontology_suggestions":
        identifiers = body["document_ids"]
        if (not isinstance(identifiers, list) or not 1 <= len(identifiers) <= 5
                or any(not _string(value, 1, 120) for value in identifiers)):
            raise ValueError("workbench ontology sources are invalid")
    if operation == "draft_ontology_suggestions" and (
        not _string(body["name"], 1, 120) or not body["name"].strip() or not body["preview_ids"]
    ):
        raise ValueError("workbench ontology draft is invalid")
    for name, maximum in (("selected_item_ids", 20), ("preview_ids", 8), ("reviewed_preview_ids", 8), ("remove_ids", 100)):
        if name in body and (not isinstance(body[name], list) or len(body[name]) > maximum
                or any(not _string(value, 1, 200) for value in body[name])):
            raise ValueError("workbench selection is invalid")
    if "upserts" in body:
        upserts = body["upserts"]
        if (not isinstance(upserts, list) or len(upserts) + len(body.get("remove_ids", [])) > 100
                or any(not isinstance(item, dict) or not {"id", "kind", "payload", "evidence"} <= item.keys()
                    or item.keys() - {"id", "kind", "payload", "evidence", "review_note", "review_basis"}
                    or not _string(item["id"], 1, 200) or not isinstance(item["kind"], str) or item["kind"] not in {"entity", "relation"}
                    or not isinstance(item["payload"], dict) or not isinstance(item["evidence"], list)
                    or not _string(item.get("review_note", ""), 0, 2000)
                    or not _string(item.get("review_basis", ""), 0, 64) for item in upserts)):
            raise ValueError("workbench correction items are invalid")
    if operation == "correction_read":
        _correction_target(body)
    return native


def resource_ids(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, str]:
    """Return finite resource references for downstream warehouse/parent checks.

    This function never resolves authority or proves ownership. In particular,
    body IDs and a correction read's inner target still require domain checks.
    """
    validate_body(method, path, body)
    if operation_name(method, path) == "correction_read":
        return resource_ids("GET", _correction_target(body))
    for allowed_method, pattern, _, _ in ROUTES:
        if method == allowed_method and (match := re.fullmatch(pattern, path)) is not None:
            result = {key: value for key, value in match.groupdict().items() if value is not None}
            for key in ("document_id", "document_version_id", "draft_id", "ontology_draft_id", "ontology_id", "base_ontology_id", "run_id", "candidate_id", "target_item_id"):
                if body and isinstance(body.get(key), str):
                    if key in result and result[key] != body[key]:
                        raise ValueError("workbench resource reference conflicts with path")
                    result[key] = body[key]
            return result
    raise ValueError("workbench resource route is not registered")
