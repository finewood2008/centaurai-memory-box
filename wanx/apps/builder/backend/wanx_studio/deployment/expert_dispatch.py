"""Shared expert invocation and finite installed-app audience rules."""
import re

from ..contracts import StudioError


def authorize_studio_audience(svc,owner,application,path,method):
    if application=='wanx':return False
    if not isinstance(application,str) or not re.fullmatch(r'ai\.wanx\.selfmade\.[a-f0-9]{32}',application):
        raise StudioError('STUDIO_IDENTITY_FORBIDDEN',403)
    if method=='POST' and path in {'/apps/'+application+'/runtime','/deployment/apps/'+application+'/runtime'}:
        return True
    match=re.fullmatch(r'/runtime/([A-Za-z0-9_-]+)(?:/(invoke|files))?',path)
    if match and ((method=='POST' and match[2] in {'invoke','files'}) or (method=='DELETE' and match[2] is None)):
        session=svc.runtime_sessions.get(match[1])
        if session and session['owner']==owner and session.get('deploymentSlot',session.get('app'))==application:
            return True
    raise StudioError('STUDIO_IDENTITY_FORBIDDEN',403)


async def invoke(svc,owner,token,params):
    current=svc.runtime(owner,token)
    if current.get('deploymentProfile')!='wanx-expert-app-v1':
        raise StudioError('EXPERT_DEPLOYMENT_REQUIRED',409)
    svc.authorize_management(owner)
    if ('foundation' not in current['manifest']['capabilities'] or not isinstance(params,dict)
        or set(params)!={'operation','input'} or not isinstance(params['operation'],str) or not isinstance(params['input'],dict)):
        raise StudioError('FOUNDATION_INPUT_INVALID',422)
    runtime=getattr(svc,'expert_runtime',None)
    if runtime is None:raise StudioError('EXPERT_RUNTIME_UNAVAILABLE',409)
    result=await runtime.invoke(owner,token,params['operation'],params['input'])
    svc.runtime(owner,token)
    svc.directory_profile.mark_client_ready(owner,token)
    return result
