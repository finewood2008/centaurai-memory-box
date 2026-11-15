from __future__ import annotations

import os
import socket
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from octop.infra import box_resources as resources


def test_usage_counts_components_and_all_data_once_without_following_links(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / "account.db").write_bytes(b"a" * 13)
    components = data / "components"
    components.mkdir()
    (components / "runtime").write_bytes(b"b" * 23)
    os.link(data / "account.db", components / "duplicate")
    outside = tmp_path / "unrelated"
    outside.write_bytes(b"c" * 97)
    (data / "link").symlink_to(outside)
    result = resources.file_usage((data, components, data))
    assert result["bytes"] == 36
    assert result["complete"] is True
    assert result["scope"] == "wanx-managed-files"


def test_registered_external_spaces_for_all_accounts_and_partial_measurement(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    moved = tmp_path / "moved" / ".wanx-space" / "namespace" / "personal"
    moved.mkdir(parents=True)
    (moved / "file").write_bytes(b"x" * 41)
    (moved.parent.parent.parent / "unrelated").write_bytes(b"x" * 101)
    for user in (1, 2):
        index = home / ".wanx-personal-space" / str(user) / "index.sqlite3"
        index.parent.mkdir(parents=True)
        with sqlite3.connect(index) as db:
            db.execute("CREATE TABLE space_storage(directory TEXT)")
            db.execute("CREATE TABLE object_locations(directory TEXT)")
            db.execute("INSERT INTO space_storage VALUES(?)", (str(moved),))
            db.execute("INSERT INTO object_locations VALUES(?)", (str(moved),))
    roots, complete = resources._external_spaces(home)
    assert complete
    assert resources.file_usage(tuple(roots))["bytes"] == 41
    missing = resources.file_usage((moved, tmp_path / "missing"))
    assert missing["bytes"] == 41
    assert missing["complete"] is False


def test_unreadable_directory_is_not_reported_as_complete_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def denied(path: object) -> None:
        raise PermissionError("unavailable")

    monkeypatch.setattr(resources.os, "scandir", denied)
    assert resources.file_usage((tmp_path,))["complete"] is False


def test_cached_usage_expires_and_does_not_expose_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = [65.0]
    monkeypatch.setattr(resources, "component_roots", lambda: ())
    monkeypatch.setattr(resources, "public_address", lambda: {"publicIp": None})
    monkeypatch.setattr(resources.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(
        resources, "network_addresses", lambda _: {"addresses": [], "scope": "host"}
    )
    (tmp_path / "initial").write_bytes(b"x" * 7)
    assert resources.box_resources(tmp_path)["wanxStorage"]["bytes"] == 7
    (tmp_path / "later").write_bytes(b"x" * 11)
    assert resources.box_resources(tmp_path)["wanxStorage"]["bytes"] == 7
    clock[0] += 31
    result = resources.box_resources(tmp_path)
    assert result["wanxStorage"]["bytes"] == 18
    assert str(tmp_path) not in str(result)


def test_box_addresses_are_real_up_interfaces_not_local_proxy_addresses(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(resources, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(resources, "_SYS_CLASS_NET", tmp_path)

    def addr(address: str, family: int = socket.AF_INET) -> SimpleNamespace:
        return SimpleNamespace(address=address, family=family)

    monkeypatch.setattr(
        resources.psutil,
        "net_if_stats",
        lambda: {
            "en0": SimpleNamespace(isup=True),
            "old": SimpleNamespace(isup=False),
        },
    )
    monkeypatch.setattr(
        resources.psutil,
        "net_if_addrs",
        lambda: {
            "lo": [addr("127.0.0.1"), addr("::1", socket.AF_INET6)],
            "en0": [
                addr("192.168.1.25"),
                addr("192.168.1.25"),
                addr("fe80::1%en0", socket.AF_INET6),
                addr("fd00::25", socket.AF_INET6),
            ],
            "old": [addr("10.0.0.99")],
            "proxy": [addr("198.18.0.1")],
        },
    )
    assert resources.network_addresses(False) == {
        "addresses": ["192.168.1.25", "fd00::25"],
        "lanAddresses": [],
        "scope": "host",
    }
    assert resources.network_addresses(True)["scope"] == "container"


@pytest.mark.parametrize("container", [False, True])
def test_lan_addresses_use_physical_interfaces_even_in_host_network_containers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, container: bool
) -> None:
    monkeypatch.setattr(resources, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(resources, "_SYS_CLASS_NET", tmp_path)
    interfaces = {
        "enp1s0": [
            "192.168.1.201",
            "192.168.1.201",
            "fd12::201",
            "8.8.4.4",
            "100.64.1.2",
            "198.18.0.1",
            "169.254.1.1",
            "127.0.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "fe80::1%enp1s0",
            "2001:4860::1",
        ],
        "wlan0": ["10.0.0.5", "172.16.0.3"],
        "disabled": ["192.168.9.9"],
        "docker0": ["172.17.0.1"],
        "br-123": ["172.18.0.1"],
        "veth123": ["10.1.0.1"],
        "wt0": ["100.64.3.4", "10.2.0.1"],
        "tun0": ["10.3.0.1"],
        "tailscale0": ["fd00::1"],
    }
    for name in ("enp1s0", "wlan0", "disabled"):
        (tmp_path / name / "device").mkdir(parents=True)
    monkeypatch.setattr(
        resources.psutil,
        "net_if_stats",
        lambda: {name: SimpleNamespace(isup=name != "disabled") for name in interfaces},
    )
    monkeypatch.setattr(
        resources.psutil,
        "net_if_addrs",
        lambda: {
            name: [
                SimpleNamespace(
                    address=value, family=socket.AF_INET6 if ":" in value else socket.AF_INET
                )
                for value in values
            ]
            for name, values in interfaces.items()
        },
    )
    result = resources.network_addresses(container)
    assert result["lanAddresses"] == ["10.0.0.5", "172.16.0.3", "192.168.1.201", "fd12::201"]
    assert result["scope"] == ("container" if container else "host")
    assert "8.8.4.4" in result["addresses"]  # Existing API semantics stay intact.
    assert "172.17.0.1" in result["addresses"]


def test_bridge_container_interface_does_not_claim_a_host_lan_address(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(resources, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(resources, "_SYS_CLASS_NET", tmp_path)
    (tmp_path / "eth0").mkdir()
    monkeypatch.setattr(
        resources.psutil, "net_if_stats", lambda: {"eth0": SimpleNamespace(isup=True)}
    )
    monkeypatch.setattr(
        resources.psutil,
        "net_if_addrs",
        lambda: {"eth0": [SimpleNamespace(address="172.17.0.2", family=socket.AF_INET)]},
    )
    assert resources.network_addresses(True) == {
        "addresses": ["172.17.0.2"],
        "lanAddresses": [],
        "scope": "container",
    }


@pytest.mark.parametrize("platform", ["darwin", "win32"])
def test_native_lan_addresses_exclude_virtual_interfaces_without_linux_sysfs(
    monkeypatch: pytest.MonkeyPatch, platform: str
) -> None:
    monkeypatch.setattr(resources, "sys", SimpleNamespace(platform=platform))
    interfaces = {
        "en0": "192.168.1.3",
        "Wi-Fi": "10.0.0.3",
        "以太网": "192.168.1.4",
        "以太网 2": "192.168.1.5",
        "无线网络连接": "192.168.1.6",
        "无线网络连接 2": "192.168.1.7",
        "本地连接": "192.168.1.8",
        "WLAN": "192.168.1.9",
        "WLAN 2": "192.168.1.10",
        "utun0": "10.1.0.3",
        "vEthernet (Default Switch)": "172.20.0.1",
        "unknown": "192.168.9.3",
    }
    monkeypatch.setattr(
        resources.psutil,
        "net_if_stats",
        lambda: {name: SimpleNamespace(isup=True) for name in interfaces},
    )
    monkeypatch.setattr(
        resources.psutil,
        "net_if_addrs",
        lambda: {
            name: [SimpleNamespace(address=value, family=socket.AF_INET)]
            for name, value in interfaces.items()
        },
    )
    assert resources.network_addresses(False)["lanAddresses"] == [
        "10.0.0.3",
        "192.168.1.10",
        "192.168.1.3",
        "192.168.1.4",
        "192.168.1.5",
        "192.168.1.6",
        "192.168.1.7",
        "192.168.1.8",
        "192.168.1.9",
    ]
    assert resources.network_addresses(True)["lanAddresses"] == []


def test_lan_addresses_are_empty_when_interfaces_are_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unavailable() -> None:
        raise OSError("interface sampling unavailable")

    monkeypatch.setattr(resources.psutil, "net_if_stats", unavailable)
    assert resources.network_addresses(True) == {
        "addresses": [],
        "lanAddresses": [],
        "scope": "container",
    }


def test_system_python_is_not_counted_as_a_wanx_owned_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(resources.sys, "prefix", str(tmp_path))
    monkeypatch.setattr(resources.sys, "base_prefix", str(tmp_path))
    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.delenv("OCTOP_COMPONENT_ROOTS", raising=False)
    assert tmp_path not in resources.component_roots()
    monkeypatch.setattr(resources.sys, "prefix", str(tmp_path / "venv"))
    assert tmp_path / "venv" in resources.component_roots()


def test_deployment_registers_outside_components_without_scanning_disk_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = tmp_path / "desktop app"
    data = tmp_path / "applications"
    monkeypatch.setenv(
        "OCTOP_COMPONENT_ROOTS",
        os.pathsep.join(
            [
                str(app),
                str(data),
                str(tmp_path.anchor),
                str(tmp_path / ".." / ".." / ".." / ".." / ".." / ".."),
                "relative",
            ]
        ),
    )
    roots = resources.component_roots()
    assert app in roots and data in roots
    assert Path(tmp_path.anchor) not in roots
    assert Path("relative") not in roots


@pytest.mark.parametrize(
    "invalid",
    [
        b"192.168.1.25",
        b"127.0.0.1",
        b"100.64.1.2",
        b"198.18.0.1",
        b"224.0.0.1",
        b"::1",
        b"malformed",
        b"x" * 129,
    ],
)
def test_public_probe_never_accepts_private_or_invalid_addresses(
    invalid: bytes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = httpx.Client
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert "authorization" not in request.headers and "cookie" not in request.headers
        return httpx.Response(200, content=invalid if len(requests) == 1 else b"8.8.4.4\n")

    def client(**kwargs: object) -> httpx.Client:
        assert kwargs == {"timeout": 2.0, "trust_env": False, "follow_redirects": False}
        return original(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(resources.httpx, "Client", client)
    assert resources._fetch_public_ip() == "8.8.4.4"
    assert len(requests) == 2
    assert all(request.url.scheme == "https" for request in requests)


def test_public_probe_outage_returns_unknown_instead_of_interface_ip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = httpx.Client

    def unavailable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("offline", request=request)

    monkeypatch.setattr(
        resources.httpx, "Client", lambda **_: original(transport=httpx.MockTransport(unavailable))
    )
    assert resources._fetch_public_ip() is None


def test_public_address_cache_retries_failures_and_refreshes_successes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [0.0]
    values = iter([None, "8.8.4.4", "1.1.1.1"])
    monkeypatch.setattr(resources, "_PUBLIC_IP_CACHE", None)
    monkeypatch.setattr(resources, "_fetch_public_ip", lambda: next(values))
    monkeypatch.setattr(
        resources, "time", SimpleNamespace(monotonic=lambda: clock[0], time=lambda: clock[0])
    )
    assert resources.public_address()["publicIp"] is None
    clock[0] = 20
    assert resources.public_address()["publicIp"] is None
    clock[0] = 31
    assert resources.public_address()["publicIp"] == "8.8.4.4"
    clock[0] = 60
    assert resources.public_address()["publicIpCollectedAt"] == 31
    clock[0] = 332
    assert resources.public_address()["publicIp"] == "1.1.1.1"
