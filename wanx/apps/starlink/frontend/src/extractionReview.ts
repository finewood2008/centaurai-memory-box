import {requestJson} from './request.ts';
import {CorrectionError, correctionUrl} from './corrections.ts';

export type ReviewReference = {document_id:string;document_version_id:string;run_id:string;
  knowledge_generation:string|null;processing_generation:number|null};
export type ExtractionCounts = {adoptable_entity_count?:number;adoptable_relation_count?:number;excluded_candidate_count?:number};
export type CurrentExtraction = ExtractionCounts & {review_reference:ReviewReference;status:'awaiting_review';entity_count:number;relation_count:number;
  requires_adoption:true;requires_publication_confirmation:true};
export type ExtractionIssue={batch_index:number;stage:string;reason:string;audit_rounds:number;message:string};
export type ExtractionDetails={candidateCounts?:ExtractionCounts;blockers:Array<{code:string;message:string}>;issues:ExtractionIssue[];publication?:{id:string;entity_count?:number;relation_count?:number}|null;unavailable:boolean};
const countKeys=['adoptable_entity_count','adoptable_relation_count','excluded_candidate_count'] as const;
const validCount=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
const validOptionalCounts=(value:ExtractionCounts)=>countKeys.every(key=>!Object.hasOwn(value,key)||validCount(value[key]));

// A list total must come from the same run/revision without kind or search filters.
// Candidate counts describe adoption into a draft, never permission to publish.
export function extractionCandidatePresentation(current:CurrentExtraction,details:ExtractionDetails|null=null,listTotal:number|null=null){
  const total=current.entity_count+current.relation_count;
  const entities=current.adoptable_entity_count??details?.candidateCounts?.adoptable_entity_count;
  const relations=current.adoptable_relation_count??details?.candidateCounts?.adoptable_relation_count;
  const knownPresent=(entities??0)>0||(relations??0)>0;
  const adoptable=entities!==undefined&&relations!==undefined?entities+relations:listTotal===0&&!knownPresent?0:null;
  // Legacy lists can still contain rows with validation errors. A positive total
  // establishes presence only; it does not certify that every row is adoptable.
  const hasCandidates=adoptable!==null?adoptable>0:knownPresent||validCount(listTotal)&&listTotal>0;
  const excluded=current.excluded_candidate_count??details?.candidateCounts?.excluded_candidate_count;
  const emptyMessage=total===0?'本轮未抽取到候选，请检查材料正文和处理记录。':adoptable===0?
    '本轮候选均未通过证据或约束核验，暂无可采纳内容。请查看处理记录。':null;
  const counts=`本轮生成 ${total} 个候选，其中${adoptable===null?'可采纳数量暂不可用':` ${adoptable} 个可采纳`}、${excluded===undefined?'未通过核验数量暂不可用':`${excluded} 个未通过核验`}。`;
  const nextStep=emptyMessage??(!hasCandidates?'可采纳数量暂不可用，请刷新候选列表或查看处理记录。':'请先选择抽取候选，加入草稿并保存后再核对发布。');
  return {total,adoptable,excluded,counts,emptyMessage,nextStep};
}
const keys=['document_id','document_version_id','run_id','knowledge_generation','processing_generation'] as const;
export function validReviewReference(value:unknown,documentId:string):value is ReviewReference {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const r=value as ReviewReference;
  return Object.keys(r).length===keys.length&&keys.every(k=>Object.hasOwn(r,k))&&r.document_id===documentId&&
    [r.document_id,r.document_version_id,r.run_id].every(v=>typeof v==='string'&&v.length>0&&v.length<=200)&&
    (r.knowledge_generation===null||typeof r.knowledge_generation==='string'&&r.knowledge_generation.length>0)&&
    (r.processing_generation===null||Number.isSafeInteger(r.processing_generation)&&r.processing_generation>=0);
}
export function sameReviewReference(a:ReviewReference|null|undefined,b:ReviewReference|null|undefined){
  return !!a&&!!b&&keys.every(k=>a[k]===b[k]);
}
export function reviewChanged(){return new CorrectionError('本轮候选或草稿绑定已变化，请保留已保存内容并重新读取当前结果。','CORRECTION_REVIEW_CHANGED',409);}
const resumeKey=(workspace:string,document:string)=>JSON.stringify(['extraction-review',workspace,document]);
// A navigation hint only: never persist a lease or editor session. Server reads
// still enforce material/actor access. A current reference always takes priority.
export function rememberReviewDraft(workspace:string,document:string,draft:string){
  try{sessionStorage.setItem(resumeKey(workspace,document),draft);}catch{/* Storage may be unavailable. */}
}
export function rememberedReviewDraft(workspace:string,document:string){
  try{const id=sessionStorage.getItem(resumeKey(workspace,document));return id&&/^[A-Za-z0-9_-]{1,200}$/.test(id)?id:null;}catch{return null;}
}
export async function readCurrentExtraction(workspace:string,documentId:string,signal:AbortSignal):Promise<CurrentExtraction>{
  // Locate before creating an editor session. This GET needs material access,
  // not a lease, and must never infer a run from a historical publication.
  const result=await requestJson<CurrentExtraction>(correctionUrl(workspace,documentId,'/current-extraction'),{signal,cache:'no-store'});
  if(!result||!validReviewReference(result.review_reference,documentId)||result.status!=='awaiting_review'||
    ![result.entity_count,result.relation_count].every(validCount)||!validOptionalCounts(result)||
    result.requires_adoption!==true||result.requires_publication_confirmation!==true)
    throw new CorrectionError('当前候选引用响应无效，请重新读取。','SEMANTICA_INVALID_RESPONSE');
  return result;
}
export async function readExtractionDetails(workspace:string,current:CurrentExtraction,signal:AbortSignal):Promise<ExtractionDetails>{
  const ref=current.review_reference;
  const details:ExtractionDetails={blockers:[],issues:[],unavailable:false};
  try{
    const workflow=await requestJson<{document_id:string;document_version_id:string;
      extraction_review?:ExtractionCounts & {run_id:string;reason_code:string;message:string;issues:ExtractionIssue[];next_action:string}|null;
      publication:{id:string;status:string;document_version_id:string;entity_count?:number;relation_count?:number}|null}>(
      `/api/conversations/materials/${encodeURIComponent(ref.document_id)}?workspace_id=${encodeURIComponent(workspace)}`,{signal,cache:'no-store'});
    if(workflow.document_id!==ref.document_id||workflow.document_version_id!==ref.document_version_id)throw reviewChanged();
    const review=workflow.extraction_review;
    if(review===null||review&&review.run_id!==ref.run_id)throw reviewChanged();
    if(review){
      if(!validOptionalCounts(review))throw new CorrectionError('候选数量响应无效，请重新读取。','SEMANTICA_INVALID_RESPONSE');
      const counts:ExtractionCounts={};
      for(const key of countKeys)if(review[key]!==undefined)counts[key]=review[key];
      if(Object.keys(counts).length)details.candidateCounts=counts;
      details.blockers=[{code:review.reason_code,message:review.message}];
      details.issues=Array.isArray(review.issues)?review.issues.filter(v=>typeof v.message==='string'&&Number.isSafeInteger(v.batch_index)&&v.batch_index>=0):[];
    }else details.unavailable=true;
    const published=workflow.publication;
    if(!published)details.publication=null;
    else{
      if(published.status!=='published'||published.document_version_id!==ref.document_version_id)throw reviewChanged();
      details.publication={id:published.id};
      if([published.entity_count,published.relation_count].every(n=>Number.isSafeInteger(n)&&n!>=0))
        details.publication={...details.publication,entity_count:published.entity_count,relation_count:published.relation_count};
      // Candidate rows may consolidate into graph identities. Never substitute
      // their count for the service's committed publication counts.
      else details.unavailable=true;
    }
  }catch(reason){
    const error=reason as {code?:string;status?:number;name?:string};
    if(signal.aborted||error.name==='AbortError'||error.code==='CORRECTION_REVIEW_CHANGED'||[401,403,404].includes(error.status||0))throw reason;
    details.unavailable=true;
  }
  return details;
}
