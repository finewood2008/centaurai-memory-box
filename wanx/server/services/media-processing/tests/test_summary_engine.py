from datetime import datetime, timedelta, timezone
import json
import socket
import ssl
import threading
import time
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from wanx_media import summary_engine
from wanx_media.media import MediaError


OPTIONS = {
    "processingLocation": "cloud",
    "template": {
        "id": "meeting",
        "revision": 2,
        "instructions": "List confirmed decisions.",
    },
}
RELAY_CREDENTIAL = "wmp1." + "a" * 64 + "." + "B_-" + "Z" * 40


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "input"
    path.write_text("讨论决定在周五发布。", encoding="utf-8")
    return path


@pytest.fixture
def cloud_config(tmp_path, monkeypatch):
    key_file = tmp_path / "cloud-api-key"
    key_file.write_text("synthetic-provider-key\n", encoding="ascii")
    key_file.chmod(0o400)
    monkeypatch.delenv("WANX_MEDIA_SUMMARY_MANAGED_PROVIDER", raising=False)
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_BASE_URL", "https://summary.example.com/v1")
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_MODEL", "cloud-model")
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_KEY_FILE", str(key_file))
    return key_file


@pytest.fixture
def managed_config(cloud_config, monkeypatch):
    cloud_config.chmod(0o600)
    cloud_config.write_text(RELAY_CREDENTIAL + "\n", encoding="ascii")
    monkeypatch.delenv("WANX_MEDIA_SUMMARY_CLOUD_BASE_URL")
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_MANAGED_PROVIDER", "deepseek-cloud")
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_MODEL", "deepseek-v4-flash")
    return cloud_config


@pytest.mark.parametrize("status", [200, 307, 403])
def test_managed_summaries_use_only_box_relay(source, managed_config, monkeypatch, status):
    upstream = []

    class RelayHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            upstream.append((self.path, self.headers["Authorization"], request))
            data = json.dumps({"choices": [{"message": {"content": "决定周五发布。"}}]}).encode()
            self.send_response(status)
            if status == 307:
                self.send_header("Location", "https://summary.example.com/v1/chat/completions")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), RelayHandler) as server:
        def dial_relay(host, port, *, timeout):
            assert (host, port) == ("127.0.0.1", 18089)
            return HTTPConnection(host, server.server_port, timeout=timeout)

        def deny_direct(*_args):
            pytest.fail("managed summary attempted a direct provider request")

        monkeypatch.setattr(summary_engine, "HTTPConnection", dial_relay)
        monkeypatch.setattr(summary_engine, "_resolve_public", deny_direct)
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        thread = threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True)
        thread.start()
        try:
            assert summary_engine.configured()
            if status == 200:
                assert summary_engine.summarize(source, OPTIONS) == {
                    "model": "deepseek-v4-flash",
                    "templateId": "meeting",
                    "templateRevision": 2,
                    "text": "决定周五发布。",
                }
            else:
                with pytest.raises(MediaError, match="^SUMMARY_UPSTREAM_FAILED$"):
                    summary_engine.summarize(source, OPTIONS)
        finally:
            server.shutdown()
            thread.join()
    (path, authorization, payload), = upstream
    assert path == "/model-providers/deepseek-cloud/v1/chat/completions"
    assert authorization == "Bearer " + RELAY_CREDENTIAL
    assert payload["model"] == "deepseek-v4-flash"
    assert payload["messages"][1]["content"] == "讨论决定在周五发布。"


@pytest.mark.parametrize("provider", ["", "DeepSeek", "./deepseek", "other/../deepseek", "x%2fy"])
def test_managed_rejects_invalid_provider(provider, managed_config, monkeypatch):
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_MANAGED_PROVIDER", provider)
    assert not summary_engine.configured()


@pytest.mark.parametrize("base", ["", "https://summary.example.com/v1"])
def test_managed_rejects_direct_route_configuration(base, managed_config, monkeypatch):
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_BASE_URL", base)
    assert not summary_engine.configured()


@pytest.mark.parametrize("key", ["vendor-key", RELAY_CREDENTIAL[:-1], RELAY_CREDENTIAL[:-1] + "/"])
def test_managed_requires_opaque_relay_credential(key, managed_config):
    managed_config.write_text(key, encoding="ascii")
    assert not summary_engine.configured()


def test_direct_cannot_send_opaque_relay_credential(cloud_config):
    cloud_config.chmod(0o600)
    cloud_config.write_text(RELAY_CREDENTIAL, encoding="ascii")
    assert not summary_engine.configured()


@pytest.fixture(scope="session")
def local_certificate(tmp_path_factory):
    path = tmp_path_factory.mktemp("https")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "summary.example.com")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("summary.example.com")]), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    cert_file, key_file = path / "certificate.pem", path / "certificate-key.pem"
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return cert_file, key_file


@pytest.fixture
def model_endpoint(monkeypatch, cloud_config, local_certificate):
    class ModelHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            server = self.server
            data = self.rfile.read(int(self.headers["Content-Length"]))
            server.request_headers.append(dict(self.headers))
            server.received.append((self.path, json.loads(data)))
            server.prepare_response(self)

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler) as server:
        server.received = []
        server.request_headers = []
        server.sni = []
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cert, key = local_certificate
        tls.load_cert_chain(cert, key)
        tls.set_servername_callback(lambda _socket, host, _context: server.sni.append(host))
        server.socket = tls.wrap_socket(server.socket, server_side=True)

        def reply(handler):
            data = json.dumps(
                {"choices": [{"message": {"content": "  决定周五发布。  "}}]},
                ensure_ascii=False,
            ).encode()
            handler.send_response(200)
            handler.send_header("Content-Length", str(len(data)))
            handler.end_headers()
            handler.wfile.write(data)

        server.prepare_response = reply
        context = ssl.create_default_context(cafile=str(cert))

        def pinned_dial(destination, timeout):
            assert destination == ("93.184.216.34", 443)
            connection = socket.socket()
            connection.settimeout(timeout)
            try:
                connection.connect(("127.0.0.1", server.server_port))
                return connection
            except BaseException:
                connection.close()
                raise

        monkeypatch.setattr(
            socket, "getaddrinfo",
            lambda *_args, **_kwargs: [
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443))
            ],
        )
        monkeypatch.setattr(socket, "create_connection", pinned_dial)
        monkeypatch.setattr(ssl, "create_default_context", lambda: context)
        thread = threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            thread.join()


def test_summarizes_with_pinned_cloud_tls(source, model_endpoint, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    assert summary_engine.configured()
    assert summary_engine.summarize(source, OPTIONS) == {
        "model": "cloud-model",
        "templateId": "meeting",
        "templateRevision": 2,
        "text": "决定周五发布。",
    }
    (path, request), = model_endpoint.received
    assert path == "/v1/chat/completions"
    assert request["model"] == "cloud-model"
    assert model_endpoint.sni == ["summary.example.com"]
    assert model_endpoint.request_headers[0]["Host"] == "summary.example.com"
    assert model_endpoint.request_headers[0]["Authorization"] == "Bearer synthetic-provider-key"
    assert request["stream"] is False
    assert 0 < request["max_tokens"] <= 2048
    instructions, content = request["messages"]
    assert instructions["role"] == "system"
    assert "List confirmed decisions." in instructions["content"]
    assert content == {"role": "user", "content": "讨论决定在周五发布。"}
    assert "tools" not in request


@pytest.mark.parametrize("base", [
    "",
    "http://summary.example.com/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://somehost.internal/v1",
    "https://u@summary.example.com/v1",
    "https://summary.example.com/v1?query=value",
    "https://summary.example.com:8443/v1",
    "http://localhost:11434/v1",
    "http://192.168.0.10:11434/v1",
    "http://127.0.0.1:11434/model-providers/remote/v1",
    "http://user@127.0.0.1:11434/v1",
    "http://127.0.0.1:11434/v1?secret=value",
    "http://127.0.0.1:99999/v1",
])
def test_rejects_untrusted_endpoints(base, source, cloud_config, monkeypatch):
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_BASE_URL", base)
    assert not summary_engine.configured()
    with pytest.raises(MediaError, match="^SUMMARY_MODEL_UNAVAILABLE$"):
        summary_engine.summarize(source, OPTIONS)


@pytest.mark.parametrize("addresses", [
    ["127.0.0.1"], ["93.184.216.34", "10.0.0.1"], ["::1"], ["224.0.0.1"],
])
def test_rejects_private_or_mixed_dns_before_dial(
    addresses, source, model_endpoint, monkeypatch
):
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, 443)) for ip in addresses
        ],
    )
    with pytest.raises(MediaError, match="^SUMMARY_CLOUD_DESTINATION_DENIED$"):
        summary_engine.summarize(source, OPTIONS)
    assert model_endpoint.sni == []


def test_rejects_invalid_tls_hostname(source, model_endpoint, monkeypatch):
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_BASE_URL", "https://different.example.com/v1")
    with pytest.raises(MediaError, match="^SUMMARY_UPSTREAM_FAILED$"):
        summary_engine.summarize(source, OPTIONS)
    assert model_endpoint.sni == ["different.example.com"]
    assert model_endpoint.received == []


def test_key_file_must_be_private_and_regular(cloud_config, tmp_path, monkeypatch):
    cloud_config.chmod(0o644)
    assert not summary_engine.configured()
    cloud_config.chmod(0o400)
    symlink = tmp_path / "symlink"
    symlink.symlink_to(cloud_config)
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_KEY_FILE", str(symlink))
    assert not summary_engine.configured()
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_KEY_FILE", str(tmp_path))
    assert not summary_engine.configured()


def test_legacy_configuration_and_jobs_never_send_text(source, model_endpoint, monkeypatch):
    legacy = {key: value for key, value in OPTIONS.items() if key != "processingLocation"}
    with pytest.raises(MediaError, match="^SUMMARY_CLOUD_RESUBMIT_REQUIRED$"):
        summary_engine.summarize(source, legacy)
    monkeypatch.delenv("WANX_MEDIA_SUMMARY_CLOUD_BASE_URL")
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_BASE_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_MODEL", "local-model")
    assert not summary_engine.configured()
    with pytest.raises(MediaError, match="^SUMMARY_MODEL_UNAVAILABLE$"):
        summary_engine.summarize(source, OPTIONS)
    assert model_endpoint.received == []


def test_does_not_follow_redirect(source, model_endpoint):
    def redirect(handler):
        handler.send_response(307)
        handler.send_header("Location", "/would-forward")
        handler.end_headers()

    model_endpoint.prepare_response = redirect
    with pytest.raises(MediaError, match="^SUMMARY_UPSTREAM_FAILED$"):
        summary_engine.summarize(source, OPTIONS)
    assert len(model_endpoint.received) == 1


@pytest.mark.parametrize(
    "data",
    [b"", b"  ", b"\xff", b"a" * (summary_engine.MAX_INPUT_BYTES + 1)],
    ids=["empty", "blank", "invalid-utf8", "oversized"],
)
def test_rejects_invalid_input_before_inference(data, source, model_endpoint):
    source.write_bytes(data)
    with pytest.raises(MediaError, match="^SUMMARY_INVALID_INPUT$"):
        summary_engine.summarize(source, OPTIONS)
    assert model_endpoint.received == []


@pytest.mark.parametrize(
    ("data", "error"),
    [
        (b"not-json", "SUMMARY_INVALID_OUTPUT"),
        (b'{"choices":[{"message":{"content":" "}}]}', "SUMMARY_INVALID_OUTPUT"),
        (
            b'{"choices":[{"finish_reason":"length","message":{"content":"partial"}}]}',
            "SUMMARY_RESULT_LIMIT",
        ),
        (b" " * (summary_engine.MAX_RESPONSE_BYTES + 1), "SUMMARY_RESULT_LIMIT"),
    ],
    ids=["malformed-json", "blank-result", "truncated-output", "oversized-response"],
)
def test_validates_model_response(data, error, source, model_endpoint):
    def invalid_reply(handler):
        handler.send_response(200)
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    model_endpoint.prepare_response = invalid_reply
    with pytest.raises(MediaError, match=f"^{error}$"):
        summary_engine.summarize(source, OPTIONS)


def test_deadline_stops_a_slow_response(source, model_endpoint, monkeypatch):
    monkeypatch.setattr(summary_engine, "REQUEST_TIMEOUT_SECONDS", 0.08)
    response_done = threading.Event()

    def drip(handler):
        handler.send_response(200)
        handler.send_header("Content-Length", "200")
        handler.end_headers()
        try:
            for _ in range(20):
                handler.wfile.write(b" ")
                time.sleep(0.02)
        except OSError:
            pass
        finally:
            response_done.set()

    model_endpoint.prepare_response = drip
    with pytest.raises(MediaError, match="^SUMMARY_TIMEOUT$"):
        summary_engine.summarize(source, OPTIONS)
    assert response_done.wait(1)


def test_requires_a_resolved_template(source, model_endpoint):
    with pytest.raises(MediaError, match="^SUMMARY_INVALID_TEMPLATE$"):
        summary_engine.summarize(
            source, {"processingLocation": "cloud", "template": {"id": "meeting", "revision": 2}}
        )
    assert model_endpoint.received == []
