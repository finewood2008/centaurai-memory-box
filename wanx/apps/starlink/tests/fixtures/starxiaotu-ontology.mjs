// Synthetic, project-scoped ontology receipts for isolated browser acceptance.
export function starxiaotuOntologyFixture() {
  const clone=structuredClone,projects=new Map(),receipts=new Map(),writes=[];
  let sequence=0;
  const db={projects,receipts,writes,lose:'',pause:'',release:null};
  function project(id) {
    if(!projects.has(id)) {
      const schema={entity_types:[{name:'CONTRACT',label:'合同',properties:[{name:'name',label:'名称',required:true}]}],relation_types:[]};
      projects.set(id,{round:null,publications:0,versions:[
        {id:id+'-base',name:'合同规则',status:'published',version_number:2,schema:clone(schema)},
        {id:id+'-draft',name:'备用规则',status:'draft',version_number:3,schema:clone(schema)},
        {id:id+'-old',name:'历史合同规则',status:'archived',version_number:1,schema:clone(schema)},
      ]});
    }
    return projects.get(id);
  }
  async function request(input) {
    const {warehouseId,url,method='GET'}=input, p=project(warehouseId),body=input.body&&JSON.parse(input.body);
    const current=()=>p.versions.find(row=>row.status==='published');
    if(method==='GET') {
      if(url.startsWith('/api/ontologies'))return {items:clone(p.versions)};
      if(url.startsWith('/api/jobs?'))return {items:[],total:0,activity:{foreground_count:0,sensitive_job:null}};
      if(url.startsWith('/api/owner/graph?'))return {nodes:[],edges:[]};
      if(url.startsWith('/api/conversations?'))return {items:p.round?[{id:p.round.conversation_id,scenario:'change'}]:[],has_more:false,next_offset:p.round?1:0};
      if(url.endsWith('/ontology-edit') && p.round)return clone({...p.round,current_ontology_id:current().id});
      throw new Error('Unexpected fixture read: '+url);
    }
    const key=warehouseId+':'+body.operation_id;
    if(receipts.has(key))return clone(receipts.get(key));
    writes.push(clone(input));
    const c=p.round;let result;
    if(url==='/api/conversations') {
      p.round={conversation_id:'rules-'+(++sequence),initialized:false,status:'uninitialized',current_ontology_id:current().id};
      result={resource_id:p.round.conversation_id};
    } else if(url.endsWith('/initialize')) {
      Object.assign(c,{status:'editing',initialized:true,base_ontology_id:current().id,draft_digest:'a'.repeat(64),
        draft:{revision:0,name:'合同规则草稿',schema:clone(current().schema),questions:[]},history:{items:[]}});
      result={resource_id:'initialized-'+sequence};
    } else if(url.endsWith('/proposals')) {
      const schema=clone(c.draft.schema);
      if(!schema.entity_types[0].properties.some(p=>p.name==='expires_at'))schema.entity_types[0].properties.push({name:'expires_at',label:'到期日期',required:false});
      schema.entity_types[0].properties.find(p=>p.name==='expires_at').required=body.instruction.includes('必填');
      c.proposal={resource_id:'proposal-'+(++sequence),proposal_digest:'b'.repeat(64),draft_digest:c.draft_digest,expected_revision:c.draft.revision,
        status:'proposed',summary:'给合同类型配置'+(body.instruction.includes('必填')?'必填':'选填')+'的到期日期属性。',schema,questions:[],dependencies:[]};
      c.history.items.unshift({resource_id:c.proposal.resource_id,status:'proposed',instruction:body.instruction});
      result={resource_id:c.proposal.resource_id,status:'proposed'};
    } else if(url.endsWith('/apply')) {
      if(body.expected_revision!==c.draft.revision || body.draft_digest!==c.draft_digest || body.proposal_digest!==c.proposal.proposal_digest || !body.confirmed)throw new Error('Fixture revision/confirmation mismatch');
      c.draft.revision++;c.draft.schema=clone(c.proposal.schema);c.proposal.status='applied';c.draft_digest='c'.repeat(64);
      result={resource_id:'application-'+(++sequence),status:'applied'};
    } else if(url.endsWith('/preview')) {
      result={resource_id:'preview-'+(++sequence),draft_revision:c.draft.revision,draft_digest:c.draft_digest,preview_digest:'d'.repeat(64),
        impact:{valid:true,total:1,offset:0,has_more:false,items:[{document_id:'contract-doc',name:'合同样例.txt',certainty:'possible',protected:true,active_task_count:0,reasons:['可能包含合同到期日期。']}]}};
    } else if(url.endsWith('/execute')) {
      if(!body.confirmed || body.mode!=='publish_only')throw new Error('Fixture publication confirmation missing');
      current().status='archived';p.publications++;
      p.versions.unshift({id:warehouseId+'-published-'+p.publications,name:'合同规则',status:'published',version_number:4,schema:clone(c.draft.schema)});
      c.status='published';c.execution_id='execution-'+(++sequence);c.current_ontology_id=current().id;c.publication_effective=true;
      result={resource_id:c.execution_id,status:'completed'};
    } else throw new Error('Unexpected fixture write: '+url);
    receipts.set(key,clone(result));
    if(db.pause && url.endsWith(db.pause)){db.pause='';await new Promise(resolve=>{db.release=resolve;});db.release=null;}
    if(db.lose && url.endsWith(db.lose)){db.lose='';throw new Error('Synthetic lost response');}
    return clone(result);
  }
  return {db,project,query:id=>({items:clone(project(id).versions)}),async request(input){
    try{return {ok:true,value:await request(input)};}
    catch(error){return {ok:false,code:'SEMANTICA_CONNECTION_FAILED',message:error.message};}
  }};
}
