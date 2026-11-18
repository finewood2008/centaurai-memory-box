// Fixed bridge shared by the embedded workspace and its focused policy tests.
const deploymentTargetKeys=['organizationId','boxId','applicationId','environment'];
function deploymentQuery(url,allowed,{target=false,required=false}={}){
 const seen=new Set();
 for(const[key,value]of url.searchParams){
  if(seen.has(key)||!allowed.includes(key))throw Error('STUDIO_PATH_DENIED');
  seen.add(key);
  const valid=key==='environment'?['dev','prod'].includes(value)
   :key==='after'||key==='limit'?/^(0|[1-9][0-9]*)$/.test(value)&&Number.isSafeInteger(Number(value))&&(key==='after'||Number(value)>=1&&Number(value)<=100)
   :/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  if(!valid)throw Error('STUDIO_PATH_DENIED');
 }
 const count=deploymentTargetKeys.filter(key=>seen.has(key)).length;
 if(target&&(required?count!==4:count!==0&&count!==4))throw Error('STUDIO_PATH_DENIED');
 return url.pathname+url.search;
}
function deploymentRoute(url,tail,method){
 if((['deployment/directory-releases','deployment/expert-templates'].includes(tail)&&method==='GET')
  ||(/^deployment\/directory-releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/context$/.test(tail)&&method==='GET')
  ||(/^deployment\/directory-releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(ingest|prepare|submit)$/.test(tail)&&method==='POST'))return deploymentQuery(url,[]);
 if(tail==='deployment/operations'&&method==='GET')return deploymentQuery(url,[...deploymentTargetKeys,'limit'],{target:true});
 if(tail==='deployment/environments'&&method==='GET')return deploymentQuery(url,deploymentTargetKeys,{target:true,required:true});
 if(/^deployment\/operations\/[a-f0-9]{32}\/events$/.test(tail)&&method==='GET')return deploymentQuery(url,['after','limit']);
 if((tail==='deployment/capabilities'&&method==='GET')
  ||(['deployment/releases','deployment/operations'].includes(tail)&&method==='POST')
  ||(/^deployment\/operations\/[a-f0-9]{32}(?:\/receipt)?$/.test(tail)&&method==='GET')
  ||(/^deployment\/operations\/[a-f0-9]{32}\/(?:resume|receipt\/retry)$/.test(tail)&&method==='POST'))return deploymentQuery(url,[]);
 throw Error('STUDIO_PATH_DENIED');
}
export function studioRoute(raw,method='GET'){
 if(typeof raw!=='string'||/[\\%#]/.test(raw)||!['GET','POST','PUT','DELETE'].includes(method))throw Error('STUDIO_PATH_DENIED');
 const url=new URL(raw,'http://studio.invalid');
 if(url.origin!=='http://studio.invalid'||!url.pathname.startsWith('/api/app-studio/')||url.username||url.password)throw Error('STUDIO_PATH_DENIED');
 const tail=url.pathname.slice(16);
 if(/^projects\/[a-f0-9]{32}\/dev-kit$/.test(tail)){
  if(method!=='GET'||raw!==url.pathname)throw Error('STUDIO_PATH_DENIED');
  return url.pathname;
 }
 if(/^projects\/[a-f0-9]{32}\/deployment\/(expert|release)$/.test(tail)){
  if(raw!==url.pathname||!(tail.endsWith('/expert')?['GET','PUT'].includes(method):method==='POST'))throw Error('STUDIO_PATH_DENIED');
  return url.pathname;
 }
 if(/^projects\/[a-f0-9]{32}\/deployment\/(context|prepare|submit)$/.test(tail)){
  const verb=tail.endsWith('/context')?'GET':'POST';
  if(method!==verb||raw!==url.pathname)throw Error('STUDIO_PATH_DENIED');
  return url.pathname;
 }
 // Do not let URL normalization turn a deployment path into another allowed route.
 if((tail==='deployment'||tail.startsWith('deployment/')||raw.startsWith('/api/app-studio/deployment/'))&&raw!==url.pathname+url.search)throw Error('STUDIO_PATH_DENIED');
 if(tail==='deployment'||tail.startsWith('deployment/'))return deploymentRoute(url,tail,method);
 if(/^_management\/projects(?:\/[a-f0-9]{32})?$/.test(tail)&&((tail==='_management/projects'&&method==='GET')||(tail!=='_management/projects'&&method==='POST')))return url.pathname;
 if(/^_builder\/projects\/[a-f0-9]{32}\/restore-version$/.test(tail)&&method==='POST')return url.pathname;
 if(tail==='_builder/context'&&method==='GET')return url.pathname+url.search;
 if(/^_builder\/projects\/[a-f0-9]{32}\/edits\/(stop|heartbeat)$/.test(tail)&&method==='POST')return url.pathname;
 if(/^_builder\/projects\/[a-f0-9]{32}\/edits$/.test(tail)&&['GET','POST'].includes(method))return url.pathname+url.search;
 if(/^_builder\/projects\/[a-f0-9]{32}\/edits\/[a-f0-9]{32}\/(answer|retry|stop)$/.test(tail)&&method==='POST')return url.pathname+url.search;
 if(/^_builder\/projects\/[a-f0-9]{32}\/(proposal|build)$/.test(tail)&&((tail.endsWith('/proposal')&&method==='GET')||(tail.endsWith('/build')&&method==='POST')))return url.pathname+url.search;
 if(!/^(context|preflight|capabilities|files|engines(?:\/default|\/check)?|context\/sources|projects(?:\/[a-f0-9]{32}(?:\/(?:intake(?:\/handoff|\/events)?|context(?:\/read|\/search)?|engine|capabilities(?:\/check|\/decisions)?|interview(?:\/turns|\/events|\/start)?|chat|solution|confirm|decisions|build|feedback|iterations|adopt|versions(?:\/[a-f0-9]{64}(?:\/restore-check)?)?|restore-version|tasks\/[A-Za-z0-9_-]+(?:\/events|\/cancel|\/answer)?|runtime|install\/[a-f0-9]{64}))?)?|runtime\/[A-Za-z0-9_-]+(?:\/invoke|\/files|\/knowledge|\/haowen-native)?)$/.test(tail))throw Error('STUDIO_PATH_DENIED');
 return url.pathname+url.search;
}
export function scopeKey(c){return JSON.stringify([c.accountId,c.boxId,c.user?.id])}
export function validatePlacement(input){
 if(input?.protocolVersion!==1||!['show','hide','detach','attach'].includes(input.action))throw Error('WORKSPACE_OPERATION_DENIED');
 return input.action;
}
