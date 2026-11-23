"""Standard directory preparation and main-process-only delivery transport."""
from fastapi import Depends, Request
from ..contracts import StudioError
from .api import _body, _query
from .adapters import Blocked


def mount(router, svc, identity):
    def profile(owner):
        svc.authorize_management(owner)
        selected=getattr(svc,'directory_profile',None)
        if selected is None or not selected.available:
            raise StudioError('DEPLOYMENT_ADAPTER_UNAVAILABLE',503)
        return selected

    async def call(fn, *args):
        try:
            result=fn(*args)
            import inspect
            return await result if inspect.isawaitable(result) else result
        except Blocked as error:
            raise StudioError(error.code,503 if error.code=='DEPLOYMENT_ADAPTER_UNAVAILABLE' else 403) from None

    def directory(owner):
        svc.authorize_management(owner)
        selected=getattr(svc,'directory_profile',None)
        if selected is None or not selected.available:
            raise StudioError('DEPLOYMENT_ADAPTER_UNAVAILABLE',503)
        return selected

    @router.get('/deployment/directory-releases')
    async def directory_releases(request:Request,owner=Depends(identity)):
        _query(request)
        svc.authorize_management(owner)
        selected=getattr(svc,'directory_profile',None)
        if selected is None:
            return {'schemaVersion':1,'profile':'wanx-expert-app-v1','available':False,'reason':'DEPLOYMENT_ADAPTER_UNAVAILABLE','items':[]}
        from ..local_authority import to_thread
        return await to_thread(selected.directory_list,owner)

    @router.get('/deployment/expert-templates')
    async def expert_templates(request:Request,owner=Depends(identity)):
        _query(request)
        selected=directory(owner);selected.authorize_owner(owner)
        from ..local_authority import to_thread
        return {'schemaVersion':1,'profile':'wanx-expert-app-v1','items':await to_thread(selected.experts.templates)}

    @router.post('/deployment/directory-releases/{release_id}/ingest')
    async def directory_ingest(release_id:str,request:Request,owner=Depends(identity)):
        _query(request)
        if await _body(request)!={}:raise StudioError('DEPLOYMENT_PREPARATION_INVALID',422)
        from ..local_authority import to_thread
        return await to_thread(directory(owner).ingest,owner,release_id)

    @router.get('/deployment/directory-releases/{release_id}/context')
    async def directory_context(release_id:str,request:Request,owner=Depends(identity)):
        _query(request)
        from ..local_authority import to_thread
        return await to_thread(directory(owner).directory_context,owner,release_id)

    @router.post('/deployment/directory-releases/{release_id}/prepare')
    async def directory_prepare(release_id:str,request:Request,owner=Depends(identity)):
        _query(request)
        return await call(directory(owner).prepare_directory,owner,release_id,await _body(request))

    @router.post('/deployment/directory-releases/{release_id}/submit',status_code=202)
    async def directory_submit(release_id:str,request:Request,owner=Depends(identity)):
        _query(request)
        return await call(directory(owner).submit_directory,owner,release_id,await _body(request))

    @router.get('/deployment/client-deliveries')
    async def deliveries(request:Request,owner=Depends(identity)):
        _query(request)
        return await call(profile(owner).delivery_list,owner)

    @router.post('/deployment/client-deliveries/{ticket_id}/claim')
    async def claim(ticket_id:str,request:Request,owner=Depends(identity)):
        _query(request)
        return await call(profile(owner).delivery_claim,owner,ticket_id,await _body(request))

    @router.get('/deployment/client-deliveries/{ticket_id}/payload')
    async def payload(ticket_id:str,request:Request,owner=Depends(identity)):
        _query(request)
        return await call(profile(owner).delivery_payload,owner,ticket_id)

    @router.post('/deployment/client-deliveries/{ticket_id}/ack')
    async def ack(ticket_id:str,request:Request,owner=Depends(identity)):
        _query(request)
        return await call(profile(owner).delivery_ack,owner,ticket_id,await _body(request))

    @router.post('/deployment/apps/{slot_id}/runtime')
    async def runtime(slot_id:str,request:Request,owner=Depends(identity)):
        _query(request)
        return await call(profile(owner).open_runtime,owner,slot_id,await _body(request))
