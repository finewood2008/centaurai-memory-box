import hashlib
import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from test_processing_models import fixture as _shared_fixture
from wanx_bridge.semantica import models
from wanx_bridge.semantica.client import SemanticaError

fixture = _shared_fixture


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 429, 503])
async def test_authorized_failure_logs_status_and_hashes_without_changing_public_error(
    fixture, monkeypatch, caplog, status
):
    services, _, signed = fixture
    selected = models._catalog(services)[0][0]
    secret = "synthetic-private-prompt-token-url-user"
    request = httpx.Request("POST", "https://private.invalid/" + secret)
    failure = httpx.HTTPStatusError(
        secret, request=request, response=httpx.Response(status, request=request, text=secret)
    )
    monkeypatch.setattr(
        models.SemanticaClient, "request", AsyncMock(return_value={"authorized": True})
    )
    monkeypatch.setattr(models, "_generate", AsyncMock(side_effect=failure))
    raw, headers = signed(
        "infer",
        selection=selected,
        job_id="authorized-job",
        purpose="extraction",
        text=secret,
        schema={},
    )
    with (
        caplog.at_level(logging.WARNING, logger=models.__name__),
        pytest.raises(SemanticaError, match="MODEL_CALL_FAILED") as caught,
    ):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    assert caught.value.status == 502
    records = [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == models.__name__
    ]
    assert len(records) == 1
    event = records[0]
    assert event["event"] == "starlink_model_failure"
    assert event["publicCode"] == "MODEL_CALL_FAILED"
    assert event["category"] == "upstream_http"
    assert event["upstreamStatus"] == status
    assert event["jobHash"] == hashlib.sha256(b"authorized-job").hexdigest()
    assert event["requestHash"] == hashlib.sha256(headers["x-starklink-nonce"].encode()).hexdigest()
    assert set(event) == {
        "event",
        "timestamp",
        "publicCode",
        "category",
        "upstreamStatus",
        "jobHash",
        "requestHash",
    }
    assert secret not in caplog.text
    assert "authorized-job" not in caplog.text
    assert services.audit_repo.write.call_count == 0


@pytest.mark.asyncio
async def test_real_sdk_generate_failure_keeps_safe_status(fixture, monkeypatch, caplog):
    import openai
    from octop_harness.llm import session_header

    services, _, signed = fixture
    request = httpx.Request("POST", "https://private.invalid/synthetic-secret")
    failure = openai.RateLimitError(
        "synthetic-secret",
        response=httpx.Response(429, request=request),
        body={"private": "synthetic-secret"},
    )
    model = SimpleNamespace(ainvoke=AsyncMock(side_effect=failure))
    monkeypatch.setattr(models, "build_probe_chat_model", lambda *a, **kw: model)
    monkeypatch.setattr(session_header, "aclose_session_http_clients", AsyncMock())
    monkeypatch.setattr(
        models.SemanticaClient, "request", AsyncMock(return_value={"authorized": True})
    )
    raw, headers = signed(
        "infer",
        selection=models._catalog(services)[0][0],
        job_id="authorized-job",
        purpose="extraction",
        text="synthetic-secret",
        schema={},
    )
    with (
        caplog.at_level(logging.WARNING, logger=models.__name__),
        pytest.raises(SemanticaError, match="MODEL_CALL_FAILED"),
    ):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    event = json.loads(next(r.getMessage() for r in caplog.records if r.name == models.__name__))
    assert event["upstreamStatus"] == 429
    assert event["category"] == "upstream_http"
    assert "synthetic-secret" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure,category",
    [
        (httpx.ReadTimeout("synthetic-private"), "timeout"),
        (httpx.ConnectError("synthetic-private"), "network"),
        (RuntimeError("synthetic-private"), "unknown"),
    ],
)
async def test_synthetic_check_logs_no_job_or_exception_text(
    fixture, monkeypatch, caplog, failure, category
):
    services, _, signed = fixture
    monkeypatch.setattr(models, "_generate", AsyncMock(side_effect=failure))
    raw, headers = signed(
        "check", selection=models._catalog(services)[0][0], job_id="untrusted-job"
    )
    with (
        caplog.at_level(logging.WARNING, logger=models.__name__),
        pytest.raises(SemanticaError, match="MODEL_CALL_FAILED"),
    ):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    event = json.loads(next(r.getMessage() for r in caplog.records if r.name == models.__name__))
    assert event["jobHash"] is None
    assert event["upstreamStatus"] is None
    assert event["category"] == category
    assert "synthetic-private" not in caplog.text and "untrusted-job" not in caplog.text


@pytest.mark.asyncio
async def test_revoked_task_is_not_called_or_logged(fixture, monkeypatch, caplog):
    services, _, signed = fixture
    generate = AsyncMock()
    monkeypatch.setattr(models, "_generate", generate)
    monkeypatch.setattr(
        models.SemanticaClient,
        "request",
        AsyncMock(
            side_effect=[
                {"authorized": True},
                {"authorized": False},
            ]
        ),
    )
    raw, headers = signed(
        "infer",
        selection=models._catalog(services)[0][0],
        job_id="untrusted-job",
        purpose="extraction",
        text="synthetic",
        schema={},
    )
    with (
        caplog.at_level(logging.WARNING, logger=models.__name__),
        pytest.raises(SemanticaError, match="MODEL_TASK_REVOKED"),
    ):
        await models.internal(raw, headers, services, AsyncMock(return_value=False))
    generate.assert_not_called()
    assert not any(r.name == models.__name__ for r in caplog.records)


@pytest.mark.asyncio
@pytest.mark.parametrize("code", ["MODEL_CALL_FAILED", "MODEL_INVALID_OUTPUT"])
async def test_logging_handler_failure_preserves_original_public_error(fixture, monkeypatch, code):
    services, _, signed = fixture
    request = httpx.Request("POST", "https://private.invalid")
    failure = (
        httpx.HTTPStatusError(
            "private", request=request, response=httpx.Response(429, request=request)
        )
        if code == "MODEL_CALL_FAILED"
        else SemanticaError(code, 502)
    )
    generate = AsyncMock(side_effect=failure)
    monkeypatch.setattr(models, "_generate", generate)
    authorize = AsyncMock(return_value={"authorized": True})
    monkeypatch.setattr(models.SemanticaClient, "request", authorize)
    raw, headers = signed(
        "infer",
        selection=models._catalog(services)[0][0],
        job_id="authorized-job",
        purpose="extraction",
        text="synthetic",
        schema={},
    )

    class BrokenHandler(logging.Handler):
        calls = 0

        def emit(self, record):
            self.calls += 1
            raise RuntimeError("synthetic diagnostic sink failed")

    handler = BrokenHandler()
    logger = logging.getLogger(models.__name__)
    logger.addHandler(handler)
    try:
        with pytest.raises(SemanticaError, match=code) as caught:
            await models.internal(raw, headers, services, AsyncMock(return_value=False))
    finally:
        logger.removeHandler(handler)
    assert caught.value.status == 502
    assert handler.calls == 1
    assert generate.await_count == 1
    assert authorize.await_count == 2
