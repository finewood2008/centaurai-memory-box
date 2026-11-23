// Finite warehouse ontology routes. Facts/materials and arbitrary actor input are excluded.
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const bad=()=>{throw Object.assign(new Error('INVALID_RESOURCE'),{code:'INVALID_RESOURCE'});};
export function ontologyDialogueRequest(url,method,input={}){
  if(url.pathname!=='/api/conversations'&&!/^\/api\/conversations\/[^/]+\/ontology-edit(?:\/|$)/.test(url.pathname))return null;
  if(input.editor!==undefined)bad();
  const root=url.pathname==='/api/conversations';
  const match=/^\/api\/conversations\/([A-Za-z0-9_-]{1,120})\/ontology-edit(?:\/(initialize|turns|preview|execute|proposals)(?:\/([A-Za-z0-9_-]{1,120})(\/apply)?)?)?$/.exec(url.pathname);
  if(!root&&!match)bad();
  const action=root?'conversation':match[4]?'apply':match[2]||'state',turn=match?.[3];
  const get=method==='GET';
  if(!['GET','POST'].includes(method)||action==='apply'&&(get||match[2]!=='proposals')||turn&&action!=='apply'&&(!get||action!=='turns')||get&&!['conversation','state'].includes(action)&&!turn||!get&&action==='state')bad();
  for(const [key,value] of url.searchParams){
    if(!get||!['offset','limit'].includes(key)||turn||url.searchParams.getAll(key).length!==1||!/^\d+$/.test(value)||!integer(Number(value))||(key==='limit'&&(Number(value)<1||Number(value)>50)))bad();
  }
  let body;
  if(get){if(input.body!==undefined)bad();}
  else{
    try{body=JSON.parse(input.body);}catch{bad();}
    if(!body||typeof body!=='object'||Array.isArray(body))bad();
    const fields={conversation:['operation_id','scenario','workspace_id'],initialize:['operation_id','base_ontology_id','name'],turns:['operation_id','expected_revision','draft_digest','instruction','selected'],proposals:['operation_id','expected_revision','draft_digest','instruction','selected','proposal_id','proposal_digest'],apply:['operation_id','expected_revision','draft_digest','proposal_digest','confirmed'],preview:['operation_id','expected_revision','draft_digest','offset','limit'],execute:['operation_id','preview_id','preview_digest','confirmed','mode']}[action];
    if(!fields||Object.keys(body).some(k=>!fields.includes(k))||!id(body.operation_id))bad();
    if(action==='conversation'&&(body.scenario!=='change'||body.workspace_id!==undefined&&body.workspace_id!=='default'))bad();
    if(action==='initialize'&&(!id(body.base_ontology_id)||typeof body.name!=='string'||!body.name.trim()||[...body.name].length>120))bad();
    if(['turns','proposals','apply','preview'].includes(action)&&(!integer(body.expected_revision)||!digest(body.draft_digest)))bad();
    if(['turns','proposals'].includes(action)){
      if(typeof body.instruction!=='string'||!body.instruction.trim()||[...body.instruction].length>8000||!Array.isArray(body.selected)||body.selected.length>20)bad();
      const seen=new Set();for(const s of body.selected){
        if(!s||Object.keys(s).sort().join(',')!=='kind,type_kind,type_name'||!['entity','relation'].includes(s.kind)||s.type_kind!==s.kind||!/^[A-Z][A-Z0-9_]{0,63}$/.test(s.type_name)||seen.has(s.kind+':'+s.type_name))bad();seen.add(s.kind+':'+s.type_name);
      }
    }
    if(action==='proposals'&&(body.proposal_id!==undefined||body.proposal_digest!==undefined)&&(!id(body.proposal_id)||!digest(body.proposal_digest)))bad();
    if(action==='apply'&&(!digest(body.proposal_digest)||body.confirmed!==true))bad();
    if(action==='preview'&&(!integer(body.offset)||!integer(body.limit,20)||body.limit<1))bad();
    if(action==='execute'&&(!id(body.preview_id)||!digest(body.preview_digest)||body.confirmed!==true||body.mode!=='publish_only'))bad();
    delete body.workspace_id;body._native_operation_id=body.operation_id;
  }
  return {path:'/workbench/'+url.pathname.slice(5)+url.search,method,body,timeoutMs:['turns','proposals'].includes(action)&&!get?285000:45000,workbench:true};
}
