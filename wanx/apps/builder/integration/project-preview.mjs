import {randomUUID} from 'node:crypto';
import {previewDocument} from '../core/standard-frame.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const reads=new Set(['data.list','data.get','model.list','reports.context','reports.list','reports.get','knowledge.search','knowledge.documents','knowledge.graph','knowledge.evidence']);
const foundationReads=new Set(['status','customers','customer','records','opportunities','pending','pending.business','models','backup.status','expert.tasks','schedules','schedule.history','legacy','data.list','data.get']);
export function createProjectPreview(session,{invokeFoundation}={}){
 const entries=new Map();let generation=0;
 async function release(item){try{await item.s.request('/runtime/'+item.token,'DELETE')}catch{/* Expired/old contexts cannot be reused; server leases expire. */}}
 return{
  async previewOpen(input){
   if(!/^[a-f0-9]{32}$/.test(input?.projectId)||!/^[a-f0-9]{64}$/.test(input?.artifactHash))throw fail('STUDIO_PROJECT_INVALID');
   const g=++generation,s=await session();
   const previous=[...entries.values()];entries.clear();await Promise.all(previous.map(release));
   const value=await s.request('/projects/'+input.projectId+'/runtime','POST',{artifactHash:input.artifactHash,environment:'preview'});
   const item={s,token:value.session,hash:input.artifactHash};
   if(g!==generation){void release(item);throw fail('PREVIEW_STALE')}
   let rendered;try{rendered=previewDocument(value,input.artifactHash)}catch(error){await release(item);throw error}
   s.assertLive();const handle=randomUUID();entries.set(handle,{...item,layoutOnly:rendered.layoutOnly});
   return{handle,artifactHash:input.artifactHash,...rendered};
  },
  async previewInvoke(input){
   if(entries.get(input?.handle)?.layoutOnly)throw fail('EXPERT_DEPLOYMENT_REQUIRED');
   const foundationRead=input?.method==='foundation.invoke'&&foundationReads.has(input?.params?.operation);
   if(!reads.has(input?.method)&&!foundationRead&&!(input?.method==='dialogue.invoke'&&input?.params?.operation==='read'))throw fail('PREVIEW_READ_ONLY');
   const item=entries.get(input.handle);if(!item)throw fail('PREVIEW_STALE');
   item.s.assertLive();const current=await session();if(current.key!==item.s.key)throw fail('STUDIO_CONTEXT_CHANGED');
   let result=await item.s.request('/runtime/'+item.token+'/invoke','POST',{method:input.method,params:input.params||{}});
   if(foundationRead&&result?.nativeFoundation){if(!invokeFoundation)throw fail('FOUNDATION_NATIVE_REQUIRED');result=await invokeFoundation(result,item.s);await item.s.request('/runtime/'+item.token+'/invoke','POST',{method:'foundation.invoke',params:{operation:'status',input:{}}});}
   item.s.assertLive();if(entries.get(input.handle)!==item)throw fail('PREVIEW_STALE');return result;
  },
  async previewClose(input){const item=entries.get(input?.handle);if(item){entries.delete(input.handle);await release(item)}return{closed:true}}
 };
}
