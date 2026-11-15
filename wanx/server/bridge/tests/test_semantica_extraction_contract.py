"""Extraction budgets and structural contracts on the signed model callback."""
import json

import pytest
from test_semantica_model_relay import call
from test_semantica_model_relay import relay as _relay

relay = _relay


@pytest.mark.parametrize("kind", ["openai", "ollama"])
@pytest.mark.parametrize("cap,expected", [(None, 8192), (6144, 6144), (2048, 2048)])
async def test_full_extraction_budget_is_forwarded_and_acknowledged(relay, kind, cap, expected):
    relay.provider["kind"] = kind
    relay.model["max_output_tokens"] = cap
    if kind == "ollama":
        relay.output = {"done": True, "message": {"content": '{"ok":true}'}}
    response = await call(relay, max_output_tokens=8192)
    assert response.status_code == 200, response.text
    assert response.json()["max_output_tokens"] == expected
    payload = json.loads(next(r for r in reversed(relay.calls) if r.url.host == "model").content)
    assert (payload["options"]["num_predict"] if kind == "ollama" else payload["max_tokens"]) == expected


async def test_missing_budget_keeps_legacy_cap(relay):
    relay.model["max_output_tokens"] = 16384
    response = await call(relay)
    assert response.status_code == 200
    payload = json.loads(next(r for r in reversed(relay.calls) if r.url.host == "model").content)
    assert payload["max_tokens"] == 4096


@pytest.mark.parametrize("strict", [False, True])
async def test_structural_candidates_pass_but_explicit_enums_remain_enforced(relay, strict):
    label = {"type": "string", "description": 'Use one of: ["ORG"]'}
    if strict:
        label["enum"] = ["ORG"]
    schema = {"type": "object", "required": ["entities"], "additionalProperties": False,
              "properties": {"entities": {"type": "array", "items": {
                  "type": "object", "required": ["label"], "additionalProperties": False,
                  "properties": {"label": label}}}}}
    relay.output["choices"][0]["message"]["content"] = '{"entities":[{"label":"UNKNOWN"}]}'
    response = await call(relay, schema=schema, max_output_tokens=1536)
    assert response.status_code == (502 if strict else 200), response.text
    if strict:
        assert response.json()["output_diagnostic"]["validator"] == "enum"
    else:
        assert json.loads(response.json()["text"])["entities"][0]["label"] == "UNKNOWN"


@pytest.mark.parametrize("sink_fails", [False, True])
async def test_required_callback_diagnostics_and_logging(relay, monkeypatch, caplog, sink_fails):
    import logging
    from unittest.mock import AsyncMock, Mock

    from test_semantica_model_relay import OWNER, PATH, selection, signed

    from wanx_bridge.semantica import model_relay
    from wanx_bridge.semantica.required_models import RequiredModelRelay

    item = await selection(relay)
    body = {"action": "infer", "owner": OWNER, "selection": {"id": item["id"], "revision": item["revision"]},
            "job_id": "synthetic-job", "purpose": "extraction", "text": "PRIVATE_SOURCE",
            "schema": {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]},
            "max_output_tokens": 1536}
    claims = {"modelAction": "infer", "requestId": "synthetic-nonce", "taskId": "synthetic-job",
              "taskDigest": "digest", "bodySha256": "digest", "applicationId": "semantica",
              "modelSnapshot": {"purpose": "extraction", "modelId": item["id"], "modelRevision": item["revision"]},
              "serviceContext": {"principalNamespace": "synthetic-principal"}}
    required = RequiredModelRelay.__new__(RequiredModelRelay)
    required.relay, required.generation, required.tasks = relay.callback, "generation", set()
    required.closed = False
    # Broker proof/lease I/O is synthetic; exercise the actual required callback,
    # model adapter, HTTP error serialization and log boundary on all platforms.
    required._proof = Mock(return_value={})
    required._request = Mock(return_value=("proof", claims, body))
    required._lease = AsyncMock(return_value={"leaseId": "lease"})
    required._authorize = AsyncMock()
    relay.output["choices"][0]["message"]["content"] = '{"ok":"PRIVATE_VALUE"}'
    if sink_fails:
        monkeypatch.setattr(model_relay, "_log_model_failure", Mock(side_effect=RuntimeError("PRIVATE_SINK")))
    relay.callback.required = required
    try:
        with caplog.at_level(logging.WARNING, logger=model_relay.__name__):
            response = await relay.client.post(PATH, **signed(body))
    finally:
        relay.callback.required = None
    assert response.status_code == 502, response.text
    assert response.json()["code"] == "MODEL_INVALID_OUTPUT"
    assert response.json()["output_diagnostic"]["validator"] == "type"
    assert "output_metadata" not in response.json() and "outputMetadata" not in response.json()
    assert "PRIVATE" not in response.text and "PRIVATE" not in caplog.text
    assert required._authorize.await_count >= 2
    assert required._lease.call_args.args[0] == "model-close"
    if not sink_fails:
        event = next(json.loads(r.getMessage()) for r in caplog.records if r.name == model_relay.__name__)
        assert event["event"] == "starlink_model_failure"
        assert event["outputDiagnostic"] == response.json()["output_diagnostic"]
        assert event["outputMetadata"]["max_output_tokens"] == 1536


@pytest.mark.parametrize("cap", [True, False, "2048", 0, -1, 3.5, {}, []])
async def test_invalid_provider_caps_fail_before_inference(relay, cap):
    relay.model["max_output_tokens"] = cap
    response = await call(relay, max_output_tokens=1536)
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "MODEL_CONFIG_INVALID"
    assert not any(r.url.host == "model" for r in relay.calls)
