const fail=code=>Object.assign(Error(code),{code});

// Expand only an explicit request to exclude entities together with their links.
// Names are never used to guess relation endpoints or knowledge in another material.
export function requestsRelatedExclusion(instruction){
  return !/(?:不要|不必|无需|别|不)(?:同时|一并)?(?:删除|移除|排除)|保留.*关系|[？?]/.test(instruction)&&
    /删除|移除|排除|去掉/.test(instruction)&&/(?:一并|同时|连同|及其|以及|和|及).*(?:关系|关联)/.test(instruction);
}

export async function relatedSelection(changes,instruction){
  const s=changes.state,owner=changes.owner;
  if(!requestsRelatedExclusion(instruction)||!s.selected.length||!s.summary||!owner?.draftId)return null;
  const revision=s.summary.revision,base={documentId:owner.documentId,draftId:owner.draftId,revision,editor:changes.editor()};
  const selected=new Set(s.selected),entities=new Set(),related=[];
  async function pages(kind,visit){
    let offset=0,total=null;
    do{
      const page=await changes.call('items',{...base,kind,offset,limit:50});
      if(page.revision!==revision)throw fail('CORRECTION_REVISION_CONFLICT');
      if(!Array.isArray(page.items)||page.offset!==offset||!Number.isSafeInteger(page.total)||page.total<0||total!==null&&page.total!==total||page.items.length>50||offset+page.items.length>page.total||!page.items.length&&offset<page.total)throw fail('SEMANTICA_INVALID_RESPONSE');
      total=page.total;
      for(const item of page.items){if(!item.id||item.kind!==kind)throw fail('SEMANTICA_INVALID_RESPONSE');visit(item);}
      offset+=page.items.length;
    }while(offset<total);
  }
  await pages('entity',item=>{if(selected.has(item.id))entities.add(item.id);});
  if(!entities.size)return null;
  await pages('relation',item=>{
    if(entities.has(item.payload?.source_candidate_key)||entities.has(item.payload?.target_candidate_key)){
      selected.add(item.id);related.push(item.id);
      if(selected.size>20)throw fail('MODELING_RELATED_SELECTION_TOO_LARGE');
    }
  });
  const latest=await changes.call('draft',base);
  if(latest.revision!==revision||latest.status!=='editing'||latest.stale_reason||changes.owner!==owner)throw fail('CORRECTION_REVISION_CONFLICT');
  return {ids:[...selected],relatedCount:related.length,entityCount:entities.size};
}
