import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

spec = importlib.util.spec_from_file_location("provision_huohua", Path(__file__).resolve().parents[2] / "tools/provision-huohua-bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

@pytest.fixture
def fixture(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "ROOT_UID", os.getuid())
    monkeypatch.setattr(module, "BRIDGE_UID", os.getuid())
    monkeypatch.setattr(module, "ROOT_GID", os.getgid())
    monkeypatch.setattr(module, "BRIDGE_GID", os.getgid())
    monkeypatch.setattr(module.pwd, "getpwnam", lambda _: SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()))
    public = Ed25519PrivateKey.generate().public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    return tmp_path, public


def test_bootstrap_is_idempotent_and_preserves_installation_key(fixture):
    root, public = fixture
    module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    private = root / "etc/centuaros/huohua/service-private.pem"
    original = private.read_bytes()
    module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    assert private.read_bytes() == original
    assert private.stat().st_mode & 0o777 == 0o640
    registry = json.loads((root / "etc/centuaros/huohua-bridge/service-registry.json").read_bytes())
    record = registry["services"]["huohua.workbench"]
    assert record["activation"]["mode"] == "ota"
    assert record["upstream"] == "http://127.0.0.1:8093"
    assert b"PRIVATE KEY" not in (root / "etc/centuaros/huohua.env").read_bytes()


def test_bootstrap_refuses_changed_identity_and_symlink(fixture):
    root, public = fixture
    module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    with pytest.raises(ValueError, match="EXISTING_CONFIGURATION_DIFFERS"):
        module.provision(root, box_id="box-2", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    private = root / "etc/centuaros/huohua/service-private.pem"
    private.unlink()
    private.symlink_to(root / "outside")
    with pytest.raises(ValueError):
        module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)


def test_bootstrap_rejects_remote_bridge_and_invalid_box_before_writes(fixture):
    root, public = fixture
    with pytest.raises(ValueError):
        module.provision(root, box_id="box-1", bridge_url="https://external.example", bridge_public=public)
    assert not (root / "etc").exists()


def test_generated_registry_is_accepted_by_bridge_and_keys_match(fixture, monkeypatch):
    root, public = fixture
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "server/bridge"))
    from wanx_bridge.__main__ import RuntimeConfig
    from wanx_bridge.service_registry import SERVICE_REGISTRY_ENV, ServiceRegistry
    module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    # OS bridge_container_arguments mounts this directory at the same absolute
    # path and selects this exact filename through the Bridge runtime environment.
    deployed_path = Path("/etc/centuaros/huohua-bridge/service-registry.json")
    projected_path = root / deployed_path.relative_to("/")
    monkeypatch.setenv(SERVICE_REGISTRY_ENV, str(projected_path))
    runtime = RuntimeConfig.from_env()
    assert runtime.service_registry_file == projected_path
    registry = ServiceRegistry.load(runtime.service_registry_file)
    assert not (projected_path.parent / "services.json").exists()
    assert registry.get("huohua.workbench").activation_file == Path(module.ACTIVATION)
    private = serialization.load_pem_private_key((root / "etc/centuaros/huohua/service-private.pem").read_bytes(), password=None)
    assert private.public_key().public_bytes_raw() == (root / "etc/centuaros/huohua-bridge/service.pub").read_bytes()
    assert (root / "etc/centuaros/huohua/bridge-public.key").read_bytes() == public


def test_create_only_publication_never_replaces_concurrent_identity(fixture):
    root, _ = fixture
    private = root / "private.pem"
    private.write_bytes(b"previous installation")
    with pytest.raises(FileExistsError):
        module._write(private, b"new identity", os.getuid(), os.getgid(), 0o600)
    assert private.read_bytes() == b"previous installation"


@pytest.mark.parametrize("component", ["etc", "etc/centuaros", "etc/centuaros/huohua"])
def test_bootstrap_rejects_symlink_in_every_directory_component(fixture, component):
    root, public = fixture
    directory = root / component
    directory.parent.mkdir(parents=True, exist_ok=True)
    outside = root / "outside"
    outside.mkdir()
    directory.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="UNSAFE_DIRECTORY"):
        module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    assert not list(outside.iterdir())


def test_changed_configuration_and_partial_failure_preserve_private_key(fixture, monkeypatch):
    root, public = fixture
    write = module._write
    calls = 0
    def interrupted(*args):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated interruption")
        return write(*args)
    monkeypatch.setattr(module, "_write", interrupted)
    with pytest.raises(OSError):
        module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    private = root / "etc/centuaros/huohua/service-private.pem"
    original = private.read_bytes()
    monkeypatch.setattr(module, "_write", write)
    module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    with pytest.raises(ValueError, match="EXISTING_CONFIGURATION_DIFFERS"):
        module.provision(root, box_id="box-2", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    assert private.read_bytes() == original


def test_bootstrap_rejects_hardlinked_private_key(fixture):
    root, public = fixture
    module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    private = root / "etc/centuaros/huohua/service-private.pem"
    os.link(private, root / "private-alias")
    with pytest.raises(ValueError, match="UNSAFE_FILE"):
        module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)


@pytest.mark.parametrize("component", ["etc", "etc/centuaros", "etc/centuaros/huohua", "etc/centuaros/huohua-bridge"])
def test_bootstrap_rejects_nontraversable_existing_directory(fixture, component):
    root, public = fixture
    directory = root / component
    directory.mkdir(parents=True)
    directory.chmod(0o700)
    with pytest.raises(ValueError, match="UNSAFE_DIRECTORY"):
        module.provision(root, box_id="box-1", bridge_url="http://127.0.0.1:8088", bridge_public=public)
    assert directory.stat().st_mode & 0o777 == 0o700
    assert not (root / "etc/centuaros/huohua/service-private.pem").exists()


def test_bootstrap_accepts_only_kernel_assigned_local_ipv4(fixture, monkeypatch):
    root, public = fixture
    monkeypatch.setattr(module, "_local_ipv4_addresses", lambda: {"127.0.0.1", "100.120.69.169"})
    module.provision(root, box_id="box-1", bridge_url="http://100.120.69.169:8088", bridge_public=public)
    environment = (root / "etc/centuaros/huohua.env").read_text()
    assert 'WANX_BRIDGE_URL="http://100.120.69.169:8088"' in environment


@pytest.mark.parametrize("url", [
    "http://100.120.69.170:8088", "http://example.com:8088", "http://0.0.0.0:8088",
    "http://224.0.0.1:8088", "http://127.1:8088", "http://127.0.0.1:0",
    "http://user@100.120.69.169:8088", "http://100.120.69.169:8088/",
    "http://100.120.69.169:8088?", "http://100.120.69.169:8088\n",
])
def test_bootstrap_refuses_unassigned_or_ambiguous_address_before_writes(fixture, monkeypatch, url):
    root, public = fixture
    monkeypatch.setattr(module, "_local_ipv4_addresses", lambda: {"127.0.0.1", "100.120.69.169", "0.0.0.0", "224.0.0.1"})
    with pytest.raises(ValueError, match="INVALID_BRIDGE_IDENTITY"):
        module.provision(root, box_id="box-1", bridge_url=url, bridge_public=public)
    assert not (root / "etc").exists()


def test_local_address_evidence_uses_fixed_trusted_tool_and_up_interfaces(fixture, monkeypatch):
    root, _ = fixture
    command = root / "ip"
    command.write_text("test tool placeholder")
    command.chmod(0o755)
    monkeypatch.setattr(module, "_IP_COMMANDS", (command,))
    calls = []
    def run(arguments, **options):
        calls.append((arguments, options))
        return SimpleNamespace(stdout=json.dumps([
            {"flags": ["UP"], "addr_info": [{"family": "inet", "local": "100.120.69.169"}, {"family": "inet6", "local": "::1"}]},
            {"flags": [], "addr_info": [{"family": "inet", "local": "100.120.69.170"}]},
        ]))
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module._local_ipv4_addresses() == {"100.120.69.169"}
    assert calls[0][0] == [str(command), "-j", "-4", "address", "show"]
    assert calls[0][1]["timeout"] == 5
    command.chmod(0o777)
    with pytest.raises(ValueError, match="LOCAL_INTERFACE_EVIDENCE_REQUIRED"):
        module._local_ipv4_addresses()
    assert len(calls) == 1


def test_nonloopback_provision_fails_closed_without_local_evidence(fixture, monkeypatch):
    root, public = fixture
    monkeypatch.setattr(module, "_IP_COMMANDS", (root / "missing-ip",))
    with pytest.raises(ValueError, match="LOCAL_INTERFACE_EVIDENCE_REQUIRED"):
        module.provision(root, box_id="box-1", bridge_url="http://100.120.69.169:8088", bridge_public=public)
    assert not (root / "etc").exists()
