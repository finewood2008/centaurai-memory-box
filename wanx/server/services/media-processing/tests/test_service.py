import hashlib
import io
import json
import time
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import jwt
from PIL import Image, ImageDraw, ImageFont
import pytest

from wanx_media import media, streaming
from wanx_media.app import ASR_SESSIONS, create_app, INTERNAL, PREFIX, SERVICE
from wanx_media.store import CHUNK, Store


@pytest.fixture
def service(tmp_path):
    key = Ed25519PrivateKey.generate()
    app = create_app(tmp_path, key.public_key(), start_worker=False)
    store = app.state.store

    def auth(instance="desktop", user="alice", grants=media.CAPABILITIES):
        grant, secret = store.grant(
            "box", user, "personal", instance, list(grants), 3600
        )
        claims = dict(
            iss="wanx-bridge",
            aud="wanx-bridge",
            iat=int(time.time()),
            exp=int(time.time()) + 120,
            jti=uuid.uuid4().hex,
            scope=["service:read", "service:write"],
            boxId="box",
            userId=user,
            spaceId="personal",
            serviceId=SERVICE,
            protocolVersion=1,
        )
        kid = hashlib.sha256(key.public_key().public_bytes_raw()).hexdigest()
        token = jwt.encode(claims, key, algorithm="EdDSA", headers={"kid": kid})
        return grant, {"Authorization": "Bearer " + token, "X-Media-Grant": secret}

    return TestClient(app), store, auth, key


def create(client, headers, data, cap="image.fingerprint", request="one", **overrides):
    payload = dict(
        requestId=request,
        capability=cap,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )
    return client.post(PREFIX + "/jobs", headers=headers, json={**payload, **overrides})


def upload_and_submit(client, headers, data, cap="image.fingerprint"):
    created = create(client, headers, data, cap)
    assert created.status_code == 200, created.text
    path = PREFIX + "/jobs/" + created.json()["id"]
    for offset in range(0, len(data), CHUNK):
        response = client.put(
            path + "/input",
            params={"offset": offset},
            headers=headers,
            content=data[offset : offset + CHUNK],
        )
        assert response.status_code == 200, response.text
    assert client.post(path + "/submit", headers=headers).json()["state"] == "queued"
    return path


def test_identity_and_instance(service):
    client, store, auth, _ = service
    _, a = auth()
    _, b = auth("other")
    _, c = auth("mobile", "bob")
    path = upload_and_submit(client, a, b"abc")
    for other in (b, c):
        assert client.get(path, headers=other).status_code == 404
        assert client.get(path + "/result", headers=other).status_code == 404
        assert client.delete(path, headers=other).status_code == 404
    assert (
        client.get(path, headers={**a, "X-Media-Grant": c["X-Media-Grant"]}).status_code
        == 403
    )
    assert (
        client.get(path, headers={"X-Media-Grant": a["X-Media-Grant"]}).status_code
        == 401
    )
    _, limited = auth(grants=["image.fingerprint"])
    assert client.get(PREFIX + "/capabilities", headers=limited).json()[
        "capabilities"
    ] == [media.capability_info("image.fingerprint")]
    assert create(client, limited, b"x", "image.ocr").status_code == 403


def test_summary_default_snapshots_and_idempotent_replay(service, monkeypatch, tmp_path):
    client, store, auth, _ = service
    key_file = tmp_path / "cloud-key"
    key_file.write_text("synthetic-key")
    key_file.chmod(0o600)
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_BASE_URL", "https://summaries.example.com/v1")
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_MODEL", "test-llm")
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_CLOUD_KEY_FILE", str(key_file))
    _, headers = auth(grants=["text.summarize"])
    templates = PREFIX + "/summary-templates"
    summaries = PREFIX + "/summaries"
    body = {"requestId": "meeting", "text": "周六整理照片。"}

    discovery = client.get(PREFIX + "/capabilities", headers=headers).json()
    assert discovery["processingLocation"] == "box"
    assert discovery["capabilities"][0]["processingLocation"] == "cloud"
    assert discovery["capabilities"][0]["configured"] is True
    builtin = client.get(templates + "/default", headers=headers).json()
    assert builtin["id"] == "builtin-default" and builtin["isBuiltin"]
    template = client.post(templates, headers=headers, json={
        "name": "会议纪要", "instructions": "列出会议决定。",
    })
    assert template.status_code == 201
    tid = template.json()["id"]
    assert client.put(templates + "/default", headers=headers, json={"templateId": tid}).json()["id"] == tid
    created = client.post(summaries, headers=headers, json=body)
    assert created.status_code == 202
    receipt = created.json()
    assert receipt["state"] == "queued" and receipt["offset"] == receipt["size"]
    assert client.put(templates + "/" + tid, headers=headers, json={
        "name": "新版", "instructions": "列出所有问题。", "expectedRevision": 1,
    }).json()["revision"] == 2
    assert client.delete(templates + "/" + tid, headers=headers, params={"expectedRevision": 2}).status_code == 200
    assert client.get(templates + "/default", headers=headers).json()["id"] == "builtin-default"
    assert client.post(summaries, headers=headers, json=body).json()["id"] == receipt["id"]
    assert client.post(summaries, headers=headers, json={**body, "text": "修改"}).status_code == 409
    assert client.post(summaries, headers=headers, json={**body, "requestId": "new", "templateId": tid}).status_code == 404
    job = store.claim()
    assert job["id"] == receipt["id"]
    assert json.loads(job["execution_options"])["processingLocation"] == "cloud"
    assert json.loads(job["execution_options"])["template"]["instructions"] == "列出会议决定。"
    store.finish(job["id"], error="SUMMARY_UPSTREAM_FAILED")
    path = PREFIX + "/jobs/" + job["id"]
    assert client.post(path + "/retry", headers=headers).status_code == 200
    again = store.claim()
    assert json.loads(again["execution_options"]) == json.loads(job["execution_options"])
    result = {"model": "test-llm", "templateId": tid, "templateRevision": 1, "text": "周六整理照片。"}
    store.finish(job["id"], result=result)
    assert client.get(path + "/result", headers=headers).json()["result"] == result


def test_summary_permissions_and_input_limits(service, monkeypatch):
    client, _, auth, _ = service
    monkeypatch.delenv("WANX_MEDIA_SUMMARY_CLOUD_BASE_URL", raising=False)
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_BASE_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("WANX_MEDIA_SUMMARY_MODEL", "old-local-model")
    _, headers = auth(grants=["text.summarize"])
    _, limited = auth(grants=["audio.transcribe"])
    _, other = auth(instance="another", grants=["text.summarize"])
    _, rotation = auth(grants=["text.summarize"])
    template_path = PREFIX + "/summary-templates"
    path = PREFIX + "/summaries"
    body = {"requestId": "sample", "text": "需要总结。"}

    assert client.post(path, headers=limited, json=body).status_code == 403
    assert client.get(template_path, headers=limited).status_code == 403
    assert client.post(path, headers=headers, json=body).status_code == 503
    assert client.post(path, headers=headers, json={**body, "text": "中" * 12000}).status_code == 422
    assert client.post(path, headers=headers, json={**body, "text": " \n "}).status_code == 422
    assert create(client, headers, b"x", "text.summarize").json()["code"] == "SUMMARY_ENDPOINT_REQUIRED"
    assert client.post(PREFIX + "/delegations", headers=headers, json={
        "capabilities": ["text.summarize"], "ttlSeconds": 60,
    }).status_code == 403
    record = client.post(template_path, headers=headers, json={
        "name": "工作模板", "instructions": "列出行动。",
    }).json()
    tid = record["id"]
    assert client.get(template_path + "/" + tid, headers=other).status_code == 404
    assert client.get(template_path + "/" + tid, headers=rotation).json() == record


def test_pre_cloud_summary_cannot_be_retried_or_sent(service, monkeypatch, tmp_path):
    client, store, auth, _ = service
    monkeypatch.delenv("WANX_MEDIA_SUMMARY_CLOUD_BASE_URL", raising=False)
    grant_id, headers = auth(grants=["text.summarize"])
    original = b"synthetic pre-cloud payload"
    legacy = {
        "template": {"id": "builtin-default", "revision": 1, "instructions": "summarize"}
    }
    with store.db() as db:
        row = db.execute("SELECT * FROM grants WHERE id=?", (grant_id,)).fetchone()
        job_id = store.create(
            db, row, "legacy", "text.summarize", len(original),
            hashlib.sha256(original).hexdigest(), {"templateId": None},
            snapshot=lambda: legacy,
        )["id"]
        store.append(db, store.owned(db, row, job_id), 0, original)
        store.submit(db, store.owned(db, row, job_id))
    source = tmp_path / "legacy-text"
    source.write_bytes(original)
    with pytest.raises(media.MediaError, match="^SUMMARY_CLOUD_RESUBMIT_REQUIRED$"):
        media.run("text.summarize", source, json.loads(store.claim()["execution_options"]))
    store.finish(job_id, error="SUMMARY_CLOUD_RESUBMIT_REQUIRED")
    response = client.post(PREFIX + "/jobs/" + job_id + "/retry", headers=headers)
    assert response.status_code == 409
    assert response.json()["code"] == "SUMMARY_CLOUD_RESUBMIT_REQUIRED"


def test_idempotent_transfer_and_conflict(service):
    client, store, auth, _ = service
    _, a = auth()
    data = bytes(CHUNK) + b"x"
    job = create(client, a, data).json()["id"]
    path = PREFIX + "/jobs/" + job
    assert create(client, a, data).json()["id"] == job
    assert create(client, a, b"changed").status_code == 409
    assert (
        client.put(path + "/input?offset=0", headers=a, content=data[:CHUNK]).json()[
            "offset"
        ]
        == CHUNK
    )
    assert (
        client.put(path + "/input?offset=0", headers=a, content=data[:CHUNK]).json()[
            "offset"
        ]
        == CHUNK
    )
    assert client.post(path + "/submit", headers=a).status_code == 409
    assert (
        client.put(path + "/input?offset=2", headers=a, content=b"x").status_code == 409
    )
    assert client.put(path + f"/input?offset={CHUNK}", headers=a, content=b"x").json()[
        "offset"
    ] == len(data)
    assert client.post(path + "/submit", headers=a).json()["state"] == "queued"
    assert client.post(path + "/submit", headers=a).json()["state"] == "queued"
    bad = create(client, a, b"x", request="two", sha256="0" * 64).json()["id"]
    client.put(PREFIX + f"/jobs/{bad}/input?offset=0", headers=a, content=b"x")
    assert (
        client.post(PREFIX + f"/jobs/{bad}/submit", headers=a).json()["code"]
        == "DIGEST_MISMATCH"
    )


def test_revocation_races_and_restart(service):
    client, store, auth, _ = service
    gid, a = auth()
    path = upload_and_submit(client, a, b"abc")
    job = store.claim()["id"]
    restart = Store(store.directory)
    restart.recover()
    assert restart.claim()["id"] == job
    restart.finish(job, error="INFERENCE_FAILED")
    assert client.post(path + "/retry", headers=a).json()["state"] == "queued"
    assert restart.claim()["id"] == job
    store.revoke(gid)
    restart.finish(job, result={"private": "late output"})
    assert client.get(path + "/result", headers=a).status_code == 403
    with store.db() as db:
        row = db.execute("SELECT state,result FROM jobs WHERE id=?", (job,)).fetchone()
        assert tuple(row) == ("revoked", None)
        assert db.execute("SELECT count(*) FROM chunks").fetchone()[0] == 0


def test_expiry_and_cancel(service):
    client, store, auth, _ = service
    _, a = auth()
    path = upload_and_submit(client, a, b"abc")
    job = store.claim()["id"]
    assert client.delete(path, headers=a).json()["state"] == "cancelled"
    store.finish(job, result={"text": "late"})
    assert client.get(path + "/result", headers=a).status_code == 409
    with store.db() as db:
        db.execute("UPDATE jobs SET expires=?", (time.time() - 1,))
    assert client.get(path, headers=a).status_code == 410


def make_image():
    image = Image.new("RGB", (640, 150), "white")
    painter = ImageDraw.Draw(image)
    painter.text(
        (20, 20), "WANX 12345", fill="black", font=ImageFont.load_default(size=65)
    )
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def test_worker_end_to_end(service):
    _, store, auth, key = service
    _, a = auth()
    with TestClient(create_app(store.directory, key.public_key())) as client:
        assert client.get("/readyz").json() == {"ready": True}
        path = upload_and_submit(client, a, make_image())
        for _ in range(100):
            if client.get(path, headers=a).json()["state"] == "done":
                break
            time.sleep(0.05)
        result = client.get(path + "/result", headers=a).json()["result"]
        assert result["model"] == "dhash64-v1" and len(result["hash"]) == 16
        assert result["width"] == 640


@pytest.mark.skipif(
    not media.configured("image.ocr"), reason="Deploy local Tesseract to exercise OCR"
)
def test_real_offline_ocr(tmp_path, monkeypatch):
    monkeypatch.setenv("WANX_MEDIA_OCR_LANG", "eng")
    source = tmp_path / "source.png"
    source.write_bytes(make_image())
    result = media.run("image.ocr", source, {})
    assert "12345" in result["text"]
    assert result["words"] and all(len(w["box"]) == 4 for w in result["words"])
    assert all(w["box"][0] + w["box"][2] <= result["width"] for w in result["words"])


def test_model_gate_and_options(service, monkeypatch):
    client, _, auth, _ = service
    _, a = auth()
    monkeypatch.delenv("WANX_MEDIA_ASR_MODEL", raising=False)
    assert (
        create(client, a, b"voice", "audio.transcribe").json()["code"]
        == "MODEL_UNAVAILABLE"
    )
    assert (
        create(
            client,
            a,
            b"image",
            "image.match",
            options={"query": "/tmp", "path": "/tmp"},
        ).status_code
        == 422
    )


@pytest.mark.skipif(
    not media.configured("image.match"), reason="requires a local Chinese-CLIP model"
)
def test_chinese_clip_known_shape_and_queries(tmp_path):
    """Exercise both multi-label classification and the single-query path on real weights."""
    import math

    fixture = Image.new("RGB", (512, 512), "white")
    outline = []
    for i in range(361):
        t = math.radians(i)
        outline.append(
            (
                256 + 12 * 16 * math.sin(t) ** 3,
                240
                - 12
                * (
                    13 * math.cos(t)
                    - 5 * math.cos(2 * t)
                    - 2 * math.cos(3 * t)
                    - math.cos(4 * t)
                ),
            )
        )
    ImageDraw.Draw(fixture).polygon(outline, fill=(225, 12, 42))
    path = tmp_path / "heart.png"
    fixture.save(path)
    yes, no = "白色背景上的红色爱心图案", "道路上行驶的黑色汽车"
    ranked = media.run("image.labels", path, {"labels": [yes, no]})
    assert ranked["labels"][0]["label"] == yes
    score = media.run("image.match", path, {"query": yes})["score"]
    assert score > media.run("image.match", path, {"query": no})["score"]


def test_instance_can_revoke_only_its_own_grant(service):
    client, store, auth, _ = service
    _, a = auth()
    _, b = auth("other")
    pa = upload_and_submit(client, a, b"private a")
    pb = upload_and_submit(client, b, b"private b")
    assert client.delete(PREFIX + "/grant/self", headers=a).json() == {"revoked": True}
    assert client.get(pa, headers=a).status_code == 403
    assert client.get(pb, headers=b).json()["state"] == "queued"


def test_narrow_delegation_requires_loopback_bound_instance_and_live_parent(service):
    _, store, auth, key = service
    app = create_app(store.directory, key.public_key(), start_worker=False)
    local = TestClient(app, client=("127.0.0.1", 12345))
    remote = TestClient(app, client=("192.0.2.2", 12345))
    parent, auth_a = auth(grants=["image.fingerprint", "audio.transcribe"])
    _, auth_b = auth("other", grants=["image.fingerprint"])
    spec = {"capabilities": ["image.fingerprint"], "ttlSeconds": 3600}
    issued = local.post(PREFIX + "/delegations", headers=auth_a, json=spec)
    assert issued.status_code == 200
    child = issued.json()
    h = {"X-Media-Delegation": child["token"]}
    assert local.get(INTERNAL + "/context", headers=h).json()["id"] == child["id"]
    assert (
        "token"
        not in local.get(PREFIX + "/delegations", headers=auth_a).json()["delegations"][
            0
        ]
    )
    assert local.get(PREFIX + "/capabilities", headers=h).status_code == 401
    assert local.get(INTERNAL + "/context", headers=auth_a).status_code == 403
    assert remote.get(INTERNAL + "/context", headers=h).status_code == 403
    assert (
        local.get(
            INTERNAL + "/context", headers={**h, "X-Forwarded-For": "127.0.0.1"}
        ).status_code
        == 403
    )
    other_spec = {"capabilities": ["audio.transcribe"], "ttlSeconds": 120}
    assert (
        local.post(PREFIX + "/delegations", headers=auth_b, json=other_spec).status_code
        == 403
    )
    voice = local.post(PREFIX + "/delegations", headers=auth_a, json=other_spec).json()
    assert voice["capabilities"] == ["audio.transcribe"]
    assert (
        local.delete(PREFIX + "/delegations/" + child["id"], headers=auth_b).status_code
        == 404
    )
    assert (
        local.delete(
            INTERNAL + "/delegation/self",
            headers={"X-Media-Delegation": voice["token"]},
        ).status_code
        == 200
    )
    assert (
        local.get(
            INTERNAL + "/context", headers={"X-Media-Delegation": voice["token"]}
        ).status_code
        == 403
    )
    row = {
        "requestId": "background",
        "capability": "image.fingerprint",
        "size": 3,
        "sha256": hashlib.sha256(b"abc").hexdigest(),
    }
    job = local.post(INTERNAL + "/jobs", json=row, headers=h).json()["id"]
    path = INTERNAL + "/jobs/" + job
    assert (
        local.put(path + "/input?offset=0", headers=h, content=b"abc").status_code
        == 200
    )
    assert local.post(path + "/submit", headers=h).json()["state"] == "queued"
    assert local.get(PREFIX + "/jobs/" + job, headers=auth_a).status_code == 404
    assert (
        local.post(INTERNAL + "/delegations", headers=h, json=spec).status_code == 404
    )
    assert store.claim()["id"] == job
    store.revoke(parent)
    store.finish(job, result={"text": "late result"})
    assert local.get(INTERNAL + "/context", headers=h).status_code == 403
    with store.db() as db:
        assert tuple(
            db.execute("SELECT state,result FROM jobs WHERE id=?", (job,)).fetchone()
        ) == ("revoked", None)
        assert (
            db.execute("SELECT count(*) FROM chunks WHERE job=?", (job,)).fetchone()[0]
            == 0
        )


def test_reuse_only_current_authorized_version_and_recent_query(service):
    client, store, auth, key = service
    first, _ = auth()
    second, _ = auth("other")
    payload = "星期六".encode()
    digest = hashlib.sha256(payload).hexdigest()

    def start(grant, request):
        with store.db() as db:
            ctx = db.execute("SELECT * FROM grants WHERE id=?", (grant,)).fetchone()
            info = store.create(
                db, ctx, request, "text.embedding", len(payload), digest, {}
            )
            row = store.owned(db, ctx, info["id"])
            store.append(db, row, 0, payload)
            store.submit(db, store.owned(db, ctx, row["id"]))
        return store.claim()

    original = start(first, "first")
    store.finish(
        original["id"], result={"model": "test", "vector": [1.0]}, model_stamp="v1"
    )
    twin = start(first, "second")
    assert not store.reuse_query(twin, "v2")
    assert store.reuse_query(twin, "v1")
    other = start(second, "other")
    assert not store.reuse_query(other, "v1")
    stale = start(first, "stale")
    with store.db() as db:
        db.execute("UPDATE jobs SET expires=expires-301 WHERE id=?", (original["id"],))
    assert not store.reuse_query(stale, "v1")
    store.revoke(first)
    assert not store.reuse_query(stale, "v1")


@pytest.mark.skipif(not media.heif_decoder(), reason="optional HEVC decoder absent")
def test_heic_single_frame_and_sequence_limit(tmp_path):
    import pillow_heif

    if not pillow_heif.libheif_info()["HEIF"]:
        pytest.skip("fixture creation requires a HEVC encoder")
    canvas = Image.new("RGB", (128, 128), "white")
    ImageDraw.Draw(canvas).rectangle((30, 20, 85, 106), fill="red")
    file = tmp_path / "original.heic"
    canvas.save(file, format="HEIF", quality=90)
    original = file.read_bytes()
    output = media.run("image.fingerprint", file, {})
    assert (
        output["width"] == 128 and output["height"] == 128 and len(output["hash"]) == 16
    )
    assert file.read_bytes() == original
    sequence = tmp_path / "sequence.heic"
    canvas.save(
        sequence,
        format="HEIF",
        save_all=True,
        append_images=[Image.new("RGB", (128, 128), "black")],
    )
    with pytest.raises(media.MediaError, match="HEIF_FRAME_LIMIT"):
        media.run("image.fingerprint", sequence, {})


@pytest.fixture
def realtime(service, monkeypatch):
    class FakeRecognizer:
        def accept(self, pcm):
            assert pcm == bytes(3200)
            return [{"type": "partial", "segmentId": 0, "text": "万象"}]

        def finish(self):
            return [{"type": "final", "segmentId": 0, "text": "万象盒子"}]

    class FakeModel:
        def configured(self):
            return True

        def open(self):
            return FakeRecognizer()

    monkeypatch.setattr(streaming, "StreamingModel", FakeModel)
    _, store, auth, key = service
    gid, headers = auth(grants=[streaming.CAPABILITY])
    with TestClient(create_app(store.directory, key.public_key(), start_worker=False)) as client:
        yield client, store, auth, gid, headers


def connect_asr(client, session, ticket=None):
    return client.websocket_connect(
        session["streamPath"],
        subprotocols=[
            streaming.PROTOCOL,
            streaming.TICKET_PREFIX + (session["ticket"] if ticket is None else ticket),
        ],
    )


def test_realtime_partial_final_and_one_time_ticket(realtime):
    client, _, _, _, headers = realtime
    caps = client.get(PREFIX + "/capabilities", headers=headers).json()["capabilities"]
    assert [(x["id"], x["configured"]) for x in caps] == [(streaming.CAPABILITY, True)]
    assert create(client, headers, b"file", streaming.CAPABILITY).status_code == 403
    response = client.post(ASR_SESSIONS, headers=headers)
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    session = response.json()
    assert session["ticket"] not in session["streamPath"]
    with pytest.raises(WebSocketDisconnect), connect_asr(client, session, "a" * 43):
        pass
    with connect_asr(client, session) as socket:
        assert socket.accepted_subprotocol == streaming.PROTOCOL
        assert socket.receive_json() == {"type": "ready"}
        busy = client.post(ASR_SESSIONS, headers=headers)
        assert busy.status_code == 429 and busy.json()["code"] == "STREAM_BUSY"
        socket.send_bytes(bytes(3200))
        assert socket.receive_json() == {"type": "partial", "segmentId": 0, "text": "万象"}
        socket.send_json({"type": "end"})
        assert socket.receive_json() == {"type": "final", "segmentId": 0, "text": "万象盒子"}
        assert socket.receive_json() == {"type": "end", "durationMs": 100}
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_json()
        assert closed.value.code == 1000
    with pytest.raises(WebSocketDisconnect), connect_asr(client, session):
        pass


def test_realtime_uses_interactive_grant_and_rechecks_revocation(realtime, monkeypatch):
    client, store, auth, gid, headers = realtime
    _, file_only = auth(grants=["audio.transcribe"])
    assert client.post(ASR_SESSIONS, headers=file_only).status_code == 403
    assert client.post(ASR_SESSIONS).status_code == 401
    delegated = client.post(
        PREFIX + "/delegations",
        headers=headers,
        json={"capabilities": [streaming.CAPABILITY], "ttlSeconds": 60},
    )
    assert delegated.status_code == 403
    monkeypatch.setattr(streaming, "AUTH_INTERVAL", 0.02)
    response = client.post(ASR_SESSIONS, headers=headers)
    with connect_asr(client, response.json()) as socket:
        assert socket.receive_json()["type"] == "ready"
        store.revoke(gid)
        assert socket.receive_json() == {"type": "error", "code": "STREAM_GRANT_REVOKED"}


@pytest.mark.parametrize(
    ("frame", "code"),
    [(b"1", "INVALID_AUDIO_FRAME"), (bytes(6402), "AUDIO_FRAME_TOO_LARGE")],
)
def test_realtime_rejects_invalid_audio_and_releases_slot(realtime, frame, code):
    client, _, _, _, headers = realtime
    for _ in range(2):
        response = client.post(ASR_SESSIONS, headers=headers)
        assert response.status_code == 201
        with connect_asr(client, response.json()) as socket:
            assert socket.receive_json()["type"] == "ready"
            socket.send_bytes(frame)
            assert socket.receive_json() == {"type": "error", "code": code}
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()


def test_realtime_ticket_expiration(realtime, monkeypatch):
    client, _, _, _, headers = realtime
    monkeypatch.setattr(streaming, "TICKET_TTL", -1)
    session = client.post(ASR_SESSIONS, headers=headers).json()
    with pytest.raises(WebSocketDisconnect), connect_asr(client, session):
        pass


def test_recording_grant_remains_valid_until_revoked(service, monkeypatch):
    import asyncio
    from wanx_media.store import Problem

    client, store, auth, _ = service
    caps = ["audio.transcribe", streaming.CAPABILITY]
    instance = "memobox-recording-" + "a" * 32
    args = ("box", "alice", "personal", instance)
    gid, headers = auth(instance, grants=caps)
    other_id, finite = auth(instance, grants=caps)
    wrong_caps, _ = auth(instance, grants=[*caps, "text.summarize"])
    with pytest.raises(Problem):
        store.retain_recording_grant(wrong_caps, *args)
    with pytest.raises(Problem):
        store.retain_recording_grant(gid, "other-box", *args[1:])
    for _ in range(2):
        assert store.retain_recording_grant(gid, *args)["expiresAt"] is None

    with store.db() as db:
        db.execute("UPDATE grants SET expires=0 WHERE id IN (?,?)", (gid, other_id))
        parent = store.authorize(db, dict(boxId="box", userId="alice", spaceId="personal"), headers["X-Media-Grant"])
        child = store.delegate(db, parent, ["audio.transcribe"], 60)
        assert time.time() < child["expiresAt"] <= time.time() + 60
        store.sweep(db)
        assert store.authorize_delegate(db, child["token"])["id"] == child["id"]
    with pytest.raises(Problem):
        store.retain_recording_grant(other_id, *args)
    path = PREFIX + "/capabilities"
    assert client.get(path, headers=finite).status_code == 403
    assert client.get(path, headers=headers).json()["grantExpiresAt"] is None
    monkeypatch.setattr(streaming.StreamingModel, "configured", lambda self: True)
    stream = client.post(ASR_SESSIONS, headers=headers)
    assert stream.status_code == 201
    assert time.time() < stream.json()["ticketExpiresAt"] <= time.time() + streaming.TICKET_TTL
    sessions = streaming.StreamingSessions(store)
    asyncio.run(sessions.require_grant(gid))
    store.revoke(gid)
    assert client.get(path, headers=headers).status_code == 403
    assert client.post(ASR_SESSIONS, headers=headers).status_code == 403
    with pytest.raises(Problem):
        asyncio.run(sessions.require_grant(gid))
    with pytest.raises(Problem):
        store.retain_recording_grant(gid, *args)
    with store.db() as db, pytest.raises(Problem):
        store.authorize_delegate(db, child["token"])


def test_cloud_summary_opt_in_is_bound_to_the_recording_grant(service):
    from wanx_media.store import Problem

    client, store, auth, _ = service
    caps = ["audio.transcribe", streaming.CAPABILITY]
    instance = "memobox-recording-" + "b" * 32
    args = ("box", "alice", "personal", instance)
    gid, headers = auth(instance, grants=caps)
    other, _ = auth(instance, grants=["image.ocr"])
    for bad_args in [(other, *args), (gid, "other", *args[1:]), (gid, *args[:3], "other-app")]:
        with pytest.raises(Problem):
            store.enable_recording_summary(*bad_args)
    read = lambda: client.get(PREFIX + "/capabilities", headers=headers).json()
    prior = read()
    assert "text.summarize" not in [item["id"] for item in prior["capabilities"]]
    for _ in range(2):
        assert store.enable_recording_summary(gid, *args)["expiresAt"] == prior["grantExpiresAt"]
    info = read()
    assert {item["id"] for item in info["capabilities"]} == {*caps, "text.summarize"}
    store.revoke(gid)
    with pytest.raises(Problem):
        store.enable_recording_summary(gid, *args)
