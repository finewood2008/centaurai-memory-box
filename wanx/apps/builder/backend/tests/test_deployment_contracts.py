"""Offline parity with the exported JS validators at App Dev Kit 5022e6a.

Golden outputs were produced by that implementation, not by the Python port.
No sibling checkout, Node runtime, adapter or network is required by this suite.
"""

import copy
import json
from pathlib import Path

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.deployment.contracts import (
    MAX_SAFE_INTEGER,
    bundle_digest,
    canonicalize_json,
    request_digest,
    validate_bundle,
    validate_components,
    validate_linked,
    validate_receipt,
    validate_reference,
    validate_request,
)

FIXTURES = Path(__file__).parent / "fixtures" / "deployment"


def sample(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


CASES = sample("cases.json")
GOLDEN = sample("js-golden.json")
INVALIDS = sample("js-invalid-golden.json")["cases"]
VALIDATORS = {"bundle": validate_bundle, "request": validate_request, "receipt": validate_receipt}


def linked():
    return {kind: sample(name) for kind, name in CASES["linked"][0].items()}


def check_linked(value):
    return validate_linked(value["bundle"], value["request"], value["receipt"], value["context"]["requiredChannelIds"])


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Contract validation must not use the network")
    monkeypatch.setattr("socket.socket.connect", blocked)
    monkeypatch.setattr("socket.create_connection", blocked)


@pytest.mark.parametrize("kind,name", [(kind, name) for kind in VALIDATORS for name in CASES[kind]])
def test_all_upstream_samples_are_valid_independent_copies(kind, name):
    value = sample(name)
    result = VALIDATORS[kind](value)
    assert result == value
    assert result is not value
    result["schemaVersion"] = 99
    assert value["schemaVersion"] == 1
    if "target" in result:
        result["target"]["boxId"] = "different"
        assert value["target"]["boxId"] != "different"


@pytest.mark.parametrize("case", GOLDEN["linked"], ids=lambda case: case["files"]["request"])
def test_linked_samples_match_js(case):
    value = {kind: sample(name) for kind, name in case["files"].items()}
    assert case["result"] == {"valid": True, "errors": []}
    assert check_linked(value) == value


@pytest.mark.parametrize("name,digest", GOLDEN["bundleDigests"].items())
def test_bundle_hash_matches_js(name, digest):
    bundle = sample(name)
    assert bundle_digest(bundle) == digest == bundle["bundleDigest"]
    assert bundle_digest(dict(reversed(list(bundle.items())))) == digest
    bundle["provenanceRef"] = {"id": "different", "revision": 999}
    bundle["bundleDigest"] = "excluded"
    assert bundle_digest(bundle) == digest
    bundle["releaseId"] = "different"
    assert bundle_digest(bundle) != digest


@pytest.mark.parametrize("name,digest", GOLDEN["requestDigests"].items())
def test_request_hash_matches_js(name, digest):
    request = sample(name)
    assert request_digest(request) == digest
    assert request_digest(dict(reversed(list(request.items())))) == digest
    request["target"]["boxId"] = "different"
    assert request_digest(request) != digest


@pytest.mark.parametrize("case", GOLDEN["canonical"])
def test_utf16_order_escaping_and_safe_integer_profile_match_js(case):
    assert canonicalize_json(case["value"]) == case["encoded"]
    assert request_digest(case["value"]) == case["digest"]


@pytest.mark.parametrize("case", INVALIDS, ids=lambda case: case["name"])
def test_invalid_inputs_match_upstream_diagnostics(case):
    value = linked() if case["kind"] == "linked" else sample(case["base"] + ".json")
    for edit in case["edits"]:
        target = value
        for key in edit["path"][:-1]:
            target = target[key]
        if edit.get("remove"):
            del target[edit["path"][-1]]
        else:
            target[edit["path"][-1]] = copy.deepcopy(edit["value"])
    if case["redigest"]:
        value["bundleDigest"] = bundle_digest(value)
    validator = check_linked if case["kind"] == "linked" else VALIDATORS[case["kind"]]
    with pytest.raises(StudioError) as raised:
        validator(value)
    assert raised.value.status == 422
    assert raised.value.code in case["errors"]
    assert str(raised.value) == raised.value.code
    assert "SECRET_TOKEN" not in str(raised.value)


@pytest.mark.parametrize("value", [
    1.0, 1.5, -0.0, float("nan"), float("inf"), MAX_SAFE_INTEGER + 1,
    -MAX_SAFE_INTEGER - 1, "\ud800", "\udfff", {"\ud800": 1},
    {1: "not a string key"}, (1, 2), {1, 2}, b"bytes", object(),
])
def test_canonical_rejects_ambiguous_non_json_values(value):
    with pytest.raises(StudioError) as raised:
        canonicalize_json(value)
    assert raised.value.code == "CANONICAL_JSON_INVALID"
    assert raised.value.status == 422


def test_canonical_limits_cycles_and_shared_values():
    cycle = []
    cycle.append(cycle)
    deep = None
    for _ in range(65):
        deep = [deep]
    for value in (cycle, deep, [0] * 100000, "x" * 1048577, "😀" * 524289):
        with pytest.raises(StudioError, match="^CANONICAL_JSON_INVALID$"):
            canonicalize_json(value)
    shared = {"a": 1}
    assert canonicalize_json([shared, shared]) == '[{"a":1},{"a":1}]'
    assert canonicalize_json([0] * 99999).startswith("[0,0,")
    assert canonicalize_json("é") != canonicalize_json("e\u0301")


@pytest.mark.parametrize("validator", VALIDATORS.values())
@pytest.mark.parametrize("value", [None, [], "SECRET_TOKEN", {"SECRET_TOKEN": "SECRET_TOKEN"}])
def test_malformed_contracts_raise_fixed_safe_codes(validator, value):
    with pytest.raises(StudioError) as raised:
        validator(value)
    assert raised.value.status == 422
    assert "SECRET_TOKEN" not in str(raised.value)
    assert raised.value.code.endswith("_SCHEMA_INVALID")


def test_reference_and_component_adapter_boundaries():
    reference = {"id": "ref", "revision": 1}
    assert validate_reference(reference) == reference
    assert validate_reference(reference) is not reference
    components = sample("success.receipt.json")["componentResults"]
    result = validate_components(components)
    assert result == components
    result[0]["actualReleaseRef"]["releaseId"] = "other"
    assert components[0]["actualReleaseRef"]["releaseId"] != "other"
    for invalid in ({"id": "unversioned"}, {**reference, "password": "SECRET"}, {"id": "ref", "revision": True}):
        with pytest.raises(StudioError, match="^REFERENCE_SCHEMA_INVALID$"):
            validate_reference(invalid)
    for invalid in (None, {}, components * 43, [{**components[0], "password": "SECRET"}]):
        with pytest.raises(StudioError, match="^COMPONENTS_SCHEMA_INVALID$"):
            validate_components(invalid)


@pytest.mark.parametrize("value", [True, 1.0, -0.0, MAX_SAFE_INTEGER + 1])
def test_request_generation_is_strict_integer(value):
    request = sample("dev.request.json")
    request["expectedGeneration"] = value
    with pytest.raises(StudioError):
        validate_request(request)


def test_timestamp_edges_use_js_calendar_including_iso_year_zero():
    receipt = sample("success.receipt.json")
    for value in ("0000-02-29T00:00:00.000Z", "2000-02-29T23:59:59.999Z"):
        receipt["observedAt"] = value
        assert validate_receipt(receipt)["observedAt"] == value
    for value in ("1900-02-29T00:00:00.000Z", "2026-11-13T24:00:00.000Z", "2026-11-13T00:00:60.000Z", "2026-13-13T00:00:00.000Z"):
        receipt["observedAt"] = value
        with pytest.raises(StudioError, match="^OBSERVED_AT_INVALID$"):
            validate_receipt(receipt)


def test_committed_degraded_outcome_still_binds_generation_and_roles():
    value = linked()
    value["receipt"] = sample("failed-degraded.receipt.json")
    value["receipt"]["previousGeneration"] += 10
    value["receipt"]["committedGeneration"] += 10
    with pytest.raises(StudioError, match="^EXPECTED_GENERATION_MISMATCH$"):
        check_linked(value)


def test_rejected_generation_conflict_may_report_actual_generation():
    value = linked()
    value["receipt"] = sample("rejected.receipt.json")
    value["receipt"]["previousGeneration"] = 10
    assert check_linked(value)["receipt"]["previousGeneration"] == 10


def test_linked_context_rejects_non_strings_before_hashing():
    value = linked()
    for context in ([{}], [1], [True], ["x"] * 129, ["😀"]):
        value["context"]["requiredChannelIds"] = context
        with pytest.raises(StudioError, match="^RESOLVED_CHANNEL_CONTEXT_REQUIRED$"):
            check_linked(value)


def test_profile_errors_are_fixed_at_each_boundary():
    for validator in (validate_bundle, validate_request, validate_receipt, validate_components, validate_reference):
        with pytest.raises(StudioError, match="^JSON_PROFILE_INVALID$"):
            validator(float("nan"))
    with pytest.raises(StudioError, match="^DEPLOYMENT_SET_INVALID$"):
        validate_linked(float("nan"), {}, {}, [])
    with pytest.raises(StudioError, match="^BUNDLE_OBJECT_REQUIRED$"):
        bundle_digest([])
