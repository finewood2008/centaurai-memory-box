"""One durable source owns a canonical deployment slot across editor stores.

This is source routing, not an expiring runtime lease. A failed preparation does
not permit another editor to create a second generation counter for that slot.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import threading

from ..contracts import StudioError
from .contracts import canonicalize_json


SOURCES=frozenset({'studio','workshop'})
_ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
_KINDS={'binding','expert-binding','preparation','expert-preparation'}


def _invalid():
    raise StudioError('DEPLOYMENT_SOURCE_REGISTRY_INVALID',409)


def _protected(path, *, directory=False):
    info=path.lstat()
    expected=stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or (not directory and info.st_nlink!=1) or info.st_uid not in {0,os.geteuid()} or info.st_mode&0o022:
        _invalid()


class SourceRegistry:
    def __init__(self,root):
        self.root=Path(root)
        self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
        _protected(self.root,directory=True)
        self.root=self.root.resolve(strict=True)
        path=self.root/'.wanx-deployment-sources.sqlite'
        try:
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        except FileExistsError:pass
        else:os.close(fd)
        _protected(path)
        self.lock=threading.RLock();self.closed=False
        self.db=sqlite3.connect(path,check_same_thread=False,isolation_level=None,timeout=5)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS deployment_sources(slot TEXT PRIMARY KEY,owner TEXT NOT NULL,target TEXT NOT NULL,source TEXT NOT NULL)')

    @staticmethod
    def _identity(source,owner,target):
        if not isinstance(source,str) or source not in SOURCES or not isinstance(owner,str) or not 1<=len(owner)<=256 or '\0' in owner:
            _invalid()
        if not isinstance(target,dict) or set(target)!={'organizationId','boxId','applicationId','environment'} or target.get('environment') not in {'dev','prod'}:
            _invalid()
        if any(not isinstance(v,str) or not _ID.fullmatch(v) for v in target.values()):_invalid()
        try:
            encoded=canonicalize_json(target)
            slot='ai.wanx.selfmade.'+hashlib.sha256(canonicalize_json([owner,target]).encode()).hexdigest()[:32]
        except (ValueError,TypeError,UnicodeError):_invalid()
        return slot,encoded

    def _existing(self,slot,owner,target):
        row=self.db.execute('SELECT owner,target,source FROM deployment_sources WHERE slot=?',(slot,)).fetchone()
        if row and (row[0]!=owner or row[1]!=target):_invalid()
        return row[2] if row else None

    def claim(self,source,owner,target):
        slot,encoded=self._identity(source,owner,target)
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                old=self._existing(slot,owner,encoded)
                if old is not None and old!=source:
                    raise StudioError('DEPLOYMENT_SOURCE_CONFLICT',409)
                self.db.execute('INSERT OR IGNORE INTO deployment_sources VALUES(?,?,?,?)',(slot,owner,encoded,source))
                self.db.commit()
            except BaseException:
                self.db.rollback();raise

    def assert_source(self,source,owner,target, *, allow_unclaimed=False):
        slot,encoded=self._identity(source,owner,target)
        with self.lock:
            old=self._existing(slot,owner,encoded)
            if old!=source and not (old is None and allow_unclaimed):
                raise StudioError('DEPLOYMENT_SOURCE_CONFLICT',409)

    def seed_existing(self):
        # Collect and close source readers before taking the registry lock. No
        # registry writer ever acquires an editor Store lock in reverse order.
        claims=[]
        for source,folder in (('studio','.wanx-app-studio'),('workshop','.wanx-workshop')):
            parent=self.root/folder
            if parent.is_symlink():_invalid()
            if not parent.exists():continue
            _protected(parent,directory=True)
            path=parent/'studio.sqlite'
            if path.is_symlink():_invalid()
            if not path.exists():continue
            _protected(path)
            db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=5)
            try:
                if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deployment_profile_objects'").fetchone():continue
                kinds=sorted(_KINDS)
                query='SELECT kind,body FROM deployment_profile_objects WHERE kind IN ('+','.join('?' for _ in kinds)+')'
                for kind,body in db.execute(query,kinds):
                    value=json.loads(body)
                    if not isinstance(value,dict):_invalid()
                    request=value.get('request')
                    target=value.get('target') if kind.endswith('binding') else request.get('target') if isinstance(request,dict) else None
                    slot,encoded=self._identity(source,value.get('owner'),target)
                    claims.append((slot,value['owner'],encoded,source))
            finally:db.close()
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                for slot,owner,target,source in claims:
                    old=self._existing(slot,owner,target)
                    if old is None:
                        self.db.execute('INSERT INTO deployment_sources VALUES(?,?,?,?)',(slot,owner,target,source))
                    elif old!=source:
                        # Never choose between two legacy writers by mount order.
                        self.db.execute("UPDATE deployment_sources SET source='conflict' WHERE slot=?",(slot,))
                self.db.commit()
            except BaseException:
                self.db.rollback();raise

    def close(self):
        with self.lock:
            if not self.closed:self.db.close();self.closed=True


def for_server(server,root):
    registry=getattr(server,'_wanx_deployment_source_registry',None)
    if registry is not None and not registry.closed:return registry
    registry=SourceRegistry(root)
    try:registry.seed_existing()
    except BaseException:
        registry.close();raise
    server._wanx_deployment_source_registry=registry
    callback=getattr(server,'add_shutdown_callback',None)
    if callback:
        async def close():registry.close()
        callback(close)
    return registry
