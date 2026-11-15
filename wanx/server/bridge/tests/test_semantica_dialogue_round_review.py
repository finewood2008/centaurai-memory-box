"""Upload binding conflicts retain safe, actionable round error codes."""
# ruff: noqa: F811
import json

import httpx
import pytest
from test_semantica_desktop_contract import AUTH, BASE, W, desktop  # noqa: F401

from wanx_bridge.semantica.client import SemanticaClient, SemanticaError
from wanx_bridge.semantica.desktop import DesktopError, decode


@pytest.mark.parametrize("code", ["MODELING_ROUND_ATOMIC_REQUIRED", "MODELING_ROUND_SINGLE_MATERIAL"])
async def test_upload_commit_round_conflict(desktop, code):
    client, _, _, seen, reply, _ = desktop
    reply.update(status=409, value={"detail": {"code": code, "message": "PRIVATE source"}})
    result = await client.post(BASE + W + "/imports/upload-a/commit", headers=AUTH, json={"operation_id": "upload-commit"})
    assert seen
    assert result.status_code == 409
    assert result.json()["code"] == code
    assert "PRIVATE" not in result.text
    with pytest.raises(SemanticaError) as error:
        SemanticaClient.decode(httpx.Response(409, json=reply["value"]))
    assert error.value.code == code
    assert "PRIVATE" not in str(error.value)


@pytest.mark.parametrize("code", ["MODELING_ROUND_UNKNOWN", {"invalid": True}])
def test_unknown_or_malformed_error_stays_generic(code):
    value = {"code": code, "message": "PRIVATE source"}
    with pytest.raises(DesktopError) as error:
        decode(409, json.dumps(value).encode())
    assert error.value.code == "SEMANTICA_VERSION_CONFLICT"
    with pytest.raises(SemanticaError) as error:
        SemanticaClient.decode(httpx.Response(409, json=value))
    assert error.value.code == "SEMANTICA_VERSION_CONFLICT"


def test_public_decoder_does_not_expose_round_binding_errors():
    with pytest.raises(DesktopError) as error:
        decode(409, b'{"code":"MODELING_ROUND_ATOMIC_REQUIRED"}', public=True)
    assert error.value.code == "SEMANTICA_VERSION_CONFLICT"
