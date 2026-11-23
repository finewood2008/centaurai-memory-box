"""Repeatable offline HTTP acceptance using a disposable signing domain and store."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import socket
import sys
import tempfile
import threading
import time
import unicodedata
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import jwt
from PIL import Image, ImageDraw, ImageFont
import uvicorn

from .app import INTERNAL, PREFIX, SERVICE, create_app
from .media import CAPABILITIES
from .store import CHUNK


class Failure(Exception):
    """Only non-sensitive diagnostic codes may appear in an acceptance report."""


class Client:
    def __init__(self, origin, key, secret):
        self.origin = origin
        self.key = key
        self.secret = secret
        self.prefix = PREFIX if key is not None else INTERNAL
        self.kid = (
            hashlib.sha256(key.public_key().public_bytes_raw()).hexdigest()
            if key
            else None
        )

    def headers(self):
        if self.key is None:
            return {"X-Media-Delegation": self.secret}
        now = int(time.time())
        token = jwt.encode(
            {
                "iss": "wanx-bridge",
                "aud": "wanx-bridge",
                "boxId": "fixture-box",
                "userId": "fixture-account",
                "spaceId": "personal",
                "serviceId": SERVICE,
                "protocolVersion": 1,
                "iat": now,
                "exp": now + 60,
                "jti": uuid.uuid4().hex,
                "scope": ["service:read", "service:write"],
            },
            self.key,
            algorithm="EdDSA",
            headers={"kid": self.kid},
        )
        return {"Authorization": "Bearer " + token, "X-Media-Grant": self.secret}

    def call(self, method, route, *, obj=None, data=None, expected=200):
        if obj is not None:
            data = json.dumps(obj).encode()
        req = Request(
            self.origin + self.prefix + route,
            method=method,
            data=data,
            headers={
                **self.headers(),
                "Content-Type": "application/json"
                if obj is not None
                else "application/octet-stream",
            },
        )
        try:
            with urlopen(req, timeout=90) as res:
                status = res.status
                value = json.load(res)
        except HTTPError as exc:
            status = exc.code
            try:
                value = json.load(exc)
            finally:
                exc.close()
        if status != expected:
            # Status and server's public error code are enough; never echo inputs or output.
            raise Failure(
                f"HTTP_{status}_" + str(value.get("code", "UNEXPECTED_STATUS"))
            )
        return value

    def upload(self, file, cap, options):
        size = file.stat().st_size
        with file.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        spec = {
            "requestId": uuid.uuid4().hex,
            "capability": cap,
            "size": size,
            "sha256": digest,
            "options": options,
        }
        job = self.call("POST", "/jobs", obj=spec)["id"]
        if self.call("POST", "/jobs", obj=spec)["id"] != job:
            raise Failure("IDEMPOTENCY_FAILED")
        path = "/jobs/" + job
        self.call("POST", path + "/submit", expected=409)
        with file.open("rb") as source:
            offset = 0
            while block := source.read(CHUNK):
                url = path + f"/input?offset={offset}"
                confirmed = self.call("PUT", url, data=block)["offset"]
                if (
                    offset == 0
                    and self.call("PUT", url, data=block)["offset"] != confirmed
                ):
                    raise Failure("DUPLICATE_CHUNK_RECEIPT")
                offset += len(block)
                if confirmed != offset:
                    raise Failure("OFFSET_MISMATCH")
        self.call("POST", path + "/submit")
        return path

    def wait(self, path, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            job = self.call("GET", path)
            if job["state"] == "done":
                return self.call("GET", path + "/result")["result"]
            if job["state"] not in ("queued", "running"):
                raise Failure(str(job.get("error") or job["state"]))
            time.sleep(0.25)
        self.call("DELETE", path)
        raise Failure("WAIT_TIMEOUT")


@contextmanager
def local_server(directory):
    key = Ed25519PrivateKey.generate()
    app = create_app(directory, key.public_key())
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        origin = f"http://127.0.0.1:{sock.getsockname()[1]}"
        config = uvicorn.Config(
            app, host="127.0.0.1", log_level="error", access_log=False
        )
        server = uvicorn.Server(config)
        thread = threading.Thread(
            target=server.run, kwargs={"sockets": [sock]}, daemon=True
        )
        thread.start()
        try:
            for _ in range(200):
                if server.started:
                    break
                time.sleep(0.05)
            if not server.started:
                raise Failure("STARTUP_FAILED")
            yield app.state.store, origin, key
        finally:
            server.should_exit = True
            thread.join(timeout=20)


def normalize(value):
    return "".join(
        c for c in unicodedata.normalize("NFKC", value).casefold() if c.isalnum()
    )


def checked(condition, code):
    if not condition:
        raise Failure(code)


def suite(args, report, directory):
    png = directory / "sample.png"
    image = Image.new("RGB", (640, 150), "white")
    painter = ImageDraw.Draw(image)
    painter.text(
        (16, 20), "WANX 12345", fill="black", font=ImageFont.load_default(size=65)
    )
    image.save(png)
    with local_server(directory / "service") as (store, origin, key):

        def client(instance):
            gid, secret = store.grant(
                "fixture-box",
                "fixture-account",
                "personal",
                instance,
                list(CAPABILITIES),
                3600,
            )
            return gid, Client(origin, key, secret)

        _, own = client("homeai")
        _, other = client("other-instance")
        info = own.call("GET", "/capabilities")
        report["capabilities"] = info["capabilities"]
        available = {row["id"]: row["configured"] for row in info["capabilities"]}
        last_path = None

        def task(cap, source, options=None):
            nonlocal last_path
            start = time.monotonic()
            last_path = own.upload(source, cap, options or {})
            other.call("GET", last_path, expected=404)
            other.call("GET", last_path + "/result", expected=404)
            other.call("DELETE", last_path, expected=404)
            submitted = time.monotonic()
            result = own.wait(last_path, args.timeout)
            report["checks"][cap] = {
                "status": "passed",
                "inputBytes": source.stat().st_size,
                "uploadSeconds": round(submitted - start, 3),
                "queueAndComputeSeconds": round(time.monotonic() - submitted, 3),
                "model": result["model"],
            }
            if "modelSha256" in result:
                report["checks"][cap]["modelSha256"] = result["modelSha256"]
            return result

        result = task("image.fingerprint", png)
        checked(len(result["hash"]) == 16, "INVALID_FINGERPRINT")
        if args.heic_image:
            fingerprint = next(
                item
                for item in info["capabilities"]
                if item["id"] == "image.fingerprint"
            )
            checked("heic" in fingerprint["formats"], "HEIF_DECODER_REQUIRED")
            detected = task("image.fingerprint", args.heic_image)
            result_receipt = own.call("GET", last_path + "/result")
            with args.heic_image.open("rb") as file:
                source_sha = hashlib.file_digest(file, "sha256").hexdigest()
            checked(
                source_sha == result_receipt["inputSha256"] and detected["width"] > 0,
                "HEIF_SOURCE_MISMATCH",
            )
            report["checks"]["heic"] = {
                "status": "passed",
                "inputSha256": source_sha,
                "width": detected["width"],
                "height": detected["height"],
                "libheif": fingerprint["heif"]["libheif"],
            }
        if available["image.ocr"]:
            result = task(
                "image.ocr", (args.ocr_image or args.image) if args.expect_ocr else png
            )
            expected = args.expect_ocr or "12345"
            checked(
                normalize(expected) in normalize(result["text"]),
                "OCR_REFERENCE_MISSING",
            )
            checked(
                result["words"]
                and all(
                    0 <= w["box"][0] <= w["box"][0] + w["box"][2] <= result["width"]
                    and 0
                    <= w["box"][1]
                    <= w["box"][1] + w["box"][3]
                    <= result["height"]
                    for w in result["words"]
                ),
                "OCR_BOUNDS_INVALID",
            )
        else:
            raise Failure("OCR_ENGINE_REQUIRED")
        if args.audio:
            checked(available["audio.transcribe"], "ASR_MODEL_REQUIRED")
            result = task("audio.transcribe", args.audio)
            checked(
                normalize(args.expect_text) in normalize(result["text"]),
                "ASR_REFERENCE_MISSING",
            )
            found = [s for s in result["segments"] if s["text"]]
            checked(
                found and all(0 <= s["startMs"] < s["endMs"] for s in found),
                "ASR_TIMESTAMPS_INVALID",
            )
            checked(
                len({s["id"] for s in found}) == len(found), "ASR_SEGMENT_ID_INVALID"
            )
            report["checks"]["audio.transcribe"]["segmentCount"] = len(found)
        else:
            report["checks"]["audio.transcribe"] = {
                "status": "unverified",
                "reason": "reference audio not supplied",
            }

        if available["image.match"]:
            fixture = args.heic_image or args.image or png
            query = args.query or "有文字的图片"
            negative = args.negative_query or "户外的雪山"
            result = task("image.embedding", fixture)
            checked(
                abs(sum(v * v for v in result["vector"]) - 1) < 0.01,
                "VECTOR_NOT_NORMALIZED",
            )
            labels = task("image.labels", fixture, {"labels": [query, negative]})[
                "labels"
            ]
            checked(
                len(labels) == 2 and abs(sum(x["score"] for x in labels) - 1) < 0.001,
                "INVALID_LABEL_SCORES",
            )
            pos = task("image.match", fixture, {"query": query})["score"]
            neg = task("image.match", fixture, {"query": negative})["score"]
            query_path = directory / "reference-query.txt"
            query_path.write_text(query, encoding="utf-8")
            vector = task("text.embedding", query_path)
            checked(
                vector["modelSha256"] == result["modelSha256"], "MODEL_VERSION_MISMATCH"
            )
            similarity = sum(
                x * y for x, y in zip(vector["vector"], result["vector"], strict=True)
            )
            checked(abs(similarity - pos) < 0.001, "QUERY_VECTOR_ALIGNMENT")
            timings = {
                "coldSeconds": report["checks"]["text.embedding"][
                    "queueAndComputeSeconds"
                ]
            }

            def timed_query(file):
                before = time.monotonic()
                path = own.upload(file, "text.embedding", {})
                output = own.wait(path, args.timeout)
                status = own.call("GET", path)
                return time.monotonic() - before, status["cacheHit"], output

            elapsed, hit, repeated = timed_query(query_path)
            checked(hit and repeated == vector, "REPEATED_QUERY_CACHE")
            timings.update(
                repeatedEndToEndSeconds=round(elapsed, 3), repeatedCacheHit=hit
            )
            query_path.write_text(negative, encoding="utf-8")
            elapsed, hit, different = timed_query(query_path)
            checked(not hit, "DISTINCT_QUERY_FALSE_HIT")
            neg_dot = sum(
                x * y
                for x, y in zip(different["vector"], result["vector"], strict=True)
            )
            checked(abs(neg_dot - neg) < 0.001, "WARM_VECTOR_ALIGNMENT")
            timings.update(
                distinctEndToEndSeconds=round(elapsed, 3), distinctCacheHit=hit
            )
            report["checks"]["queryLatency"] = timings
            report["checks"]["image.match"].update(
                positiveScore=pos,
                negativeScore=neg,
                cosFromSeparateEmbeddings=similarity,
            )
            if args.query and args.negative_query:
                checked(pos > neg, "VISION_REFERENCE_ORDER")
            else:
                report["checks"]["image.match"]["semanticQuality"] = (
                    "untested without annotated reference pair"
                )
        elif args.require_vision:
            raise Failure("VISION_MODEL_REQUIRED")
        else:
            report["checks"]["image.match"] = {
                "status": "unverified",
                "reason": "model unavailable",
            }

        delegated = own.call(
            "POST",
            "/delegations",
            obj={"capabilities": ["image.fingerprint"], "ttlSeconds": 120},
        )
        internal = Client(origin, None, delegated["token"])
        context = internal.call("GET", "/context")
        checked(
            context["userId"] == "fixture-account"
            and context["boxId"] == "fixture-box"
            and context["spaceId"] == "personal"
            and context["instance"] == "homeai",
            "DELEGATION_CONTEXT",
        )
        internal.call(
            "POST",
            "/jobs",
            obj={
                "requestId": "denied-audio",
                "capability": "audio.transcribe",
                "size": 1,
                "sha256": "0" * 64,
            },
            expected=403,
        )
        cold = internal.upload(png, "image.fingerprint", {})
        own.call("GET", cold, expected=404)
        checked(
            internal.wait(cold, args.timeout)["model"] == "dhash64-v1",
            "WORKER_RESULT_INVALID",
        )
        other.call("DELETE", "/delegations/" + delegated["id"], expected=404)
        report["checks"]["idempotenceAndIsolation"] = {
            "status": "passed",
            "instances": 2,
        }
        checked(
            own.call("DELETE", "/grant/self") == {"revoked": True},
            "SELF_REVOCATION_FAILED",
        )
        own.call("GET", last_path + "/result", expected=403)
        internal.call("GET", "/context", expected=403)
        internal.call("GET", cold + "/result", expected=403)
        report["checks"]["backgroundDelegation"] = {
            "status": "passed",
            "audioWithoutOptIn": "denied",
            "interactiveReadOfWorkerJob": "denied",
            "parentRevocation": "enforced",
        }
        report["checks"]["revocation"] = {"status": "passed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--expect-text")
    parser.add_argument("--image", type=Path)
    parser.add_argument(
        "--heic-image",
        type=Path,
        help="HEIC original used for fingerprint and vision checks",
    )
    parser.add_argument("--expect-ocr")
    parser.add_argument(
        "--ocr-image",
        type=Path,
        help="separate OCR fixture for an annotated image-match test",
    )
    parser.add_argument("--query")
    parser.add_argument("--negative-query")
    parser.add_argument("--require-vision", action="store_true")
    parser.add_argument(
        "--timeout", type=int, default=3600, help="Per-job timeout in seconds"
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if bool(args.audio) != bool(args.expect_text):
        parser.error("--audio and --expect-text must be supplied together")
    if args.expect_ocr and not (args.image or args.ocr_image):
        parser.error("--expect-ocr requires --ocr-image or --image")
    if args.timeout <= 0:
        parser.error("timeout must be positive")
    os.umask(0o077)
    report = {
        "status": "failed",
        "transport": "HTTP loopback, temporary Bridge-compatible Ed25519 signer",
        "productionRegistryTested": False,
        "platform": platform.system(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "checks": {},
    }
    start = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="wanx-media-accept-") as directory:
            suite(args, report, Path(directory))
        report["status"] = "passed"
    except Failure as exc:
        report["failure"] = str(exc)
    except Exception as exc:
        report["failure"] = type(exc).__name__
    finally:
        report["elapsedSeconds"] = round(time.monotonic() - start, 3)
        rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        report["maxChildRssMiB"] = round(
            rss / (1024**2 if sys.platform == "darwin" else 1024), 1
        )
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return int(report["status"] != "passed")


if __name__ == "__main__":
    sys.exit(main())
