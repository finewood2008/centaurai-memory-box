import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.deployment.source_registry import SourceRegistry


OWNER='wanx:7'
TARGET={'organizationId':'personal-owner','boxId':'synthetic-box','applicationId':'demo.expert.application','environment':'dev'}


def test_source_claim_is_permanent_owner_target_scoped_and_survives_restart(tmp_path):
    registry=SourceRegistry(tmp_path)
    registry.claim('workshop',OWNER,TARGET)
    registry.claim('workshop',OWNER,dict(reversed(list(TARGET.items()))))
    registry.close()
    registry=SourceRegistry(tmp_path)
    try:
        registry.assert_source('workshop',OWNER,TARGET)
        with pytest.raises(StudioError,match='DEPLOYMENT_SOURCE_CONFLICT'):
            registry.claim('studio',OWNER,TARGET)
        registry.claim('studio','wanx:8',TARGET)
        registry.claim('studio',OWNER,{**TARGET,'environment':'prod'})
    finally:registry.close()


def test_two_connections_cannot_admit_different_sources_for_one_slot(tmp_path):
    a,b=SourceRegistry(tmp_path),SourceRegistry(tmp_path)
    barrier=Barrier(2)
    def claim(registry,source):
        barrier.wait()
        try:registry.claim(source,OWNER,TARGET);return source
        except StudioError as error:return error.code
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            x=pool.submit(claim,a,'studio');y=pool.submit(claim,b,'workshop')
            results=[x.result(),y.result()]
        assert results.count('DEPLOYMENT_SOURCE_CONFLICT')==1
        assert len(set(results)&{'studio','workshop'})==1
    finally:a.close();b.close()


def legacy(root,kind,body):
    root.mkdir(mode=0o700,parents=True)
    db=sqlite3.connect(root/'studio.sqlite')
    db.execute('CREATE TABLE deployment_profile_objects(kind TEXT,key TEXT,body TEXT,PRIMARY KEY(kind,key))')
    db.execute('INSERT INTO deployment_profile_objects VALUES(?,?,?)',(kind,'legacy',json.dumps(body)))
    db.commit();db.close()


def test_startup_seeds_legacy_workshop_bindings_and_preparations_before_admission(tmp_path):
    legacy(tmp_path/'.wanx-workshop','expert-binding',{'owner':OWNER,'target':TARGET})
    legacy(tmp_path/'.wanx-app-studio','preparation',{'owner':'wanx:8','request':{'target':TARGET}})
    registry=SourceRegistry(tmp_path)
    try:
        registry.seed_existing()
        registry.assert_source('workshop',OWNER,TARGET)
        registry.assert_source('studio','wanx:8',TARGET)
        with pytest.raises(StudioError,match='DEPLOYMENT_SOURCE_CONFLICT'):
            registry.claim('studio',OWNER,TARGET)
    finally:registry.close()


def test_existing_dual_source_conflict_never_depends_on_mount_order(tmp_path):
    legacy(tmp_path/'.wanx-workshop','binding',{'owner':OWNER,'target':TARGET})
    legacy(tmp_path/'.wanx-app-studio','expert-preparation',{'owner':OWNER,'request':{'target':TARGET}})
    registry=SourceRegistry(tmp_path)
    try:
        registry.seed_existing()
        for source in ('studio','workshop'):
            with pytest.raises(StudioError,match='DEPLOYMENT_SOURCE_CONFLICT'):
                registry.assert_source(source,OWNER,TARGET)
        registry.seed_existing()
        with pytest.raises(StudioError,match='DEPLOYMENT_SOURCE_CONFLICT'):
            registry.claim('studio',OWNER,TARGET)
    finally:registry.close()


def test_registry_rejects_source_and_target_spoofing_and_symlink(tmp_path):
    registry=SourceRegistry(tmp_path/'safe')
    try:
        for source in ('caller','',None):
            with pytest.raises(StudioError):registry.claim(source,OWNER,TARGET)
        with pytest.raises(StudioError):registry.claim('studio',OWNER,{**TARGET,'path':'/tmp'})
    finally:registry.close()
    (tmp_path/'alias').symlink_to(tmp_path/'safe',target_is_directory=True)
    with pytest.raises((StudioError,ValueError)):
        SourceRegistry(tmp_path/'alias')
