// Read-only, revision-bound source selection. References are dialogue context;
// only a subsequent server proposal and explicit apply can change evidence.
const fail=code=>Object.assign(Error(code),{code});
const marker='\n用户选取的原文参考位置：';
const footer='此位置仅供核对，请从当前材料重新验证，不能将聊天陈述作为原文，也不能声称已保存证据。';
export function referenceUserInstruction(value){
  const text=String(value||''),index=text.lastIndexOf(marker);if(index<0||!text.endsWith('\n'+footer))return text;
  try{const ref=JSON.parse(text.slice(index+marker.length,-footer.length-1));if(typeof ref.quote==='string'&&typeof ref.segment_id==='string')return text.slice(0,index);}catch{/* Display unrecognized text intact. */}
  return text;
}
export class MaterialEvidence{
  constructor(flow){this.f=flow;}
  get c(){return this.f.changes;}
  get state(){return this.c.state.evidencePicker;}
  get reference(){return this.c.state.evidenceReference;}
  get composer(){return this.f.saved.materialComposers?.[this.f.saved.conversationId+':'+(this.f.state.selectedIntent||'')];}
  storedFragment(){
    const ref=this.composer?.sourceFragment;
    if(!ref||typeof ref.quote!=='string'||![...ref.quote].length||[...ref.quote].length>500||ref.fragment!==`参考当前材料原文：“${ref.quote}”`)return null;
    return {quote:ref.quote,fragment:ref.fragment,insertedAt:Number.isSafeInteger(ref.insertedAt)?ref.insertedAt:undefined,unbound:true};
  }
  get displayedReference(){const ref=this.reference||this.storedFragment();return ref&&this.locations(this.f.state.input,ref).length?ref:null;}
  composerFragment(){
    const ref=this.displayedReference;if(!ref)return undefined;
    // Bookkeeping only, never a restored source identity or editor credential.
    return {quote:ref.quote,fragment:this.fragment(ref),...(Number.isSafeInteger(ref.insertedAt)?{insertedAt:ref.insertedAt}:{})};
  }
  fragment(ref=this.reference){return ref?.fragment||`参考当前材料原文：“${ref?.quote||''}”`;}
  locations(text,ref=this.reference){
    if(!ref||typeof text!=='string')return [];
    const fragment=this.fragment(ref),positions=[];
    for(let index=text.indexOf(fragment);index>=0;index=text.indexOf(fragment,index+fragment.length)){
      const end=index+fragment.length;
      if((index===0||text[index-1]==='\n')&&(end===text.length||text[end]==='\n'))positions.push(index);
    }
    return positions;
  }
  withoutReference(text,ref=this.displayedReference){
    const positions=this.locations(text,ref),index=positions.includes(ref?.insertedAt)?ref.insertedAt:positions.length===1?positions[0]:-1;
    if(index<0)return text;
    const end=index+this.fragment(ref).length;
    return index>0?text.slice(0,index-1)+text.slice(end):text.slice(end+(text[end]==='\n'?1:0));
  }
  syncInput(){
    const ref=this.reference||this.storedFragment();
    if(!ref||this.locations(this.f.state.input,ref).length)return false;
    this.c.state.evidenceReference=null;
    if(this.composer)delete this.composer.sourceFragment;
    this.f.state.inputNotice='原文参考定位已取消，编辑后的文字按本次对话内容处理。';return true;
  }
  replaceInput(text){
    if(typeof text!=='string'||this.f.state.busy||this.c.record.pending)return false;
    this.c.state.evidenceReference=null;this.c.state.evidencePicker=null;
    if(this.composer)delete this.composer.sourceFragment;
    this.f.state.input=text;this.f.state.inputNotice='';return true;
  }
  binding(){const f=this.f,c=this.c,s=c.state.summary;
    f.check();
    if(!f.state.detail?.document_version_id||f.state.selectedIntent!==f.state.detail.id)throw fail('MODELING_SNAPSHOT_CHANGED');
    if(!c.owner?.draftId||c.owner.documentId!==f.state.detail?.document_id||s?.id!==c.owner.draftId||s.status!=='editing'||s.stale_reason)throw fail('CORRECTION_SESSION_REQUIRED');
    if(s.document_id&&s.document_id!==f.state.detail.document_id||s.document_version_id&&s.document_version_id!==f.state.detail.document_version_id)throw fail('MODELING_SOURCE_CHANGED');
    return {scope:c.scopeKey,documentId:c.owner.documentId,documentVersionId:f.state.detail.document_version_id,draftId:s.id,revision:s.revision};
  }
  matches(a,b){return !!a&&Object.keys(b).every(k=>a[k]===b[k]);}
  async fresh(binding){
    if(!this.matches(binding,this.binding()))throw fail('CORRECTION_REVISION_CONFLICT');
    await this.c.loadDraft();
    if(!this.matches(binding,this.binding()))throw fail('CORRECTION_REVISION_CONFLICT');
  }
  async pageNow(binding,offset=0){
    const page=await this.c.call('sources',{documentId:binding.documentId,draftId:binding.draftId,revision:binding.revision,offset,limit:10,editor:this.c.editor()});
    if(!this.matches(binding,this.binding())||page.revision!==binding.revision)throw fail('CORRECTION_REVISION_CONFLICT');
    if(!Array.isArray(page.items)||page.offset!==offset||!Number.isSafeInteger(page.total)||page.total<offset||page.items.length>10||offset+page.items.length>page.total||!page.items.length&&offset<page.total||page.items.some(e=>!e||typeof e.segment_id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(e.segment_id)||typeof e.text!=='string'||!Number.isSafeInteger(e.ordinal)||e.ordinal<0))throw fail('SEMANTICA_INVALID_RESPONSE');
    this.c.state.evidencePicker={...binding,page,source:null};
  }
  open(){return this.f.run(async()=>{
    const binding=this.binding();this.c.state.evidencePicker=null;
    await this.f.ready();await this.fresh(binding);await this.pageNow(binding);
  });}
  page(offset){return this.f.run(async()=>{const binding=this.state;if(!binding)throw fail('CORRECTION_SESSION_REQUIRED');await this.fresh(binding);await this.pageNow(binding,offset);});}
  read(index,start=0){return this.f.run(async()=>{
    const binding=this.state,entry=binding?.page.items[index];if(!entry?.segment_id)throw fail('MODELING_SOURCE_NOT_READY');
    if(!Number.isSafeInteger(start)||start<0)throw fail('MODELING_INVALID_REQUEST');
    binding.source=null;this.f.emit();await this.fresh(binding);
    const value=await this.c.call('source',{documentId:binding.documentId,draftId:binding.draftId,revision:binding.revision,sourceId:entry.segment_id,start,editor:this.c.editor()});
    if(!this.matches(binding,this.binding()))throw fail('CORRECTION_REVISION_CONFLICT');
    if(value.segment_id!==entry.segment_id||typeof value.text!=='string'||!value.text.length||value.start!==start||!Number.isSafeInteger(value.end)||value.end-value.start!==[...value.text].length||!Number.isSafeInteger(value.total_chars)||value.end>value.total_chars)throw fail('SEMANTICA_INVALID_RESPONSE');
    this.c.state.evidencePicker={...binding,source:value};
  });}
  window(direction){const p=this.state,source=p?.source;if(!source)return;
    const index=p.page.items.findIndex(e=>e.segment_id===source.segment_id);
    return this.read(index,direction==='next'?source.end:Math.max(0,source.start-2000));
  }
  quote(start,end){
    if(this.c.selectionLocked)return;
    try{
      const binding=this.state,source=binding?.source;if(!source||!this.matches(binding,this.binding()))throw fail('CORRECTION_REVISION_CONFLICT');
      // DOM selections count UTF-16 units; source offsets count Unicode points.
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>source.text.length)throw fail('MODELING_QUOTE_SELECTION_REQUIRED');
      const quote=source.text.slice(start,end);
      if(!quote.trim())throw fail('MODELING_QUOTE_SELECTION_REQUIRED');
      if([...quote].length>500)throw fail('MODELING_QUOTE_TOO_LONG');
      const left=source.start+[...source.text.slice(0,start)].length,right=left+[...quote].length;
      if(/^[\udc00-\udfff]/.test(quote)||/[\ud800-\udbff]$/.test(quote))throw fail('MODELING_QUOTE_SELECTION_REQUIRED');
      const text=`参考当前材料原文：“${quote}”`,original=this.withoutReference(this.f.state.input);
      this.c.state.evidenceReference={scope:binding.scope,documentId:binding.documentId,documentVersionId:binding.documentVersionId,draftId:binding.draftId,revision:binding.revision,sourceId:source.segment_id,start:left,end:right,quote,fragment:text,insertedAt:original.trim()?original.length+1:0};
      this.c.state.evidencePicker=null;
      this.f.state.input=original.trim()?original+'\n'+text:text;
      this.f.state.inputNotice='已将原文放入对话参考。请补充调整要求后发送；这不会直接保存证据，服务端仍需核对引用并生成建议。';
      this.f.saveMaterialComposer();this.f.emit();
    }catch(error){this.f.state.inputNotice=error.code==='MODELING_QUOTE_TOO_LONG'?'每次请选择不超过 500 字的原文。':error.code==='MODELING_QUOTE_SELECTION_REQUIRED'?'请先在原文框中选中需要引用的文字。':'材料或草稿已变化，请重新打开原文选择。';this.f.emit();}
  }
  close(){if(this.f.state.busy||this.c.record.pending)return;this.c.state.evidencePicker=null;this.f.emit();}
  clear(){if(this.f.state.busy||this.c.record.pending)return;
    const original=this.f.state.input;this.f.state.input=this.withoutReference(original);this.c.state.evidenceReference=null;
    if(this.composer)delete this.composer.sourceFragment;
    this.f.state.inputNotice=this.f.state.input===original?'已取消引用定位，自行编辑的文字已保留，发送后仍需核对。':'已取消原文参考，其他调整要求已保留。';this.f.saveMaterialComposer();this.f.emit();
  }
  async instruction(text){
    this.syncInput();
    const ref=this.reference;if(!ref)return text;
    if(!this.matches(ref,this.binding()))throw fail('CORRECTION_REVISION_CONFLICT');
    const source=await this.c.call('source',{documentId:ref.documentId,draftId:ref.draftId,revision:ref.revision,sourceId:ref.sourceId,start:ref.start,editor:this.c.editor()});
    if(!this.matches(ref,this.binding())||source.segment_id!==ref.sourceId||source.start!==ref.start||typeof source.text!=='string'||[...source.text].slice(0,ref.end-ref.start).join('')!==ref.quote)throw fail('MODELING_SOURCE_CHANGED');
    const value=`${text}${marker}${JSON.stringify({document_id:ref.documentId,document_version_id:ref.documentVersionId,segment_id:ref.sourceId,start:ref.start,end:ref.end,quote:ref.quote})}\n${footer}`;
    if([...value].length>4000)throw fail('MODELING_CHANGE_CONTEXT_TOO_LARGE');
    return value;
  }
}
