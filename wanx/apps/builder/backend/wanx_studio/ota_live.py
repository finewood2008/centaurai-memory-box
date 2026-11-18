"""Private, read-only live dependency verification for the local OTA executor.

No HTTP authority, customer session, inference, runtime pin or business operation
is created. The Unix socket is container-local and accessible only to its UID.
"""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
import errno
import asyncio
import json
import os
from pathlib import Path
import stat
import socket
import sys

SOCKET = Path('/tmp/wanx-kaiwu-ota/probe.sock')
MAX_BINDINGS = 256
# Live probes retain binding bodies in the running service. Keep this memory
# allowance independent of the offline inspector's larger disk snapshot budget.
MAX_BODY = 16 * 1024 * 1024
MAX_BINDING_BYTES = 128 * 1024 * 1024


def _result(ready, checked=0, excluded=0):
    return {'schemaVersion': 1, 'protocol': 1, 'runtimeReady': ready,
            'checkedBindings': checked, 'excludedBindings': excluded,
            'code': None if ready else 'KAIWU_RUNTIME_NOT_READY'}


async def inspect_runtime(services):
    checked = excluded = total_bytes = 0
    observed, stores = [], []
    try:
        for service in services:
            if service is None or service.closing or service.deployments._closed:
                return _result(False, checked, excluded)
            # This is the running service's connection, not a constructor that
            # could migrate state or mark work interrupted.
            service.store.db.execute('SELECT 1').fetchone()
            rows = service.store.db.execute(
                "SELECT kind,key,body FROM deployment_profile_objects WHERE kind IN ('binding','expert-binding') LIMIT ?", (MAX_BINDINGS + 1,))
            row_count = 0
            for kind, key, body in rows:
                row_count += 1
                body_bytes = len(body.encode('utf-8'))
                total_bytes += body_bytes
                if checked + excluded >= MAX_BINDINGS or body_bytes > MAX_BODY or total_bytes > MAX_BINDING_BYTES:
                    return _result(False, checked, excluded)
                binding = json.loads(body)
                if binding.get('state') != 'active':
                    observed.append((service, kind, key, body, None, None))
                    excluded += 1
                    continue
                profile = service.deployment_profile
                profile = getattr(profile, 'expert' if kind == 'expert-binding' else 'miniapp', profile)
                if not profile.available:
                    return _result(False, checked, excluded)
                environment = service.deployments.journal.get_environment(binding['target'])
                before_environment = json.dumps(environment, sort_keys=True, allow_nan=False)
                if environment.get('activeOperationId'):
                    # A live deployment is checked by its own candidate contract;
                    # do not compare its intermediate binding with the old slot.
                    observed.append((service, kind, key, body, binding['target'], before_environment))
                    excluded += 1
                    continue
                if environment.get('health') != 'healthy' or environment.get('generation') != binding['generation']:
                    return _result(False, checked, excluded)
                if kind == 'expert-binding':
                    runtime = service.expert_runtime
                    if runtime is None or runtime.closed:
                        return _result(False, checked, excluded)
                    expert = binding['expertBinding']
                    if expert.get('target') != binding['target'] or expert.get('owner') != binding['owner']:
                        return _result(False, checked, excluded)
                    if expert.get('slotApplicationId') != binding.get('slotApplicationId'):
                        return _result(False, checked, excluded)
                    await runtime.verify(binding['owner'], expert, lambda: None)
                else:
                    # Miniapps execute the frozen base through this same live
                    # service. Check its installed manifest, not a mutable project.
                    from .contracts import check_manifest
                    check_manifest(binding['manifest'])
                    base = binding.get('base')
                    if not isinstance(base, dict) or base.get('artifactHash') != binding.get('artifactHash') or base.get('manifest') != binding.get('manifest'):
                        return _result(False, checked, excluded)
                observed.append((service, kind, key, body, binding['target'], before_environment))
                checked += 1
            stores.append((service, row_count))
        # Workspace reads await external storage. Recheck every observed slot
        # after ALL awaits: a later slot can change an earlier generation too.
        for service, row_count in stores:
            if service.closing or service.deployments._closed:
                return _result(False, checked, excluded)
            actual = service.store.db.execute(
                "SELECT count(*) FROM deployment_profile_objects WHERE kind IN ('binding','expert-binding')").fetchone()[0]
            if actual != row_count:
                return _result(False, checked, excluded)
        for service, kind, key, body, target, before_environment in observed:
            current = service.store.db.execute(
                "SELECT body FROM deployment_profile_objects WHERE kind=? AND key=?", (kind, key)).fetchone()
            if current is None or current[0] != body:
                return _result(False, checked, excluded)
            if target is not None:
                after_environment = service.deployments.journal.get_environment(target)
                if json.dumps(after_environment, sort_keys=True, allow_nan=False) != before_environment:
                    return _result(False, checked, excluded)
        return _result(True, checked, excluded)
    except Exception:
        return _result(False, checked, excluded)


class ProbeServer:
    def __init__(self, path, inspect):
        self.path, self.inspect = Path(path), inspect
        self.server = None
        self.identity = None
        self.lock = asyncio.Lock()

    async def start(self):
        # Never unlink a pre-existing file/socket. Another active service or a
        # foreign path must not be silently replaced by this health channel.
        parent = self.path.parent
        try:
            parent.mkdir(mode=0o700)
        except FileExistsError:
            pass
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise OSError('Untrusted OTA readiness directory')
        try:
            previous = self.path.lstat()
        except FileNotFoundError:
            previous = None
        if previous is not None:
            if not stat.S_ISSOCK(previous.st_mode) or previous.st_uid != os.geteuid():
                raise OSError('Foreign readiness path')
            # A same-UID socket is removed only after ECONNREFUSED proves no
            # listener. An active listener, timeout or unknown error stays put.
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as prior:
                prior.settimeout(0.2)
                try:
                    prior.connect(str(self.path))
                except OSError as exc:
                    if exc.errno != errno.ECONNREFUSED:
                        raise
                else:
                    raise OSError('Readiness listener already active')
            current = self.path.lstat()
            if (current.st_dev, current.st_ino) != (previous.st_dev, previous.st_ino):
                raise OSError('Readiness path changed')
            self.path.unlink()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.bind(str(self.path))
            os.chmod(self.path, 0o600)
            sock.setblocking(False)
            self.server = await asyncio.start_unix_server(self._handle, sock=sock)
        except BaseException:
            sock.close()
            raise
        info = self.path.lstat()
        self.identity = (info.st_dev, info.st_ino)

    async def _handle(self, reader, writer):
        try:
            async with self.lock:
                report = await asyncio.wait_for(self.inspect(), timeout=60)
            raw = json.dumps(report, separators=(',', ':')).encode() + b'\n'
            if len(raw) > 65536:
                raw = json.dumps(_result(False)).encode() + b'\n'
            writer.write(raw)
            await writer.drain()
        except Exception:
            writer.write(json.dumps(_result(False)).encode() + b'\n')
        finally:
            writer.close()
            await writer.wait_closed()

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        try:
            info = self.path.lstat()
            if stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == self.identity:
                self.path.unlink()
        except FileNotFoundError:
            pass


async def query(path=SOCKET):
    info = Path(path).lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise OSError('Untrusted OTA readiness socket')
    reader, writer = await asyncio.open_unix_connection(str(path), limit=65536)
    try:
        raw = await asyncio.wait_for(reader.readline(), 65)
        if len(raw) > 65536:
            raise ValueError('Oversized readiness report')
        return json.loads(raw)
    finally:
        writer.close(); await writer.wait_closed()


def register(app, server):
    if os.environ.get('WANX_KAIWU_OTA_PROTOCOL') != '1':
        return
    if getattr(server, '_wanx_ota_probe', None) is not None:
        return
    async def inspect():
        return await inspect_runtime([getattr(server, '_wanx_studio_service', None),
                                      getattr(server, '_wanx_workshop_service', None)])
    probe = ProbeServer(SOCKET, inspect)
    server._wanx_ota_probe = probe
    original = app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(application):
        # App factories can run before an event loop exists. Both editor
        # services and the original startup lifecycle finish before binding.
        async with original(application):
            await probe.start()
            try:
                yield
            finally:
                await probe.close()
    app.router.lifespan_context = lifespan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        report = asyncio.run(query())
    except Exception:
        report = _result(False)
    print(json.dumps(report, separators=(',', ':')))
    return 0 if report.get('runtimeReady') is True else 1


if __name__ == '__main__':
    sys.exit(main())
