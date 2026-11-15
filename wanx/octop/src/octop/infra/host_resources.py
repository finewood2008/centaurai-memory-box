"""Whole-box metrics from native sampling or explicitly mounted host proc files."""

from __future__ import annotations

import contextlib
import os
import time
from pathlib import Path
from typing import Any

import psutil


def _cpu_times(proc: Path) -> tuple[int, ...]:
    with (proc / "stat").open(encoding="ascii") as stream:
        fields = stream.readline(4096).split()
    if not fields or fields[0] != "cpu" or len(fields) < 9:
        raise ValueError("Invalid aggregate CPU counters")
    # guest/guest_nice are already included in user/nice. Count each tick once.
    counters = tuple(int(value) for value in fields[1:9])
    if any(value < 0 for value in counters):
        raise ValueError("Invalid CPU counter")
    return counters


def _memory(proc: Path) -> dict[str, Any]:
    with (proc / "meminfo").open(encoding="ascii") as stream:
        text = stream.read(16385)
    if len(text) > 16384:
        raise ValueError("Invalid memory report")
    values: dict[str, int] = {}
    for line in text.splitlines():
        fields = line.split()
        if fields and fields[0] in {"MemTotal:", "MemAvailable:"}:
            if len(fields) != 3 or fields[2] != "kB" or fields[0] in values:
                raise ValueError("Invalid memory field")
            values[fields[0]] = int(fields[1]) * 1024
    total, available = values["MemTotal:"], values["MemAvailable:"]
    if total <= 0 or not 0 <= available <= total:
        raise ValueError("Invalid memory totals")
    used = total - available
    return {"scope": "host", "total": total, "used": used, "percent": used * 100 / total}


def host_resources(*, container: bool) -> dict[str, Any]:
    """Never label a container's own resource limits as the physical box's usage."""
    result: dict[str, Any] = {"cpu": None, "memory": None}
    configured = os.environ.get("OCTOP_HOST_PROC", "")
    if configured:
        proc = Path(configured)
        if not proc.is_absolute():
            return result
        with contextlib.suppress(OSError, ValueError, KeyError, UnicodeError):
            result["memory"] = _memory(proc)
        with contextlib.suppress(OSError, ValueError, UnicodeError):
            before = _cpu_times(proc)
            time.sleep(0.1)
            after = _cpu_times(proc)
            deltas = tuple(end - start for start, end in zip(before, after, strict=True))
            total = sum(deltas)
            # A reset or an inconsistent sample is unavailable, not zero load.
            if total > 0 and all(value >= 0 for value in deltas):
                idle = deltas[3] + deltas[4]
                result["cpu"] = {"scope": "host", "percent": (total - idle) * 100 / total}
        return result
    if not container:
        with contextlib.suppress(OSError, NotImplementedError, psutil.Error):
            memory = psutil.virtual_memory()
            result["memory"] = {
                "scope": "host",
                "total": memory.total,
                "used": memory.total - memory.available,
                "percent": memory.percent,
            }
        with contextlib.suppress(OSError, NotImplementedError, psutil.Error):
            result["cpu"] = {"scope": "host", "percent": psutil.cpu_percent(interval=0.1)}
    return result
