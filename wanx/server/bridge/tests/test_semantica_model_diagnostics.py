import hashlib
import json
import logging

import httpx
import pytest
from test_semantica_model_relay import call
from test_semantica_model_relay import relay as _shared_relay

relay = _shared_relay


@pytest.mark.parametrize("status", [401, 402, 429, 503])
async def test_personal_authorized_upstream_failure_has_private_diagnostic(relay, caplog, status):
    secret = "synthetic-private-prompt-token-url-user"

    async def fail(request):
        return httpx.Response(status, text=secret)

    relay.handler = fail
    with caplog.at_level(logging.WARNING, logger="wanx_bridge.semantica.model_relay"):
        result = await call(relay, text=secret)
    expected_code = "MODEL_BILLING_REQUIRED" if status == 402 else "MODEL_CALL_FAILED"
    assert result.status_code == (402 if status == 402 else 502)
    assert result.json()["code"] == expected_code
    records = [
        json.loads(r.getMessage())
        for r in caplog.records
        if r.name == "wanx_bridge.semantica.model_relay"
    ]
    assert len(records) == 1
    event = records[0]
    assert event["event"] == "starlink_model_failure"
    assert event["category"] == "upstream_http"
    assert event["upstreamStatus"] == status
    assert event["publicCode"] == expected_code
    assert event["jobHash"] == hashlib.sha256(b"job-1").hexdigest()
    assert len(event["requestHash"]) == 64
    assert secret not in caplog.text
    assert "job-1" not in caplog.text


@pytest.mark.parametrize(
    "failure,category",
    [
        (httpx.ReadTimeout("synthetic-private"), "timeout"),
        (httpx.ConnectError("synthetic-private"), "network"),
    ],
)
async def test_personal_transport_failures_keep_public_behavior(relay, caplog, failure, category):
    async def fail(request):
        raise failure

    relay.handler = fail
    with caplog.at_level(logging.WARNING, logger="wanx_bridge.semantica.model_relay"):
        result = await call(relay)
    assert result.status_code == 503
    assert result.json()["code"] == "MODEL_SERVICE_UNAVAILABLE"
    event = json.loads(
        next(
            r.getMessage() for r in caplog.records if r.name == "wanx_bridge.semantica.model_relay"
        )
    )
    assert event["category"] == category and event["upstreamStatus"] is None
    assert "synthetic-private" not in caplog.text


async def test_personal_check_has_no_untrusted_job_binding(relay, caplog):
    async def fail(request):
        return httpx.Response(429)

    relay.handler = fail
    with caplog.at_level(logging.WARNING, logger="wanx_bridge.semantica.model_relay"):
        result = await call(relay, action="check", job_id="untrusted-job")
    assert result.status_code == 502
    event = json.loads(
        next(
            r.getMessage() for r in caplog.records if r.name == "wanx_bridge.semantica.model_relay"
        )
    )
    assert event["jobHash"] is None
    assert event["upstreamStatus"] == 429
    assert "untrusted-job" not in caplog.text


async def test_personal_revoked_task_has_no_model_failure_log(relay, caplog):
    relay.authorized = {"authorized": False}
    with caplog.at_level(logging.WARNING, logger="wanx_bridge.semantica.model_relay"):
        result = await call(relay)
    assert result.status_code == 403
    assert result.json()["code"] == "MODEL_TASK_REVOKED"
    assert not any(r.name == "wanx_bridge.semantica.model_relay" for r in caplog.records)


@pytest.mark.parametrize("code", ["MODEL_CALL_FAILED", "MODEL_INVALID_OUTPUT"])
async def test_personal_logging_handler_failure_preserves_original_error(relay, code):
    async def fail(request):
        return (
            httpx.Response(429)
            if code == "MODEL_CALL_FAILED"
            else httpx.Response(200, text="invalid")
        )

    relay.handler = fail

    class BrokenHandler(logging.Handler):
        calls = 0

        def emit(self, record):
            self.calls += 1
            raise RuntimeError("synthetic diagnostic sink failed")

    logger = logging.getLogger("wanx_bridge.semantica.model_relay")
    handler = BrokenHandler()
    logger.addHandler(handler)
    try:
        result = await call(relay)
    finally:
        logger.removeHandler(handler)
    assert result.status_code == 502
    assert result.json()["code"] == code
    assert handler.calls == 1
    assert sum(request.url.host == "model" for request in relay.calls) == 1
