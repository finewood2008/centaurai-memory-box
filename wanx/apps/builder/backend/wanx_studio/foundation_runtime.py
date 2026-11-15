"""Authorize a fixed native runtime operation; no credentials or arbitrary route."""

from __future__ import annotations

import json
from pathlib import Path

from .contracts import StudioError, digest

OPERATIONS = frozenset(
    json.loads(Path(__file__).with_name("foundation-contract.json").read_text())[
        "operations"
    ]
)


def native_operation(service, owner, token, params):
    session = service.runtime(owner, token)
    if "foundation" not in session["manifest"]["capabilities"]:
        raise StudioError("CAPABILITY_DENIED", 403)
    if not isinstance(params, dict) or set(params) != {"operation", "input"}:
        raise StudioError("FOUNDATION_INPUT_INVALID", 422)
    if (
        not isinstance(params["operation"], str)
        or params["operation"] not in OPERATIONS
        or not isinstance(params["input"], dict)
        or len(json.dumps(params["input"]).encode()) > 90000
    ):
        raise StudioError("FOUNDATION_OPERATION_DENIED", 403)
    if session["environment"] not in {"preview", "production"}:
        raise StudioError("ENVIRONMENT_DENIED", 403)
    return {
        "nativeFoundation": {
            "appId": session["app"],
            "environment": session["environment"],
            "scopeId": digest(
                [
                    str(service.store.root.resolve()),
                    owner,
                    session["app"],
                    session["environment"],
                ]
            ),
            **params,
        }
    }
