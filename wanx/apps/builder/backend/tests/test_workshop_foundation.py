from types import SimpleNamespace

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.foundation_runtime import native_operation


def test_native_foundation_fixed_contract_and_scope(tmp_path):
    session = {
        "manifest": {"capabilities": ["foundation"]},
        "app": "ai.wanx.selfmade." + "a" * 32,
        "environment": "preview",
    }
    service = SimpleNamespace(
        store=SimpleNamespace(root=tmp_path), runtime=lambda owner, token: session
    )

    def invoke(owner, params):
        return native_operation(service, owner, "opaque", params)

    value = {"operation": "status", "input": {}}
    first = invoke("alice", value)["nativeFoundation"]
    assert set(first) == {"appId", "environment", "scopeId", "operation", "input"}
    assert first["scopeId"] != invoke("bob", value)["nativeFoundation"]["scopeId"]
    session["environment"] = "production"
    assert first["scopeId"] != invoke("alice", value)["nativeFoundation"]["scopeId"]
    for params in [
        {"operation": "http.request", "input": {}},
        {"operation": [], "input": {}},
        {**value, "account": "bob"},
        {"operation": "status", "input": {"text": "x" * 90001}},
    ]:
        with pytest.raises(StudioError):
            invoke("alice", params)
    session["manifest"]["capabilities"] = []
    with pytest.raises(StudioError, match="CAPABILITY_DENIED"):
        invoke("alice", value)
