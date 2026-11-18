"""Native callback diagnostics, using synthetic model replies only."""

import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from wanx_bridge.semantica import host_routes, models
from wanx_bridge.semantica.client import SemanticaError
from wanx_bridge.semantica.output_diagnostics import safe_output_metadata

SCHEMA = {
    "type": "object", "required": ["entities"], "additionalProperties": False,
    "properties": {"entities": {"type": "array", "items": {
        "type": "object", "required": ["confidence"],
        "properties": {"confidence": {"type": "number", "maximum": 1}},
    }}},
}


@pytest.fixture
def model(monkeypatch):
    reply = SimpleNamespace(content='{"entities": []}', response_metadata={},
                            usage_metadata={"output_tokens": 10}, tool_calls=[])
    mock = SimpleNamespace(ainvoke=AsyncMock(return_value=reply))
    monkeypatch.setattr(models, "build_probe_chat_model", lambda *a, **kw: mock)
    monkeypatch.setattr(models, "llm_text_content", lambda answer: answer.content)
    close = AsyncMock()
    monkeypatch.setattr(models, "aclose_session_http_clients", close)
    return SimpleNamespace(reply=reply, mock=mock, close=close)


async def generate():
    return await models._generate(
        SimpleNamespace(base_url="https://synthetic.invalid", kind="openai"),
        {"model": "synthetic", "max_output_tokens": 2048},
        "PRIVATE_SOURCE", SCHEMA, AsyncMock(), max_output_tokens=3072,
    )


@pytest.mark.parametrize("content,metadata,tools,kind,validator,path", [
    ('{"entities":[{"confidence":"PRIVATE"}]}', {}, [], "schema_validation", "type", "/entities/0/confidence"),
    ('{"entities":[{}]}', {}, [], "schema_validation", "required", "/entities/0/confidence"),
    ('{"entities":[{"confidence":2}]}', {}, [], "schema_validation", "maximum", "/entities/0/confidence"),
    ('{"PRIVATE_KEY":"PRIVATE"}', {}, [], "schema_validation", "required", "/entities"),
    ('{"entities":[],"PRIVATE_KEY":"PRIVATE"}', {}, [], "schema_validation", "additionalProperties", ""),
    ('[]', {}, [], "schema_validation", "type", ""),
    ('{PRIVATE', {}, [], "invalid_json", None, ""),
    ('```', {}, [], "invalid_json", None, ""),
    ('PRIVATE', {"finish_reason": "length"}, [], "truncated", None, ""),
    ('PRIVATE', {"done": False}, [], "truncated", None, ""),
    ('PRIVATE', {}, ["PRIVATE"], "invalid_response", None, ""),
    ('P' * (512 * 1024 + 1), {}, [], "response_too_large", None, ""),
], ids=["field-type", "missing-field", "range", "missing-root", "unknown-field",
        "non-object", "invalid-json", "incomplete-fence", "length", "unfinished",
        "tool-call", "oversized"])
async def test_native_output_failure(model, caplog, content, metadata, tools, kind, validator, path):
    model.reply.content, model.reply.response_metadata, model.reply.tool_calls = content, metadata, tools
    with pytest.raises(SemanticaError) as caught:
        await generate()
    error = caught.value
    assert error.code == "MODEL_INVALID_OUTPUT" and error.status == 502
    detail = error.output_diagnostic
    assert (detail["kind"], detail.get("validator"), detail["field_path"]) == (kind, validator, path)
    with caplog.at_level(logging.WARNING, logger=models.__name__):
        models._log_model_failure(error, "synthetic-job", "synthetic-nonce")
    event = json.loads(caplog.records[-1].getMessage())
    assert event["outputDiagnostic"] == detail
    assert event["outputMetadata"]["max_output_tokens"] == 2048
    assert event["outputMetadata"]["requested_output_tokens"] == 3072
    if metadata.get("finish_reason"):
        assert event["outputMetadata"]["finish_reason"] == "length"
    if kind == "invalid_json":
        assert type(event["outputMetadata"]["json_error_position"]) is int
    assert "PRIVATE" not in caplog.text and "synthetic-job" not in caplog.text
    model.close.assert_awaited_once()


async def test_success_keeps_usage_budget_and_cleanup(model):
    result = await generate()
    assert json.loads(result["text"]) == {"entities": []}
    assert result["max_output_tokens"] == 2048
    assert result["usage"] == {"output_tokens": 10}
    assert model.mock.ainvoke.call_args.kwargs["max_tokens"] == 2048
    model.close.assert_awaited_once()


async def test_upstream_failure_is_not_relabelled(model):
    model.mock.ainvoke.side_effect = httpx.ReadTimeout("PRIVATE")
    with pytest.raises(httpx.ReadTimeout):
        await generate()
    model.close.assert_awaited_once()


async def test_native_billing_failure_keeps_safe_status_without_provider_body(model, caplog):
    request = httpx.Request("POST", "https://synthetic.invalid")
    response = httpx.Response(402, request=request, text="PRIVATE_PROVIDER_BODY")
    model.mock.ainvoke.side_effect = httpx.HTTPStatusError("PRIVATE_PROVIDER_BODY", request=request, response=response)
    with pytest.raises(SemanticaError) as caught:
        await generate()
    error = caught.value
    assert (error.status, error.code) == (402, "MODEL_BILLING_REQUIRED")
    assert error.message is None
    models._log_model_failure(error, "synthetic-job", "synthetic-nonce")
    event = json.loads(caplog.records[-1].getMessage())
    assert (event["upstreamStatus"], event["publicCode"]) == (402, "MODEL_BILLING_REQUIRED")
    assert "PRIVATE_PROVIDER_BODY" not in caplog.text
    model.close.assert_awaited_once()


@pytest.mark.parametrize("status,code,include", [(502, "MODEL_INVALID_OUTPUT", True),
                                               (402, "MODEL_BILLING_REQUIRED", False),
                                               (403, "MODEL_AUTH_REQUIRED", False)])
async def test_native_http_returns_sanitized_diagnostic(monkeypatch, status, code, include):
    error = SemanticaError(code, status)
    error.output_diagnostic = {"version": 1, "source": "bridge", "kind": "schema_validation",
                               "validator": "type", "field_path": "/entities/0/PRIVATE",
                               "message": "PRIVATE", "instance": "PRIVATE"}
    monkeypatch.setattr(models, "internal", AsyncMock(side_effect=error))
    monkeypatch.setattr(models, "configure_host", lambda bindings: None)
    _, router = host_routes.create_host_routers(
        current_user=lambda: None, get_server=lambda: SimpleNamespace(services=None),
        require_permission=lambda name: lambda: None, application_id=lambda user: "wanx",
        model_host=SimpleNamespace(),
    )
    app = FastAPI()
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/internal/starklink/models", json={})
    assert response.status_code == status
    assert ("output_diagnostic" in response.json()) is include
    if include:
        assert response.json()["output_diagnostic"]["field_path"] == "/entities/0/*"
    assert "PRIVATE" not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_metadata_drops_unbounded_and_private_values():
    assert safe_output_metadata({"finish_reason": "PRIVATE", "message": "PRIVATE",
                                 "response_bytes": True, "max_output_tokens": -1,
                                 "json_error_position": 10**20, "done": False,
                                 "requested_output_tokens": 2048}) == {
                                     "done": False, "requested_output_tokens": 2048}


@pytest.mark.parametrize("content", [
    '{"entities":[{"confidence":NaN}]}',
    '{"entities":[{"confidence":-Infinity}]}',
    '{"entities":[{"confidence":-1e999}]}',
    '[' * 20000 + '0' + ']' * 20000,
], ids=["nan", "infinity", "overflow", "deep-json"])
async def test_invalid_json_never_succeeds_or_loses_diagnostic(model, content):
    model.reply.content = content
    with pytest.raises(SemanticaError) as caught:
        await generate()
    assert caught.value.code == "MODEL_INVALID_OUTPUT"
    assert caught.value.output_diagnostic["kind"] == "invalid_json"
    model.close.assert_awaited_once()


@pytest.mark.parametrize("metadata", ["PRIVATE", ["PRIVATE"], 42, [], "", False])
async def test_malformed_sdk_metadata_is_controlled(model, metadata):
    model.reply.response_metadata = metadata
    with pytest.raises(SemanticaError) as caught:
        await generate()
    assert caught.value.output_diagnostic["kind"] == "invalid_response"
    assert caught.value.output_metadata == {"max_output_tokens": 2048, "requested_output_tokens": 3072}


async def test_upstream_cannot_invent_measured_log_counters(model):
    model.reply.response_metadata = {"finish_reason": "length", "response_bytes": 987,
                                     "json_error_position": 654, "max_output_tokens": 1}
    with pytest.raises(SemanticaError) as caught:
        await generate()
    metadata = caught.value.output_metadata
    assert metadata["max_output_tokens"] == 2048
    assert metadata["finish_reason"] == "length"
    assert "response_bytes" not in metadata
    assert "json_error_position" not in metadata


@pytest.mark.parametrize("cap", [True, False, "2048", 0, -1, 3.5, {}, []])
async def test_native_invalid_provider_cap_never_calls_model(model, cap):
    with pytest.raises(SemanticaError) as caught:
        await models._generate(SimpleNamespace(base_url="https://synthetic.invalid", kind="openai"),
                               {"model": "synthetic", "max_output_tokens": cap},
                               "synthetic", SCHEMA, AsyncMock(), max_output_tokens=1536)
    assert caught.value.code == "MODEL_CONFIG_INVALID" and caught.value.status == 409
    model.mock.ainvoke.assert_not_awaited()
