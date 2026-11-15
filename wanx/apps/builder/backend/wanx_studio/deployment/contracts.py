"""Offline v1 deployment contracts, matching App Dev Kit commit 5022e6a.

The wire profile deliberately accepts only safe integers (not RFC 8785). Schema
resources are vendored locally; validation never resolves network references.
Validation errors expose fixed codes, never untrusted paths or input values.
"""

from __future__ import annotations

import calendar
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator
from referencing import Registry, Resource

from ..contracts import StudioError

MAX_SAFE_INTEGER = 2**53 - 1
_DEPLOYMENT_KINDS = {"deploy", "promote", "rollback"}
_SUCCESS_STATUS = {
    "deploy": "ready", "promote": "ready", "rollback": "ready",
    "restart": "ready", "recover": "ready", "stop": "stopped",
    "uninstall": "uninstalled", "purge": "purged",
}


def _reject(code: str) -> None:
    raise StudioError(code, 422)


def canonicalize_json(value: Any) -> str:
    """Encode the bounded JSON profile, sorting object keys by UTF-16 units."""
    count = 0
    seen: set[int] = set()

    def string(item: str, *, bounded: bool = True) -> str:
        # UTF-16 encoding both checks Unicode scalar validity and measures the
        # same string length as JavaScript. Object keys have no profile limit.
        encoded = item.encode("utf-16-be")
        if bounded and len(encoded) > 2 * 1048576:
            raise ValueError
        return json.dumps(item, ensure_ascii=False, separators=(",", ":"))

    def encode(item: Any, depth: int) -> str:
        nonlocal count
        count += 1
        if count > 100000 or depth > 64:
            raise ValueError
        if item is None:
            return "null"
        if type(item) is bool:
            return "true" if item else "false"
        if type(item) is int:
            if abs(item) > MAX_SAFE_INTEGER:
                raise ValueError
            return str(item)
        if type(item) is str:
            return string(item)
        if type(item) not in (list, dict) or id(item) in seen:
            raise ValueError
        seen.add(id(item))
        if type(item) is list:
            if len(item) > 100000:
                raise ValueError
            output = "[" + ",".join(encode(part, depth + 1) for part in item) + "]"
        else:
            if any(type(key) is not str for key in item):
                raise ValueError
            keys = sorted(item, key=lambda key: key.encode("utf-16-be"))
            output = "{" + ",".join(
                string(key, bounded=False) + ":" + encode(item[key], depth + 1)
                for key in keys
            ) + "}"
        seen.remove(id(item))
        return output

    try:
        return encode(value, 0)
    except (ValueError, TypeError, RecursionError):
        raise StudioError("CANONICAL_JSON_INVALID", 422) from None


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonicalize_json(value).encode("utf-8")).hexdigest()


def bundle_digest(bundle: Any) -> str:
    """Hash content, excluding its own digest and external provenance ref."""
    value = json.loads(canonicalize_json(bundle))
    if type(value) is not dict:
        _reject("BUNDLE_OBJECT_REQUIRED")
    value.pop("bundleDigest", None)
    value.pop("provenanceRef", None)
    return _digest(value)


def request_digest(request: Any) -> str:
    """Hash all wire fields; trusted caller scope is supplied separately."""
    return _digest(request)


def _validators() -> dict[str, Draft7Validator]:
    schemas = {
        name: json.loads((Path(__file__).parent / "schemas" / f"{name}.schema.json").read_text())
        for name in ("common", "bundle", "request", "receipt")
    }
    # Registry's default retrieval rejects missing resources, never fetches them.
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()
    )
    validators = {
        name: Draft7Validator(schema, registry=registry)
        for name, schema in schemas.items() if name != "common"
    }
    common = schemas["common"]["$id"] + "#/definitions/"
    validators["reference"] = Draft7Validator({"$ref": common + "reference"}, registry=registry)
    validators["components"] = Draft7Validator({
        "type": "array", "maxItems": 128, "items": {"$ref": common + "componentResult"},
    }, registry=registry)
    return validators


_VALIDATORS = _validators()


def _structural(name: str, value: Any) -> Any:
    try:
        result = json.loads(canonicalize_json(value))
    except StudioError:
        raise StudioError("JSON_PROFILE_INVALID", 422) from None
    if not _VALIDATORS[name].is_valid(result):
        _reject(f"{name.upper()}_SCHEMA_INVALID")
    return result


def validate_bundle(value: Any) -> dict:
    bundle = _structural("bundle", value)
    if bundle_digest(bundle) != bundle["bundleDigest"]:
        _reject("BUNDLE_DIGEST_MISMATCH")
    descriptors = bundle["artifactDescriptors"]
    artifacts = {artifact["artifactId"]: artifact for artifact in descriptors}
    if len(artifacts) != len(descriptors):
        _reject("DUPLICATE_ARTIFACT_ID")
    if any(artifact["sourceRef"].get("digest", artifact["digest"]) != artifact["digest"] for artifact in descriptors):
        _reject("ARTIFACT_SOURCE_DIGEST_MISMATCH")
    client = bundle["clientDelivery"]
    if client["mode"] == "install" and artifacts.get(client["artifactId"], {}).get("role") != "client":
        _reject("CLIENT_ARTIFACT_REQUIRED")
    if client["mode"] == "load" and any(
        artifacts.get(artifact_id, {}).get("role") not in {"client", "assets"}
        for artifact_id in client["resourceArtifactIds"]
    ):
        _reject("CLIENT_RESOURCE_ARTIFACT_INVALID")
    if bundle["payloadKind"] == "managed-spec" and bundle["specRef"].get("digest", bundle["specDigest"]) != bundle["specDigest"]:
        _reject("SPEC_DIGEST_MISMATCH")
    return bundle


def validate_request(value: Any) -> dict:
    return _structural("request", value)


def validate_reference(value: Any) -> dict:
    return _structural("reference", value)


def validate_components(value: Any) -> list[dict]:
    return _structural("components", value)


def _valid_timestamp(value: str) -> bool:
    match = re.fullmatch(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z", value)
    if match is None:
        return False
    year, month, day, hour, minute, second, _ = map(int, match.groups())
    # The JS source accepts ISO year 0000; calendar supports that proleptic year.
    return (
        1 <= month <= 12 and 1 <= day <= calendar.monthrange(year, month)[1]
        and hour < 24 and minute < 60 and second < 60
    )


def _required_roles(required: list[dict]) -> None:
    for role in ("backend", "client"):
        if sum(component["role"] == role for component in required) != 1:
            _reject("REQUIRED_ROLE_MISSING_OR_DUPLICATE")


def validate_receipt(value: Any) -> dict:
    receipt = _structural("receipt", value)
    if not _valid_timestamp(receipt["observedAt"]):
        _reject("OBSERVED_AT_INVALID")
    components = receipt["componentResults"]
    if len({component["componentId"] for component in components}) != len(components):
        _reject("DUPLICATE_COMPONENT_ID")
    required = [component for component in components if component["required"]]
    committed = receipt["commitStatus"] == "committed"
    generation, previous = receipt["committedGeneration"], receipt["previousGeneration"]
    if not committed and generation is not None:
        _reject("UNCONFIRMED_GENERATION")
    if committed and (generation is None or generation < previous):
        _reject("COMMITTED_GENERATION_INVALID")
    if receipt["kind"] in _DEPLOYMENT_KINDS and receipt["requestedReleaseRef"] is None:
        _reject("REQUESTED_RELEASE_REQUIRED")
    if receipt["outcome"] in {"rejected", "failed_recovered"} and receipt["commitStatus"] != "not_committed":
        _reject("PRECOMMIT_OUTCOME_INVALID")
    if receipt["outcome"] == "failed_degraded" and not committed:
        _reject("DEGRADED_COMMIT_REQUIRED")
    if receipt["commitStatus"] == "unknown" and receipt["outcome"] != "recovery_required":
        _reject("UNKNOWN_REQUIRES_RECOVERY")
    if receipt["kind"] in _DEPLOYMENT_KINDS and committed and (
        previous == MAX_SAFE_INTEGER or generation != previous + 1
    ):
        _reject("ACTIVATION_GENERATION_INVALID")
    if receipt["kind"] == "recover" and receipt["recoveryOf"] == receipt["operationId"]:
        _reject("RECOVERY_SELF_REFERENCE")
    if committed:
        if receipt["environmentRevision"] < 1:
            _reject("COMMITTED_ENVIRONMENT_REVISION_INVALID")
        _required_roles(required)
        if receipt["kind"] in {"restart", "stop", "uninstall", "purge"} and generation != previous:
            _reject("MANAGEMENT_GENERATION_CHANGED")
    if receipt["outcome"] == "succeeded":
        if not committed or receipt["environmentRevision"] < 1:
            _reject("SUCCESS_COMMIT_REQUIRED")
        expected_status = _SUCCESS_STATUS[receipt["kind"]]
        if not required or any(component["status"] != expected_status for component in required):
            _reject("REQUIRED_COMPONENT_NOT_SUCCESSFUL")
        for component in required:
            if "error" in component:
                _reject("SUCCESS_COMPONENT_HAS_ERROR")
            if expected_status == "ready" and (
                not component["actualReleaseRef"] or not component["actualVersion"]
                or not receipt["requestedReleaseRef"]
                or component["actualReleaseRef"] != receipt["requestedReleaseRef"]
            ):
                _reject("COMPONENT_RELEASE_MISMATCH")
    return receipt


def validate_linked(bundle: Any, request: Any, receipt: Any, required_channel_ids: Any) -> dict:
    """Validate offline consistency against channels resolved by a trusted adapter.

    Returns an independent {bundle, request, receipt, context} object. This does
    not establish authorization, provenance or runtime readiness by itself.
    """
    try:
        canonicalize_json({"bundle": bundle, "request": request, "receipt": receipt,
                           "context": {"requiredChannelIds": required_channel_ids}})
    except StudioError:
        raise StudioError("DEPLOYMENT_SET_INVALID", 422) from None
    bundle, request, receipt = validate_bundle(bundle), validate_request(request), validate_receipt(receipt)
    if type(required_channel_ids) is not list or len(required_channel_ids) > 128 or any(
        type(channel_id) is not str or len(channel_id) > 128
        or not re.search(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", channel_id)
        for channel_id in required_channel_ids
    ) or len(set(required_channel_ids)) != len(required_channel_ids):
        _reject("RESOLVED_CHANNEL_CONTEXT_REQUIRED")
    expected_release = {"releaseId": bundle["releaseId"], "bundleDigest": bundle["bundleDigest"]}
    if request["target"]["applicationId"] != bundle["applicationId"]:
        _reject("APPLICATION_MISMATCH")
    if request.get("releaseRef") and request["releaseRef"] != expected_release:
        _reject("REQUEST_RELEASE_MISMATCH")
    if receipt["requestedReleaseRef"] and receipt["requestedReleaseRef"] != expected_release:
        _reject("RECEIPT_RELEASE_MISMATCH")
    if request["target"] != receipt["target"]:
        _reject("TARGET_MISMATCH")
    if request["kind"] != receipt["kind"]:
        _reject("KIND_MISMATCH")
    if receipt["commitStatus"] == "committed" and request["expectedGeneration"] != receipt["previousGeneration"]:
        _reject("EXPECTED_GENERATION_MISMATCH")
    if receipt["outcome"] == "succeeded":
        required = [component for component in receipt["componentResults"] if component["required"]]
        _required_roles(required)
        channels = {component["componentId"] for component in required if component["role"] == "channel"}
        if any(channel_id not in channels for channel_id in required_channel_ids):
            _reject("REQUIRED_CHANNEL_MISSING")
        if any(channel_id not in required_channel_ids for channel_id in channels):
            _reject("CHANNEL_CONTEXT_MISMATCH")
        if _SUCCESS_STATUS[request["kind"]] == "ready" and receipt["requestedReleaseRef"] != expected_release:
            _reject("RECEIPT_RELEASE_MISMATCH")
    return {"bundle": bundle, "request": request, "receipt": receipt,
            "context": {"requiredChannelIds": list(required_channel_ids)}}
