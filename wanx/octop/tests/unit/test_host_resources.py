from pathlib import Path
from types import SimpleNamespace

import pytest

from octop.infra import host_resources as resources


@pytest.fixture
def host_proc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("OCTOP_HOST_PROC", str(tmp_path))
    (tmp_path / "meminfo").write_text("MemTotal: 1000 kB\nMemAvailable: 250 kB\n")
    (tmp_path / "stat").write_text("cpu 100 0 20 800 40 0 0 0 50 0\n")
    monkeypatch.setattr(
        resources.time,
        "sleep",
        lambda _: (tmp_path / "stat").write_text("cpu 130 0 30 860 40 0 0 0 70 0\n"),
    )
    return tmp_path


def test_unconfigured_container_never_samples_its_own_resources(monkeypatch):
    monkeypatch.delenv("OCTOP_HOST_PROC", raising=False)
    monkeypatch.setattr(resources.psutil, "virtual_memory", lambda: pytest.fail("container memory"))
    monkeypatch.setattr(resources.psutil, "cpu_percent", lambda **_: pytest.fail("container CPU"))
    assert resources.host_resources(container=True) == {"cpu": None, "memory": None}


def test_native_sampling_without_host_mount(monkeypatch):
    monkeypatch.delenv("OCTOP_HOST_PROC", raising=False)
    monkeypatch.setattr(
        resources.psutil,
        "virtual_memory",
        lambda: SimpleNamespace(total=1000, available=250, percent=75.0),
    )
    monkeypatch.setattr(resources.psutil, "cpu_percent", lambda **_: 12.5)
    assert resources.host_resources(container=False) == {
        "cpu": {"scope": "host", "percent": 12.5},
        "memory": {"scope": "host", "total": 1000, "used": 750, "percent": 75.0},
    }


@pytest.mark.parametrize(
    "memory",
    [
        "MemTotal: 0 kB\nMemAvailable: 0 kB\n",
        "MemTotal: 10 kB\nMemAvailable: 11 kB\n",
        "MemTotal: 10 kB\nMemAvailable: -1 kB\n",
        "MemTotal: 10 MB\nMemAvailable: 1 kB\n",
        "MemTotal: 10 kB\n",
        "MemTotal: 10 kB\nMemTotal: 20 kB\nMemAvailable: 1 kB\n",
        "x" * 16385,
    ],
)
def test_invalid_memory_does_not_hide_valid_cpu(host_proc, memory):
    (host_proc / "meminfo").write_text(memory)
    result = resources.host_resources(container=True)
    assert result["memory"] is None
    assert result["cpu"] == {"scope": "host", "percent": 40.0}


@pytest.mark.parametrize(
    "after",
    [
        "cpu 100 0 20 800 40 0 0 0\n",  # no elapsed sample
        "cpu 90 0 20 800 40 0 0 0\n",  # reset/regression
        "cpu0 130 0 30 860 40 0 0 0\n",  # not aggregate
        "cpu 130 invalid 30 860 40 0 0 0\n",
        "cpu 130 0 30\n",
    ],
)
def test_invalid_cpu_does_not_hide_valid_memory(host_proc, monkeypatch, after):
    monkeypatch.setattr(resources.time, "sleep", lambda _: (host_proc / "stat").write_text(after))
    result = resources.host_resources(container=True)
    assert result["cpu"] is None
    assert result["memory"]["percent"] == 75.0


def test_zero_usage_is_a_valid_measurement(host_proc, monkeypatch):
    (host_proc / "meminfo").write_text("MemTotal: 1000 kB\nMemAvailable: 1000 kB\n")
    monkeypatch.setattr(
        resources.time,
        "sleep",
        lambda _: (host_proc / "stat").write_text("cpu 100 0 20 900 40 0 0 0 50 0\n"),
    )
    result = resources.host_resources(container=True)
    assert result["cpu"]["percent"] == 0.0
    assert result["memory"]["used"] == 0
    assert result["memory"]["percent"] == 0.0


def test_missing_mount_is_not_zero_or_native_fallback(host_proc):
    (host_proc / "stat").unlink()
    (host_proc / "meminfo").unlink()
    assert resources.host_resources(container=True) == {"cpu": None, "memory": None}


def test_relative_host_source_is_rejected(monkeypatch):
    monkeypatch.setenv("OCTOP_HOST_PROC", "proc")
    assert resources.host_resources(container=True) == {"cpu": None, "memory": None}
