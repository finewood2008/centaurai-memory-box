"""Nonblocking process locks for dedicated Bridge lock files.

All users of a Windows lock file lock byte zero, including empty files. The
descriptor must stay open until release; these files must never be unlinked
while in use. POSIX retains flock interoperability with existing processes.
"""

from __future__ import annotations

import errno
import os

if os.name == "nt":
    import msvcrt
else:
    import fcntl


def lock_exclusive(fd: int) -> None:
    """Acquire immediately, raising BlockingIOError only for lock contention."""
    if fd < 0:
        # Python's POSIX wrapper may reject -1 with ValueError before reaching
        # flock. Keep the descriptor error contract identical on both platforms.
        raise OSError(errno.EBADF, "Bad file descriptor")
    if os.name != "nt":
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return
    position = os.lseek(fd, 0, os.SEEK_CUR)
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise BlockingIOError(errno.EAGAIN, "Bridge lock is busy") from exc
            raise
    finally:
        os.lseek(fd, position, os.SEEK_SET)


def unlock(fd: int) -> None:
    """Release a lock acquired by this descriptor; never call on a failed acquire."""
    if os.name != "nt":
        fcntl.flock(fd, fcntl.LOCK_UN)
        return
    position = os.lseek(fd, 0, os.SEEK_CUR)
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        os.lseek(fd, position, os.SEEK_SET)
