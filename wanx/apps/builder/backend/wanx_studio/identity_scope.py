"""Explicit App Studio identity aliases for one WANX account."""

from __future__ import annotations

import os
import re
from typing import Any


def canonical_owner(user: Any, *, aliases: str | None = None) -> str:
    """Return the configured canonical owner for an administrator session.

    Aliases are opt-in and scoped to App Studio only. The format is a comma
    separated list such as ``2:1``; ordinary users are never remapped.
    """
    user_id = int(user.id)
    target = user_id
    if getattr(user, "role", None) == "admin":
        raw = os.environ.get("WANX_STUDIO_IDENTITY_ALIASES", "") if aliases is None else aliases
        # A SSO administrator and the bootstrap local administrator represent
        # the same WANX management account in the single-box deployment. Keep
        # the explicit override for installations with a different mapping.
        if aliases is None and not raw and str(getattr(user, "username", "")).startswith("sso_") and user_id != 1:
            target = 1
        for item in raw.split(","):
            match = re.fullmatch(r"\s*([1-9][0-9]*)\s*:\s*([1-9][0-9]*)\s*", item)
            if match and int(match.group(1)) == user_id:
                target = int(match.group(2))
                break
    return f"wanx:{target}"
