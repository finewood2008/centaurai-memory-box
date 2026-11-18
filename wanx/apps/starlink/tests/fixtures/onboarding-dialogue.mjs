// Synthetic receipts only. Shared by node state tests and isolated Electron UI tests.
export const identity={accountId:'fixture',boxId:'box',user:{id:1,name:'测试用户'},dataScope:'personal'};
export const memory=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};};
const clone=structuredClone;
const fail=(code,status=0)=>Object.assign(Error(code),{code,status});
export function dialogueFixture({guidance=false}={}){
  let sequence=0;const calls=[],receipts=new Map(),entries=[];
  const scope={industry:'',occupation:'',service_objects:[],purposes:[],material_sources:[],questions_to_answer:[],excluded_scope:[],uncertain_items:[]};
  const schema={entity_types:[{name:'PERSON',label:'人物',definition:'个人',properties:[]}],relation_types:[]};
  const db={warehouses:[],sessions:[],snapshots:{},root:{revision:0},lose:null,failTurn:false,refuse:null,hold:null,current:'base',generations:0,publishes:0};
  function make(id){const s={conversation_id:id,status:'guiding',draft:{revision:0,round:0,scope:clone(scope),schema:clone(schema),questions:[{field:'service_objects',text:'这个仓主要服务企业、部门还是个人？'},{field:'purposes',text:'你希望用它解决什么问题？'}],changes:[],scope_changes:[],base_ontology_id:'base',purpose_revision:0},draft_digest:'a'.repeat(64),can_preview:false,progress:{round:0,suggested_rounds:[5,8]},turns:{items:[],has_more:false,next_offset:0},publication:null,publication_effective:false};
    if(guidance){Object.assign(s,{can_start:true,guidance_source:'fallback',active_turn_id:null});s.draft.ontology_proposed=false;s.draft.questions=s.draft.questions.map((q,i)=>({...q,question_id:id+'-q'+i,examples:i?['匹配人才与岗位']:['企业研发部门'],status:'pending',answer:'',source:'fallback'}));s.draft.question_states=clone(s.draft.questions);}return s;}
  async function call(action,input={}){calls.push({action,input:clone(input)});if(db.refuse===action)throw fail(db.refuseCode||'MODELING_ONBOARDING_STALE',409);
    const s=db.snapshots[input.conversationId];
    if(action==='onboarding-read')return clone(db.root);
    if(action==='onboarding-warehouses')return {items:clone(db.warehouses)};
    if(action==='conversation-list')return {items:clone(db.sessions),has_more:false,next_offset:db.sessions.length};
    if(action==='conversation-onboarding-get')return clone(s);
    if(action==='conversation-onboarding-turn')return {...clone(s.turns.items.find(t=>t.resource_id===input.turnId)),is_current:false};
    if(action==='conversation-ontologies')return {items:[{id:db.current,name:'当前本体',status:'published',version_number:2,schema:clone(schema)}]};
    const op=input.operationId||input.body?.operation_id;let r=receipts.get(op);
    if(!r){
      if(action==='onboarding-save'){db.root={id:'root',revision:db.root.revision+1,answers:clone(input.body.answers)};r={resource_id:'root',revision:db.root.revision};}
      else if(action==='onboarding-create'){const w={id:'warehouse-'+(++sequence),name:input.body.name,state:'active'};db.warehouses.push(w);r={resource_id:w.id,warehouse:w};}
      else if(action==='conversation-create'){const id='conversation-'+(++sequence);db.sessions.unshift({id,scenario:input.scenario,status:'active',created_at:'2026-11-08T10:00:00Z'});db.snapshots[id]=make(id);r={resource_id:id};}
      else if(['conversation-onboarding-send','conversation-onboarding-start'].includes(action)){
        const opening=action==='conversation-onboarding-start';
        if(input.revision!==s.draft.revision||input.draftDigest!==s.draft_digest)throw fail('MODELING_ONBOARDING_STALE',409);
        if(opening&&!s.can_start)throw fail('MODELING_ONBOARDING_ALREADY_STARTED',409);
        const states=clone(s.draft.question_states||[]);
        for(const a of input.questionActions||[]){const q=states.find(q=>q.question_id===a.question_id);if(!q)throw fail('MODELING_ONBOARDING_QUESTION_STALE',409);Object.assign(q,{status:{answer:'answered',skip:'skipped',uncertain:'uncertain'}[a.action],answer:a.answer||''});}
        r={resource_id:'turn-'+(++sequence),conversation_id:input.conversationId,status:'generating',kind:opening?'opening':'reply',content:input.content||'',question_actions:clone((input.questionActions||[]).map(a=>({answer:'',...a}))),publication_performed:false};s.turns.items.unshift(r);receipts.set(op,r);db.generations++;
        if(guidance){s.active_turn_id=r.resource_id;s.can_preview=false;s.can_start=false;}
        if(db.hold)await db.hold;
        if(db.failTurn||opening&&db.failOpening){db.failTurn=false;db.failOpening=false;Object.assign(r,{status:'failed',error_code:'MODELING_ONBOARDING_INVALID_OUTPUT'});if(guidance){s.can_start=s.draft.revision===0;s.can_preview=s.draft.ontology_proposed;}}
        else if(opening){s.draft.revision++;s.draft_digest=s.draft.revision.toString(16).padStart(64,'0');s.guidance_source='model';s.draft.question_states=states.map(q=>({...q,source:'model'}));s.draft.questions=clone(s.draft.question_states);Object.assign(r,{status:'succeeded',answer:'我们先明确服务对象与用途，再提出有依据的本体。',draft:clone(s.draft)});}
        else {s.draft.revision++;s.draft.round++;s.progress.round++;s.draft_digest=s.draft.revision.toString(16).padStart(64,'0');
          Object.assign(s.draft.scope,{service_objects:['企业研发部门'],purposes:['人才与岗位匹配'],material_sources:['简历'],questions_to_answer:['哪个人适合岗位'],excluded_scope:['私人住址'],uncertain_items:['能力评分标准待补充']});
          s.draft.schema={entity_types:[...clone(schema.entity_types),{name:'SKILL',label:'技能',definition:'岗位所需能力',properties:[{name:'level',label:'等级',definition:'熟练程度',required:false}]}],relation_types:[{name:'HAS_SKILL',label:'具备技能',definition:'人员具备的技能',source_types:['PERSON'],target_types:['SKILL'],properties:[]}]};
          s.draft.changes=[{kind:'entity_types',name:'SKILL',before:null,after:s.draft.schema.entity_types[1]}];s.draft.scope_changes=[{field:'purposes',before:[],after:clone(s.draft.scope.purposes)}];
          s.draft.questions=[{field:'excluded_scope',text:'还有哪些内容不需要纳入？'}];
          if(guidance){s.draft.ontology_proposed=true;s.guidance_source='model';
            if(!states.some(q=>q.status==='pending')&&!states.some(q=>q.question_id===input.conversationId+'-followup'))states.push({question_id:input.conversationId+'-followup',field:'material_sources',text:'是否包含历史简历？',examples:['只整理当前简历'],source:'model',status:'pending',answer:''});
            s.draft.question_states=states;s.draft.questions=clone(states.filter(q=>q.status==='pending'));}
          s.can_preview=true;s.status='ready_for_preview';Object.assign(r,{status:'succeeded',answer:'已更新人才与技能范围，可以继续调整关系、属性或核对。',draft:clone(s.draft)});
        }
        if(guidance)s.active_turn_id=null;
      }else if(action==='conversation-onboarding-preview'){if(!s.can_preview||s.draft_digest!==input.draftDigest)throw fail('MODELING_ONBOARDING_STALE',409);r={resource_id:'preview-'+(++sequence),conversation_id:input.conversationId,status:'previewed',draft_revision:s.draft.revision,draft_digest:s.draft_digest,preview_digest:'b'.repeat(64),scope:clone(s.draft.scope),schema:clone(s.draft.schema),questions:clone(s.draft.questions),changes:clone(s.draft.changes),publication_performed:false};}
      else if(action==='conversation-onboarding-publish'){db.publishes++;db.current='published';r={resource_id:input.previewId,conversation_id:input.conversationId,status:'published',ontology_id:'published',version_number:2,changed:true,publication_performed:true,extraction_started:false,scope:clone(s.draft.scope),schema:clone(s.draft.schema),unresolved_items:clone(s.draft.scope.uncertain_items)};s.publication=clone(r);s.status='published';s.publication_effective=true;s.can_preview=false;}
      else throw Error('Unexpected fixture action '+action);
      if(guidance&&['conversation-onboarding-preview','conversation-onboarding-publish'].includes(action)){r.question_states=clone(s.draft.question_states);if(action.endsWith('publish')){r.unresolved_questions=clone(s.draft.question_states.filter(q=>['pending','skipped','uncertain'].includes(q.status)));s.publication=clone(r);}}
      receipts.set(op,clone(r));
    }
    if(db.lose===action){db.lose=null;throw fail('SEMANTICA_CONNECTION_FAILED');}
    return clone(r);
  }
  return {call,calls,db,receipts,entries,onEnter:async(w,r)=>entries.push({w,r})};
}
