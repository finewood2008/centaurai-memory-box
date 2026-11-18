"""Initialize a device-scoped SSO deployment target without overwriting operator policy."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import tempfile


def ensure_target(root: Path, *, local_required: bool = False) -> bool:
    if local_required or os.environ.get("OCTOP_LOCAL_DATA_MODE") == "required":
        return False
    if os.environ.get("WANX_PLATFORM_SSO_ENABLED") != "1":
        return False
    target = root / "deployment-expert-target.json"
    if target.exists() or target.is_symlink():
        return False
    box_id = os.environ.get("WANX_PLATFORM_DEVICE_ID", "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", box_id):
        raise ValueError("BUILDER_DEPLOYMENT_DEVICE_ID_REQUIRED")
    root.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".deployment-target-", dir=root)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(
                {
                    "schemaVersion": 1,
                    "enabled": True,
                    "profile": "wanx-expert-app-v1",
                    "boxId": box_id,
                    "authorityMode": "sso",
                },
                stream,
            )
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(name, target)
        except FileExistsError:
            return False
        return True
    finally:
        Path(name).unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--local-required", action="store_true")
    args = parser.parse_args()
    ensure_target(args.root, local_required=args.local_required)
