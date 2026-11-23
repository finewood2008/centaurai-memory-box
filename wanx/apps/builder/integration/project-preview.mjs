import {randomUUID} from 'node:crypto';
import {previewDocument} from '../core/standard-frame.mjs';
const fail=code=>Object.assign(new Error(code),{code});
export function createProjectPreview(session){
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
   if(!entries.has(input?.handle))throw fail('PREVIEW_STALE');
   throw fail('EXPERT_DEPLOYMENT_REQUIRED');
  },
  async previewClose(input){const item=entries.get(input?.handle);if(item){entries.delete(input.handle);await release(item)}return{closed:true}}
 };
}
