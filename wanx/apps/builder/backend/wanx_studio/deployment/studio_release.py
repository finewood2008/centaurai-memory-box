"""Deterministic standard-directory producer for genuine adopted Studio bytes."""
from copy import deepcopy
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import time
from uuid import uuid4

from ..contracts import StudioError
from .contracts import canonicalize_json
from .expert_runtime import PROFILE
from .project_expert import ProjectExpert,OPERATION
from .standard_client import CLIENT_FORMAT,RUNTIME_CONTRACT,validate_client,metadata
from ..standard_package import validate_standard_package


def raw(value):return canonicalize_json(value).encode()
def sha(value):return 'sha256:'+hashlib.sha256(raw(value)).hexdigest()


class StudioRelease:
    def __init__(self,svc):
        self.svc=svc;self.projects=ProjectExpert(svc)
        with svc.store.lock:
            svc.store.db.execute('CREATE TABLE IF NOT EXISTS studio_release_exports(owner TEXT, operation_id TEXT, request_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,operation_id))')

    def export(self,owner,pid,body):
        profile=self.projects.profile(owner)
        if not isinstance(body,dict) or set(body)!={'operationId','expectedArtifactHash','expectedVersionRevision'} or not isinstance(body['operationId'],str) or not OPERATION.fullmatch(body['operationId']) or not isinstance(body['expectedArtifactHash'],str) or type(body['expectedVersionRevision']) is not int:
            raise StudioError('STUDIO_RELEASE_REQUEST_INVALID',422)
        request_hash=sha([pid,body])
        with self.svc.store.transaction():
            project=self.svc.store.get(owner,pid)
            artifact,contract,source=self.projects.source(owner,project)
            if source['artifactHash']!=body['expectedArtifactHash'] or source['versionRevision']!=body['expectedVersionRevision']:
                raise StudioError('VERSION_CHANGED',409)
            self.projects.template(profile,contract['template'])
            old=self.svc.store.db.execute('SELECT request_hash,body FROM studio_release_exports WHERE owner=? AND operation_id=?',(owner,body['operationId'])).fetchone()
            if old and old[0]!=request_hash:raise StudioError('STUDIO_RELEASE_OPERATION_CONFLICT',409)
            package_bytes=None
            if artifact.get('devKitPackage'):
                package=artifact['devKitPackage']
                payload={'format':CLIENT_FORMAT,'applicationId':project['appId'],'name':artifact['manifest']['name'],'version':artifact['version'],
                    'artifactHash':artifact['hash'],'manifest':deepcopy(artifact['manifest']),'packageSha256':artifact['packageSha256'],
                    'packageBase64':package['packageBase64'],'runtimeNamespace':'studio','runtimeContract':deepcopy(RUNTIME_CONTRACT)}
                validate_client(payload)
                package_bytes=validate_standard_package(payload['packageBase64'],payload['packageSha256'],payload['manifest'],application_id=project['appId'],version=artifact['version'])
                payload=metadata(payload)
            else:
                raise StudioError('STANDARD_ARTIFACT_REQUIRED',409)
            release_id='kaiwu-'+sha([owner,pid,source['artifactHash'],source['contentHash'],contract])[7:55]
            trace={**source,'projectId':pid}
            if old:
                result=json.loads(old[1])
                if result['source']!=trace:raise StudioError('VERSION_CHANGED',409)
            else:
                result={'schemaVersion':1,'profile':PROFILE,'release':None,'source':trace,'releaseId':release_id}
                self.svc.store.db.execute('INSERT INTO studio_release_exports VALUES(?,?,?,?)',(owner,body['operationId'],request_hash,json.dumps(result,ensure_ascii=False)))
        backend={'schemaVersion':1,'format':'wanx-expert-backend-v1','template':contract['template'],'mode':'ask'}
        if 'expertPrompt' in artifact.get('snapshot', {}):
            backend['prompt'] = artifact['snapshot']['expertPrompt']
        values={'backend/expert.json':backend,'client/payload.json':payload,
            'support/configuration.schema.json':{'type':'object','properties':{},'additionalProperties':False},
            'support/dependencies.lock.json':{'schemaVersion':1,'dependencies':[{'kind':'expert-template',**contract['template']}]},
            'support/verification.json':contract['verification']}
        artifacts=[]
        for index,(path,value) in enumerate(values.items()):
            role='backend' if path.startswith('backend/') else 'client' if path.startswith('client/') else 'support'
            artifacts.append({'artifactId':['expert-backend','expert-client','configuration','dependencies','verification'][index],
                'role':role,'path':path,'mediaType':'application/json','digest':sha(value),'sizeBytes':len(raw(value)),
                'platforms':[{'os':os_name,'arch':arch} for os_name,arch in ([('darwin','arm64'),('darwin','x64'),('win32','x64'),('win32','arm64'),('linux','x64')] if role=='client' else [('linux','x64')])]})
        manifest={'schemaVersion':1,'format':'kaiwu-release-directory-v1','applicationId':payload['applicationId'],'version':payload['version'],'releaseId':release_id,
            'backend':{'kind':'expert','profileRef':{'id':PROFILE,'revision':1},'artifactId':'expert-backend','template':contract['template']},
            'client':{'mode':'install','artifactId':'expert-client'},'artifacts':artifacts,
            'configurationArtifactId':'configuration','dependencyLockArtifactId':'dependencies','verificationArtifactId':'verification',
            'resources':[{'kind':'model','key':'default-model','required':True}],
            'data':{'schemaVersion':'1','upgradePolicy':'compatible','taskPolicy':'none','persistentPaths':[]}}
        if package_bytes is not None:
            manifest['client']['packageArtifactId']='expert-client-package'
            artifacts.append({'artifactId':'expert-client-package','role':'client','path':'client/application.zip','mediaType':'application/zip',
                'digest':'sha256:'+hashlib.sha256(package_bytes).hexdigest(),'sizeBytes':len(package_bytes),
                'platforms':deepcopy(artifacts[1]['platforms'])})
        contents={'release.json':raw(manifest),**{path:raw(value) for path,value in values.items()}}
        if package_bytes is not None:contents['client/application.zip']=package_bytes
        self.publish(profile.intake,owner,release_id,contents)
        frozen=profile.intake.ingest(owner,release_id)
        public={'releaseId':release_id,'applicationId':payload['applicationId'],'name':payload['name'],'version':payload['version'],'directoryDigest':frozen['directoryDigest']}
        result={'schemaVersion':1,'profile':PROFILE,'release':public,'source':trace}
        with self.svc.store.transaction():
            self.projects.profile(owner)
            self.svc.store.db.execute('UPDATE studio_release_exports SET body=? WHERE owner=? AND operation_id=?',(json.dumps(result,ensure_ascii=False),owner,body['operationId']))
        return result

    @staticmethod
    def publish(intake,owner,release_id,contents):
        parent=intake.inbox/intake.owner_scope(owner)
        parent.mkdir(mode=0o700,exist_ok=True)
        info=parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0,os.geteuid()} or info.st_mode&0o022:
            raise StudioError('DIRECTORY_SOURCE_UNSAFE',422)
        lockfd=os.open(parent/'.studio-export.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(lockfd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid not in {0,os.geteuid()} or info.st_mode&0o022 or info.st_nlink!=1:raise StudioError('DIRECTORY_SOURCE_UNSAFE',422)
            fcntl.flock(lockfd,fcntl.LOCK_EX)
            target=parent/release_id
            if target.exists() or target.is_symlink():
                if target.is_symlink() or not target.is_dir():raise StudioError('DIRECTORY_RELEASE_CONFLICT',409)
                expected=set(contents);actual={str(p.relative_to(target)) for p in target.rglob('*') if not p.is_dir()}
                if actual!=expected or any((target/name).is_symlink() or (target/name).read_bytes()!=value for name,value in contents.items()):raise StudioError('DIRECTORY_RELEASE_CONFLICT',409)
                return
            stage=parent/('.studio-export-'+uuid4().hex);stage.mkdir(mode=0o700)
            try:
                for name,value in contents.items():
                    path=stage/name;path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                    with os.fdopen(fd,'wb') as out:out.write(value);out.flush();os.fsync(out.fileno())
                os.rename(stage,target)
                fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(fd)
                finally:os.close(fd)
            finally:shutil.rmtree(stage,ignore_errors=True)
        finally:os.close(lockfd)
