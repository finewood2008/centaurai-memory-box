// Links are served by the box. No local listener, WANX JWT, or MCP credential in a link.
export function createSpaceShares({remote,scope,assertScope,client,copyText,onChanged}){
 const fail=code=>Object.assign(Error(code),{code});
 const id=value=>{if(!/^[a-f0-9]{32}$/.test(value||''))throw fail('SPACE_INVALID_ID');return value;};
 function link(record){
  if(!/^\/space-links\/[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(record.path||''))throw fail('SPACE_SHARE_ADDRESS_INVALID');
  const url=new URL(client.snapshot().connection.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('SPACE_SHARE_ADDRESS_INVALID');
  url.pathname=record.path;url.search='';url.hash='';return {...record,url:url.href,path:undefined};
 }
 return async function manage(action,input={}){
  const bound=scope();assertScope(bound);const options={prefix:'/api/_client/space-shares'};
  if(action==='share-list')return (await remote(bound,'',options)).value;
  if(action==='share-create'){
   const body={operation_id:id(input.operation_id),root:id(input.root),space_id:input.space_id==='personal'?'personal':id(input.space_id),domain:input.domain||'personal',permission:input.permission||'read',days:input.days||0};
   const r=link((await remote(bound,'',{...options,method:'POST',body})).value);onChanged();return r;
  }
  if(action==='share-revoke'){const r=(await remote(bound,'/'+id(input.id),{...options,method:'DELETE'})).value;onChanged();return r;}
  if(action==='share-dismiss'){const r=(await remote(bound,'/'+id(input.id)+'/dismiss',{...options,method:'POST'})).value;assertScope(bound);onChanged();return r;}
  if(action==='share-detail'||action==='share-copy'){
   const r=link((await remote(bound,'/'+id(input.id),options)).value);assertScope(bound);
   if(action==='share-detail')return r;
   if(r.state!=='active')throw fail('SPACE_SHARE_UNAVAILABLE');
   if(!copyText)throw fail('SPACE_CLIPBOARD_UNAVAILABLE');
   if(input.kind!=='link')throw fail('SPACE_ACTION_INVALID');
   await copyText(r.url);assertScope(bound);return {copied:true};
  }
  throw fail('SPACE_ACTION_INVALID');
 };
}
