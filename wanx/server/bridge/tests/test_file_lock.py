"""Real OS locks and Windows entrypoint regression; no live accounts or services."""

import asyncio
import concurrent.futures
import errno
import os
import subprocess
import sys

import pytest
from test_resources import prepare
from test_resources import runtime as runtime
from test_resources import setup as setup

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.file_lock import lock_exclusive, unlock
from wanx_bridge.resource_cache import cache_lock
from wanx_bridge.resource_coordination import ResourceWriteCoordinator, assert_no_legacy_pending


def test_independent_handles_lock_byte_zero_without_changing_file(tmp_path):
    path = tmp_path / "prepare.lock"
    path.write_bytes(b"unchanged")
    first = os.open(path, os.O_RDWR)
    second = os.open(path, os.O_RDWR)
    try:
        os.lseek(first, 3, os.SEEK_SET)
        os.lseek(second, 5, os.SEEK_SET)
        lock_exclusive(first)
        assert os.lseek(first, 0, os.SEEK_CUR) == 3
        with pytest.raises(BlockingIOError):
            lock_exclusive(second)
        assert os.lseek(second, 0, os.SEEK_CUR) == 5
        unlock(first)
        lock_exclusive(second)
        unlock(second)
        assert os.lseek(second, 0, os.SEEK_CUR) == 5
    finally:
        os.close(first)
        os.close(second)
    assert path.read_bytes() == b"unchanged"


def test_invalid_descriptor_is_not_reported_as_contention():
    with pytest.raises(OSError) as failure:
        lock_exclusive(-1)
    assert failure.value.errno == errno.EBADF
    assert not isinstance(failure.value, BlockingIOError)


@pytest.mark.parametrize("kill", [False, True])
def test_other_process_excluded_until_exit_or_termination(tmp_path, kill):
    path = tmp_path / "cache.lock"
    # Child uses the same import path as this test, including staged test runs.
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path))
    script = (
        "import os,sys; from wanx_bridge.file_lock import lock_exclusive; "
        "fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); "
        "lock_exclusive(fd); print('locked',flush=True); sys.stdin.readline()"
    )
    child = subprocess.Popen(
        # Windows venv python.exe is a launcher: killing it can leave its real
        # interpreter alive. Terminate the interpreter that actually owns fd.
        [getattr(sys, "_base_executable", sys.executable), "-c", script, str(path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    fd = None
    try:
        # Use a thread so a broken child cannot hang the test indefinitely.
        with concurrent.futures.ThreadPoolExecutor() as pool:
            ready = pool.submit(child.stdout.readline)
            try:
                assert ready.result(timeout=15).strip() == "locked"
            except BaseException:
                child.kill()
                raise
        fd = os.open(path, os.O_RDWR)
        with pytest.raises(BlockingIOError):
            lock_exclusive(fd)
        if kill:
            child.kill()
        else:
            child.stdin.write("exit\n")
            child.stdin.flush()
        child.wait(timeout=10)
        lock_exclusive(fd)
        unlock(fd)
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=10)
        if fd is not None:
            os.close(fd)
    assert path.stat().st_size == 0


async def test_cache_busy_timeout_and_prepare_skip_preserve_owner(tmp_path):
    async with cache_lock(tmp_path, prepare=True) as held:
        assert held
        async with cache_lock(tmp_path, prepare=True) as competing:
            assert competing is False
        async with cache_lock(tmp_path, prepare=True) as competing_again:
            assert competing_again is False
    async with cache_lock(tmp_path, prepare=True) as acquired:
        assert acquired
    async with cache_lock(tmp_path):
        with pytest.raises(BridgeAuthError, match="RESOURCE_CACHE_BUSY"):
            async with cache_lock(tmp_path, timeout=0):
                pytest.fail("competing cache lock entered")


async def test_cache_released_after_exception_and_cancel(tmp_path):
    with pytest.raises(ValueError, match="fixture"):
        async with cache_lock(tmp_path):
            raise ValueError("fixture")
    entered = asyncio.Event()

    async def hold():
        async with cache_lock(tmp_path):
            entered.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(hold())
    try:
        await asyncio.wait_for(entered.wait(), 3)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    async with cache_lock(tmp_path, timeout=0) as acquired:
        assert acquired


async def test_resource_prepare_busy_keeps_owner_lock_and_error(runtime):
    directory = runtime[0].catalog.directory
    async with cache_lock(directory, prepare=True):
        result = await prepare(runtime)
        assert result["status"] == "blocked"
        assert result["code"] == "RESOURCE_PREPARATION_BUSY"
        async with cache_lock(directory, prepare=True) as competing:
            assert competing is False
    async with cache_lock(directory, prepare=True) as acquired:
        assert acquired


async def test_unlock_error_still_closes_descriptor(tmp_path, monkeypatch):
    from wanx_bridge import resource_cache

    observed = []

    def broken_unlock(fd):
        observed.append(fd)
        raise OSError("fixture unlock failure")

    monkeypatch.setattr(resource_cache, "unlock", broken_unlock)
    with pytest.raises(OSError, match="fixture unlock failure"):
        async with cache_lock(tmp_path):
            pass
    with pytest.raises(OSError) as failure:
        os.fstat(observed[0])
    assert failure.value.errno == errno.EBADF


@pytest.mark.skipif(os.name == "posix", reason="Windows must not bypass POSIX OTA fencing")
def test_posix_coordination_fails_closed_on_windows(tmp_path):
    coordinator = ResourceWriteCoordinator(
        tmp_path,
        device_id="test",
        ownership_epoch=1,
        operation_id="test",
        scope_digest="a" * 64,
    )
    with pytest.raises(BridgeAuthError, match="RESOURCE_COORDINATION_INVALID"):
        coordinator.begin()
    with pytest.raises(BridgeAuthError, match="RESOURCE_LOCAL_STATE_INVALID"):
        assert_no_legacy_pending(tmp_path)
    assert not list(tmp_path.iterdir())


def test_entrypoint_reaches_auth_validation_without_fcntl_failure():
    env = dict(os.environ, WANX_PLATFORM_SSO_ENABLED="0", PYTHONPATH=os.pathsep.join(sys.path))
    result = subprocess.run(
        [sys.executable, "-m", "wanx_bridge"],
        env=env,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 1
    assert result.stderr.strip() == "BOX_PLATFORM_DISABLED"
