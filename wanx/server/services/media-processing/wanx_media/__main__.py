import argparse
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
import uvicorn

from .app import create_app
from .media import CAPABILITIES
from .store import Problem, Store
from .streaming import CAPABILITY as STREAMING_CAPABILITY, MAX_FRAME


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(
        description="Local WANX media service and trusted grant administration"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("serve", "grant", "retain-recording-grant", "enable-recording-summary", "revoke"):
        sub = commands.add_parser(command)
        sub.add_argument("--data-dir", type=Path, required=True)
        if command == "serve":
            sub.add_argument(
                "--public-key",
                type=Path,
                required=True,
                help="Trusted raw 32-byte Bridge Ed25519 verification key",
            )
            sub.add_argument("--port", type=int, default=19094)
        if command in {"grant", "retain-recording-grant", "enable-recording-summary"}:
            for field in ("box", "user", "space", "instance"):
                sub.add_argument("--" + field, required=True)
        if command == "grant":
            sub.add_argument(
                "--allow", action="append", choices=(*CAPABILITIES, STREAMING_CAPABILITY), required=True
            )
            sub.add_argument("--ttl-seconds", type=int, default=86400)
            sub.add_argument(
                "--output",
                type=Path,
                required=True,
                help="New private file for the authorized instance",
            )
        if command in {"retain-recording-grant", "enable-recording-summary", "revoke"}:
            sub.add_argument("--id", required=True)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if args.command == "serve":
        key = Ed25519PublicKey.from_public_bytes(args.public_key.read_bytes())
        uvicorn.run(
            create_app(directory, key),
            host="127.0.0.1",
            port=args.port,
            access_log=False,
            ws_max_size=MAX_FRAME,
            ws_max_queue=4,
            ws_per_message_deflate=False,
        )
        return
    store = Store(directory)
    if args.command == "revoke":
        store.revoke(args.id)
    elif args.command in {"retain-recording-grant", "enable-recording-summary"}:
        update = store.enable_recording_summary if args.command == "enable-recording-summary" else store.retain_recording_grant
        try:
            context = update(args.id, args.box, args.user, args.space, args.instance)
        except Problem as exc:
            parser.error(exc.code)
        print(json.dumps(context))
    else:
        if not 0 < args.ttl_seconds <= 30 * 86400:
            parser.error("grant lifetime must be in (0,30 days]")
        with args.output.open("x", encoding="utf-8") as out:
            grant_id, secret = store.grant(
                args.box,
                args.user,
                args.space,
                args.instance,
                args.allow,
                args.ttl_seconds,
            )
            json.dump(
                {"grantId": grant_id, "instance": args.instance, "grant": secret}, out
            )


if __name__ == "__main__":
    main()
