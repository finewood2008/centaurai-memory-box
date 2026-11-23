import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CorrectionError, changedFields, correctionRequest, correctionUrl, editable, itemLabel, operationEnvelope, sourceLabel, swapDirection,
  type Change, type Item, type Page, type Preview, type Publication, type Receipt, type RecoverableDraft, type Source, type SelectedKnowledgeSource, type Summary, type Suggestions, type Suggestion } from "../corrections";
import "../corrections.css";
import { DesignIcon, WorkbenchDrawer } from "./WorkbenchUI";
import {newOntologyOperationId} from '../ontologySuggestions';
import MaterialRuleEditor from './MaterialRuleEditor';
import type {MaterialOntologyStatus} from './MaterialOntologyNotice';
import OntologyChangeSummary from './OntologyChangeSummary';
import type {OntologyDefinition} from '../ontology';
import {requestJson} from '../request';
import {ConfigurationDrawer} from './OntologyEditor';
import PublicationValidation from './PublicationValidation';
import {readBatchItems} from '../correctionBatch';
import {readCurrentExtraction, readExtractionDetails, extractionCandidatePresentation, sameReviewReference, reviewChanged, rememberReviewDraft, rememberedReviewDraft, type CurrentExtraction, type ExtractionDetails} from '../extractionReview';

/** Native document correction entry, also used to inspect a restored draft. */
export default function DocumentKnowledgeCorrections({ workspace, documentId, documentName, textEditing = false, draftId, targetOntologyId, onSessionChange, inline=false, materialStatus, onLeaveState, materialNotice, onSearch, selectedSource, reviewTarget }: {
  workspace: string; documentId: string; documentName: string; textEditing?: boolean; draftId?: string; targetOntologyId?:string; onSessionChange?:(open:boolean)=>void;
  inline?:boolean;materialStatus?:MaterialOntologyStatus;onLeaveState?:(value:{dirty:boolean;busy:boolean})=>void; materialNotice?:ReactNode;
  onSearch?:()=>void;
  selectedSource?:SelectedKnowledgeSource;
  reviewTarget?:'current-extraction';
}) {
  const [open, setOpen] = useState(false);
  const entry = useRef<HTMLButtonElement>(null);
  useLayoutEffect(()=>{
    if(!open)return;
    onSessionChange?.(true);
    return ()=>onSessionChange?.(false);
  },[open,onSessionChange]);
  if(inline)return <CorrectionSession key={`${workspace}:${documentId}`} workspace={workspace} documentId={documentId} documentName={documentName} close={()=>{}}
    inline materialStatus={materialStatus} onLeaveState={onLeaveState} textEditing={textEditing} materialNotice={materialNotice} onSearch={onSearch} selectedSource={selectedSource} reviewTarget={reviewTarget} />;
  return <div className="knowledge-correction-entry">
    <button ref={entry} type="button" disabled={textEditing} onClick={() => setOpen(true)}>{targetOntologyId?'按新本体核对':draftId ? '打开草稿核对' : '调整实体与关系'}</button>
    {open && <CorrectionSession key={`${workspace}:${documentId}:${draftId || ''}`} workspace={workspace} documentId={documentId} initialDraftId={draftId}
      documentName={documentName} targetOntologyId={targetOntologyId} close={() => { setOpen(false); entry.current?.focus(); }} />}
  </div>;
}

function CorrectionSession({ workspace, documentId, documentName, close, initialDraftId, targetOntologyId, inline=false, materialStatus, onLeaveState, textEditing=false, materialNotice, onSearch, selectedSource, reviewTarget }: {
  workspace: string; documentId: string; documentName: string; close: () => void; initialDraftId?: string; targetOntologyId?:string;
  inline?:boolean;materialStatus?:MaterialOntologyStatus;onLeaveState?:(value:{dirty:boolean;busy:boolean})=>void;textEditing?:boolean;materialNotice?:ReactNode;
  onSearch?:()=>void;
  selectedSource?:SelectedKnowledgeSource;
  reviewTarget?:'current-extraction';
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState<Page<Item> | null>(null);
  const [kind, setKind] = useState<"entity" | "relation">("entity");
  const [selected, setSelected] = useState<Item | null>(null);
  const [original, setOriginal] = useState<Item | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [recoverable, setRecoverable] = useState<RecoverableDraft[]>([]);
  const [leaseBlocked, setLeaseBlocked] = useState(false);
  const [sources, setSources] = useState<Page<Source> | null>(null);
  const [sourceWindow, setSourceWindow] = useState<Source | null>(null);
  const [picker, setPicker] = useState<"source_candidate_key" | "target_candidate_key" | null>(null);
  const [choices, setChoices] = useState<Page<Item> | null>(null);
  const [keyword, setKeyword] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [validationItems, setValidationItems] = useState<Item[] | null>(null);
  const [batchEditing, setBatchEditing] = useState(false);
  const [rulePreviewBase,setRulePreviewBase]=useState<OntologyDefinition>();
  const [publication, setPublication] = useState<Publication | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [extraction, setExtraction] = useState<CurrentExtraction | null>(null);
  const [extractionDetails,setExtractionDetails]=useState<ExtractionDetails|null>(null);
  const [candidateTotal,setCandidateTotal]=useState<number|null>(null);
  const extractionRef = useRef<CurrentExtraction | null>(null);
  const [bindingBlocked,setBindingBlocked]=useState(false);
  const [reviewUnavailable,setReviewUnavailable]=useState(false);
  const candidateSection = useRef<HTMLDetailsElement>(null);
  const [deferredCandidates, setDeferredCandidates] = useState<Set<string>>(new Set());
  const [newTypeKind,setNewTypeKind]=useState<'entity'|'relation'>();
  const newTypeSaving=useRef(false);
  const resumeAfterRules=useRef<{item:Item;original:Item|null;note:string;suffix:string}|null>(null);
  const [removal, setRemoval] = useState<Item[] | null>(null);
  const [events, setEvents] = useState<Array<{ id: number; draft_id: string; action: string; created_at: string; revision: number; note: string }>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [creating,setCreating]=useState(false);
  const [eventChanges, setEventChanges] = useState<{ id: number; page: Page<Change> } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const pending = useRef<{ suffix: string; body: unknown } | null>(null);
  const opening = useRef(newOntologyOperationId());
  const [ruleState,setRuleState]=useState({dirty:false,busy:false});
  const updateRuleState=useCallback((value:{dirty:boolean;busy:boolean})=>setRuleState(value),[]);
  const dirty = Boolean(selected && JSON.stringify(editable(selected)) !== JSON.stringify(original && editable(original)));
  const hasActualChanges=summary?(summary.has_changes??(summary.change_count>0||summary.ontology_changed===true?true:summary.ontology_changed===false?false:null)):null;
  // Older services can still publish an explicit rules draft; missing diff
  // metadata does not turn that draft into a known content change or no-op.
  const hasPendingChanges=hasActualChanges===true||Boolean(summary?.requires_source_review)||hasActualChanges===null&&summary?.ontology_status==='draft';
  const candidatePresentation=extraction?extractionCandidatePresentation(extraction,extractionDetails,candidateTotal):null;
  const candidateNextStep=candidatePresentation?.nextStep??'请先选择抽取候选，加入草稿并保存后再核对发布。';
  const locked = bindingBlocked || leaseBlocked || busy || textEditing || ruleState.dirty || ruleState.busy || Boolean(summary?.stale_reason) || summary?.status !== "editing" || pending.current !== null;
  const canReloadUnchangedDraft=summary?.status==='editing'&&summary.stale_reason==='CORRECTION_BASE_CHANGED'&&summary.change_count===0&&summary.ontology_status!=='draft'&&!summary.ontology_target;
  const lockedReason=busy?'正在处理，请稍候。':pending.current?'上次保存结果尚未确认，请返回核对面板重试原请求。':textEditing?'正在校对正文，请完成正文操作后再调整知识。':ruleState.busy?'正在保存类型规则，请稍候。':ruleState.dirty?'类型规则有未保存调整，请先返回类型建议保存或撤销。':summary?.stale_reason==='CORRECTION_BASE_CHANGED'?'已发布知识在此草稿创建后发生变化，旧草稿暂不可编辑，以免覆盖新的结果。':summary?.stale_reason==='STALE_DOCUMENT_VERSION'?'正文版本已更新，请先将草稿转到当前正文并重新核对来源。':summary?.stale_reason==='ONTOLOGY_TARGET_CHANGED'?'本体规则已更新，请先切换到当前发布规则并核对。':summary?.stale_reason?'草稿基础已变化，请返回核对面板处理后继续。':summary?.status==='submitted'?'此草稿已提交发布，不能继续修改。请返回核对面板查看发布进度。':summary?.status==='discarded'?'此草稿已放弃，请返回核对面板重新创建草稿。':'';
  useLayoutEffect(()=>{onLeaveState?.({dirty:dirty||ruleState.dirty||batchEditing,busy:busy||ruleState.busy||!!pending.current});
    return()=>onLeaveState?.({dirty:false,busy:false});},[dirty,ruleState,busy,batchEditing,onLeaveState]);
  const url = (suffix = "", query: Record<string, string | number> = {}) => correctionUrl(workspace, documentId, suffix, query);
  const request = <T,>(signal: AbortSignal, suffix = "", query: Record<string, string | number> = {}, body?: unknown) =>
    correctionRequest<T>(url(suffix, query), signal, body);

  async function run(action: (signal: AbortSignal) => Promise<unknown>) {
    if (controller.current || ruleState.busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setMessage("");
    try { await action(current.signal); }
    catch (reason) { if (!current.signal.aborted) {
      let recoveryError=reason;
      setError(reason instanceof Error ? reason.message : "操作失败，请重试");
      if(reason instanceof CorrectionError&&['CORRECTION_SUGGESTION_INVALID','CORRECTION_SUGGESTION_INCOMPLETE'].includes(reason.code)){
        setSuggestions(null);setCandidateTotal(null);setExtractionDetails(null);setPreview(null);
        let refreshMessage='候选列表已刷新。';
        try{
          if(extractionRef.current){
            const latest=await readCurrentExtraction(workspace,documentId,current.signal);
            if(!sameReviewReference(latest.review_reference,extractionRef.current.review_reference))throw reviewChanged();
            extractionRef.current=latest;setExtraction(latest);
            setExtractionDetails(await readExtractionDetails(workspace,latest,current.signal));
          }
          await showSuggestions(current.signal);
        }catch(refreshReason){
          recoveryError=refreshReason;
          refreshMessage='候选列表刷新失败，请重新读取候选后再操作。';
        }
        setError(`此候选未通过核验或内容不完整，不可采纳。${refreshMessage}`);
      }
      // Locator reads throw RequestError; draft requests throw CorrectionError.
      // A failure during rejection recovery must enforce the same guards as a
      // direct operation, rather than leave the previous editor unlocked.
      const failure=recoveryError as {code?:string;status?:number}|null;
      const recoveryBindingLost=recoveryError!==reason&&(failure?.code==='CORRECTION_REVIEW_NOT_READY'||[401,403,404].includes(failure?.status||0));
      if(failure?.code==='CORRECTION_REVIEW_CHANGED'||recoveryBindingLost){
        setBindingBlocked(true);setSuggestions(null);setCandidateTotal(null);
        setExtraction(null);setExtractionDetails(null);setPreview(null);
      }
      if (/CORRECTION_(LEASE_|SESSION_|CLAIM_|OCCUPIED)/.test(failure?.code||'')) {
        setLeaseBlocked(true);
        try { setRecoverable((await request<{items: RecoverableDraft[]}>(current.signal, '/leases')).items); } catch { /* Keep the original failure visible. */ }
      }
    } }
    finally { if (controller.current === current) { controller.current = null; setBusy(false); } }
  }
  async function readCandidateTotal(signal:AbortSignal,draftId:string,revision:number){
    const current=extractionRef.current;
    if(!current||current.adoptable_entity_count!==undefined&&current.adoptable_relation_count!==undefined)return null;
    try{
      // The visible list has a kind filter; only an unfiltered total can establish
      // that this entire extraction has no adoptable candidates on older services.
      const all=await request<Suggestions>(signal,`/${draftId}/extraction-results`,{revision,limit:1});
      if(all.revision!==revision||all.run_id!==current.review_reference.run_id)throw reviewChanged();
      return Number.isSafeInteger(all.total)&&all.total>=0?all.total:null;
    }catch(reason){
      if(signal.aborted||reason instanceof CorrectionError&&(reason.code==='CORRECTION_REVIEW_CHANGED'||[401,403,404].includes(reason.status)))throw reason;
      return null;
    }
  }
  async function load(signal: AbortSignal, draftId: string, nextKind = kind, offset = 0) {
    const value = await request<Summary>(signal, `/${draftId}`);
    if(value.id!==draftId||value.document_id!==documentId||extractionRef.current&&
      (!sameReviewReference(value.review_reference,extractionRef.current.review_reference)||value.document_version_id!==extractionRef.current.review_reference.document_version_id))throw reviewChanged();
    const items = await request<Page<Item>>(signal, `/${draftId}/items`, { revision: value.revision, kind: nextKind, offset });
    const candidates=inline&&value.status==='editing'&&!value.stale_reason?await request<Suggestions>(signal,`/${draftId}/extraction-results`,{revision:value.revision,kind:nextKind}):null;
    if(items.revision!==value.revision||candidates&&(candidates.revision!==value.revision||extractionRef.current&&candidates.run_id!==extractionRef.current.review_reference.run_id))throw reviewChanged();
    const total=candidates?await readCandidateTotal(signal,draftId,value.revision):null;
    setPublication(value.status === 'submitted' ? await request<Publication>(signal, `/${draftId}/publication`) : null);
    setSummary(value); setPage(items); setKind(nextKind); setSources(null); setSourceWindow(null); setPreview(null); setValidationItems(null);
    setSelected(null); setOriginal(null); setRemoval(null); setPicker(null); setNote("");
    setLeaseBlocked(false); setRecoverable([]);setBindingBlocked(false);
    setSuggestions(candidates);setCandidateTotal(total);
    return value;
  }
  async function openDraft(signal: AbortSignal, resume = true) {
    if(pending.current){await write(signal,pending.current.suffix,pending.current.body);return;}
    if (initialDraftId && resume) { await load(signal, initialDraftId); return; }
    if(inline&&!targetOntologyId){
      if(!extractionRef.current){
        try{
          const current=await readCurrentExtraction(workspace,documentId,signal);
          const details=await readExtractionDetails(workspace,current,signal);
          setReviewUnavailable(false);
          extractionRef.current=current;setExtraction(current);
          setExtractionDetails(details);
        }catch(reason){
          if(!(reason instanceof Error&&'code' in reason&&reason.code==='CORRECTION_REVIEW_NOT_READY'))throw reason;
          const previous=rememberedReviewDraft(workspace,documentId);
          if(previous){
            const saved=await request<Summary>(signal,`/${previous}`);
            if(saved.status==='submitted'&&saved.review_reference){
              const record=await request<Publication>(signal,`/${previous}/publication`);
              if(record.effective||['queued','running'].includes(record.status)){
                await load(signal,previous);return;
              }
            }
          }
          if(reviewTarget==='current-extraction'){setReviewUnavailable(true);throw reason;}
        }
      }
      if(extractionRef.current){
        await write(signal,'/current-extraction/draft',{operation_id:opening.current,review_reference:extractionRef.current.review_reference});
        return;
      }
    }
    if (resume) {
      const available = (await request<{items: RecoverableDraft[]}>(signal, '/leases')).items;
      const submitted = available.find(d => d.status === 'submitted' && !d.legacy_unowned);
      if (submitted) { await load(signal, submitted.draft_id); return; }
      if (available.length && available.every(d => d.suspended)) {
        setRecoverable(available); setLeaseBlocked(true); setMessage('有已保存的暂停草稿，可以恢复后继续核对。'); return;
      }
    }
    await write(signal, "", { operation_id: opening.current });
  }
  function startNewItem(){
    if(locked||!summary||!leaveLocal())return;
    void run(async signal=>{
      let source:Source|undefined;
      if(inline&&kind==='entity'&&selectedSource){
        if(selectedSource.documentId!==documentId||selectedSource.versionId!==summary.document_version_id)
          throw new Error('正文版本已变化，请刷新核对结果后重试。');
        source=await request<Source>(signal,`/${summary.id}/sources/${encodeURIComponent(selectedSource.segmentId)}`,{revision:summary.revision,start:selectedSource.start??0});
        if(selectedSource.end!==undefined&&selectedSource.end<source.end){source.text=Array.from(source.text).slice(0,Math.max(0,selectedSource.end-source.start)).join('');source.end=selectedSource.end;}
        if(!source.text.trim())throw new Error('此来源没有可引用的正文，请选择其他片段。');
      }
      setCreating(true);setOriginal(null);setNote(source?'依据正文片段新增实体':'');setRemoval(null);setPicker(null);setPreview(null);setSources(null);setSourceWindow(source??null);
      setSelected({id:newOntologyOperationId(),kind,payload:kind==='entity'?{name:'',type:'',aliases:[],properties:{}}:{type:'',source_candidate_key:'',target_candidate_key:'',properties:{}},
        evidence:source?[{segment_id:source.segment_id,document_id:documentId,document_version_id:summary.document_version_id,start:source.start,end:source.end,excerpt:source.text,locator:source.locator}]:[],review_note:''});
      setEditorOpen(true);
    });
  }
  useEffect(() => { void run(openDraft); return () => { const current = controller.current; controller.current = null; current?.abort(); }; }, []);
  useEffect(() => {
    if (!summary || summary.status !== 'editing' || leaseBlocked) return;
    const heartbeat = new AbortController();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible' || controller.current || ruleState.busy) return;
      void request<Receipt>(heartbeat.signal, `/${summary.id}/heartbeat`, {}, {
        operation_id: newOntologyOperationId(), expected_revision: summary.revision,
      }).catch(async reason => {
        if (heartbeat.signal.aborted) return;
        if (reason instanceof CorrectionError && reason.status >= 400 && reason.status < 500) {
          setLeaseBlocked(true); setError(reason.message);
          try { setRecoverable((await request<{items: RecoverableDraft[]}>(heartbeat.signal, '/leases')).items); } catch { /* Explicit refresh remains available. */ }
        }
      });
    }, 60000);
    return () => { clearInterval(timer); heartbeat.abort(); };
  }, [summary?.id, summary?.revision, summary?.status, leaseBlocked, ruleState.busy]);
  useEffect(()=>{
    if(!inline||summary||busy||textEditing||leaseBlocked||error||pending.current)return;
    const timer=setTimeout(()=>void run(openDraft),5000);
    return()=>clearTimeout(timer);
  },[inline,summary,busy,textEditing,leaseBlocked,error]);
  useEffect(()=>{if(extraction&&summary?.status==='editing'&&candidateSection.current)candidateSection.current.open=true;},[extraction?.review_reference.run_id,summary?.id]);
  useEffect(() => { if(!inline)dialog.current?.focus(); }, []);
  useEffect(() => {
    if (!summary || !publication || !['queued', 'running'].includes(publication.status)) return;
    const poll = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { setPublication(await request<Publication>(poll.signal, `/${summary.id}/publication`)); }
      catch { /* Explicit refresh remains available after a transient failure. */ }
      if (!poll.signal.aborted) timer = setTimeout(refresh, 3000);
    };
    timer = setTimeout(refresh, 3000);
    return () => { clearTimeout(timer); poll.abort(); };
  }, [summary?.id, publication?.status]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || ruleState.dirty || ruleState.busy || batchEditing || pending.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty,ruleState.dirty,ruleState.busy,batchEditing]);
  function leaveLocal() { return (!dirty && !pending.current) || window.confirm(pending.current ? "保存结果尚未确认，关闭后请重新打开核对。是否关闭？" : "当前条目有未保存修改，是否放弃这些修改？"); }
  function select(item: Item) {
    if (!leaveLocal()) return;
    setCreating(false);setEditorOpen(true);setSources(null);setSourceWindow(null);
    setSelected(structuredClone(item)); setOriginal(structuredClone(item)); setNote(""); setRemoval(null); setPicker(null); setPreview(null);
  }
  function reloadUnchangedDraft(){
    if(!summary||!canReloadUnchangedDraft||busy||textEditing||ruleState.dirty||ruleState.busy||dirty||pending.current)return;
    if(!window.confirm('当前草稿没有已保存修改。放弃此旧草稿并重新载入当前已发布知识？修改记录保留，不会重新抽取或发布。'))return;
    void run(async signal=>{
      await write(signal,`/${summary.id}/discard`,{operation_id:newOntologyOperationId(),expected_revision:summary.revision,note:'无已保存修改，重新载入当前已发布知识'});
      opening.current=newOntologyOperationId();await openDraft(signal,false);setEditorOpen(false);
      setMessage('已载入当前已发布知识，请重新选择实体或关系进行调整。');
    });
  }
  function update(item: Item) { setSelected({ ...item, review_note: "" }); setMessage(""); }
  function payload(key: string, value: unknown) { if (selected) update({ ...selected, payload: { ...selected.payload, [key]: value } }); }
  async function write(signal: AbortSignal, suffix: string, body: unknown) {
    pending.current = { suffix, body };
    let receipt: Receipt;
    try { receipt = await request<Receipt>(signal, suffix, {}, body); }
    catch (reason) { if (reason instanceof CorrectionError && (reason.status >= 400 && reason.status < 500 || ['CORRECTION_SUGGESTION_INVALID','CORRECTION_SUGGESTION_INCOMPLETE'].includes(reason.code))) {pending.current = null;resumeAfterRules.current=null;} throw reason; }
    if(suffix.endsWith('/claim')&&extractionRef.current){
      pending.current=null;
      // Claim is an explicit user decision; only then bind/resume the current run.
      await openDraft(signal,false);return;
    }
    if(suffix==='/current-extraction/draft'&&!sameReviewReference(receipt.review_reference,extractionRef.current?.review_reference))throw reviewChanged();
    await load(signal, receipt.draft_id);
    if(extractionRef.current)rememberReviewDraft(workspace,documentId,receipt.draft_id);
    pending.current = null;
    if(resumeAfterRules.current?.suffix===suffix){
      const resume=resumeAfterRules.current;resumeAfterRules.current=null;
      setSelected(resume.item);setOriginal(resume.original);setNote(resume.note);setKind(resume.item.kind);setEditorOpen(true);setNewTypeKind(undefined);
    }
    setMessage(receipt.status === 'submitted' ? '已提交后台发布。任务成功后，新结果才会用于检索。' : receipt.status === "discarded" ? "草稿已放弃，当前检索内容保持不变。" : "草稿已保存，尚未发布；当前检索内容保持不变。");
  }
  async function save(signal: AbortSignal, removeIds: string[] = []) {
    if (!summary || !selected) return;
    const upserts = removeIds.length ? [] : [selected];
    await write(signal, `/${summary.id}/save`, operationEnvelope(summary.revision, upserts, removeIds, note, newOntologyOperationId()));
  }
  async function remove(signal: AbortSignal) {
    if (!summary || !selected) return;
    const related: Item[] = [];
    if (selected.kind === "entity") {
      let offset = 0, total = 1;
      while (offset < total) {
        const result = await request<Page<Item>>(signal, `/${summary.id}/items/${selected.id}/relations`, { revision: summary.revision, offset, limit: 50 });
        total = result.total; related.push(...result.items); offset += result.items.length;
        if (total > 99) { throw new Error("关联关系超过单次保存范围，请先分批调整关系，再移除此实体。"); }
      }
    }
    setRemoval(related);
  }
  async function evidence(signal: AbortSignal, offset = 0) {
    if (summary) { setSourceWindow(null); setSources(await request<Page<Source>>(signal, `/${summary.id}/sources`, { revision: summary.revision, offset, limit: 5 })); }
  }
  function attach(source: Source) {
    if (!selected || !summary) return;
    if (selected.evidence.length >= 8) { setError("最多保留 8 条来源，请先移除不需要的依据。"); return; }
    if (selected.evidence.some(e => e.segment_id === source.segment_id && e.start === source.start && e.end === source.end)) return;
    update({ ...selected, evidence: [...selected.evidence, { segment_id: source.segment_id, document_id: documentId,
      document_version_id: summary.document_version_id, start: source.start, end: source.end, excerpt: source.text, locator: source.locator }] });
  }
  async function choose(signal: AbortSignal, field: "source_candidate_key" | "target_candidate_key", offset = 0) {
    if (!summary) return;
    setPicker(field); setChoices(await request<Page<Item>>(signal, `/${summary.id}/items`, { revision: summary.revision, kind: "entity", keyword, offset }));
  }
  async function showPreview(signal: AbortSignal, offset = 0) {
    if(!summary)return;
    setValidationItems(null);
    if(summary.ontology_status==='draft'){
      const rules=await requestJson<{items:Array<{status:string;schema:OntologyDefinition}>}>(`/api/ontologies?workspace_id=${encodeURIComponent(workspace)}`,{signal});
      setRulePreviewBase(rules.items.find(item=>item.status==='published')?.schema);
    }else setRulePreviewBase(undefined);
    const result=await request<Preview>(signal, `/${summary.id}/preview`, { revision: summary.revision, offset });
    setPreview(result);
    if(result.issues.length)setValidationItems(await readBatchItems(pageOffset=>request<Page<Item>>(signal,`/${summary.id}/items`,{revision:result.revision,offset:pageOffset,limit:50}),result.revision));
  }
  async function inspectValidationItem(signal: AbortSignal, id: string) {
    if (!summary) return;
    const revision = summary.revision;
    const item = await request<Item>(signal, `/${summary.id}/items/${encodeURIComponent(id)}`, {revision});
    // Keep item contents and the editing revision from the same snapshot.
    const latest = await load(signal, summary.id, item.kind);
    if (latest.revision !== revision || latest.stale_reason) throw new Error('草稿已变化，请刷新后重新核对。');
    setKind(item.kind); setPreview(null); setCreating(false); setEditorOpen(true);
    setSelected(structuredClone(item)); setOriginal(structuredClone(item)); setNote(''); setSources(null); setSourceWindow(null);
  }
  function returnToCandidates() {
    if (locked || dirty || batchEditing) return;
    setPreview(null); setRulesOpen(false);
    void run(async signal => {
      await showSuggestions(signal);
      requestAnimationFrame(() => {
        const section = candidateSection.current;
        if (section) { section.open = true; section.scrollIntoView({block:'start'}); section.querySelector('summary')?.focus(); }
      });
    });
  }
  function relocateCandidates(){
    if(busy||dirty||ruleState.dirty||ruleState.busy||batchEditing||pending.current)return;
    extractionRef.current=null;setExtraction(null);setExtractionDetails(null);setCandidateTotal(null);
    opening.current=newOntologyOperationId();
    // Keep the old saved draft locked until a newly validated load succeeds.
    void run(signal=>openDraft(signal,false));
  }
  async function showSuggestions(signal: AbortSignal, offset = 0) {
    if (summary) {
      const value=await request<Suggestions>(signal, `/${summary.id}/${inline?'extraction-results':'suggestions'}`, { revision: summary.revision, offset,kind });
      if(value.revision!==summary.revision||extractionRef.current&&value.run_id!==extractionRef.current.review_reference.run_id)throw reviewChanged();
      const total=inline?await readCandidateTotal(signal,summary.id,summary.revision):null;
      setSuggestions(value);setCandidateTotal(total);
    }
  }
  function adoptSuggestion(suggestion: Suggestion, replace = false) {
    if (!summary || !suggestions?.run_id) return;
    const target = replace ? selected?.id : undefined;
    if (!window.confirm(`${replace ? '用此建议替换当前选中的草稿条目' : '将此建议加入草稿'}？${suggestion.proposal.kind === 'relation' ? '关系包含其端点实体，已加入草稿的端点修改会保留。' : ''} 保存后仍需核对并确认发布。`)) return;
    void run(signal => write(signal, `/${summary.id}/${inline?'extraction-results':'suggestions'}/adopt`, { operation_id: newOntologyOperationId(),
      expected_revision: summary.revision, run_id: suggestions.run_id, candidate_id: suggestion.candidate_id, target_item_id: target }));
  }
  function editCandidate(suggestion: Suggestion) {
    if (locked || dirty || suggestion.already_added) return;
    setCreating(false);setSourceWindow(null);setSelected(structuredClone(suggestion.proposal)); setOriginal(null); setKind(suggestion.proposal.kind);
    setNote(`修正抽取候选 ${suggestions?.run_id}/${suggestion.candidate_id}`);
    setRemoval(null); setPicker(null); setPreview(null); setSources(null); setEditorOpen(true);
  }
  function saveNewType(schema:OntologyDefinition){
    if(!summary||!selected||!newTypeKind||newTypeSaving.current||busy||controller.current||ruleState.busy||pending.current)return;
    newTypeSaving.current=true;
    const added=(newTypeKind==='entity'?schema.entity_types:schema.relation_types).at(-1)!;
    void run(async signal=>{
      try{
        const rules=await requestJson<{items:Array<{id:string;status:string}>}>(`/api/ontologies?workspace_id=${encodeURIComponent(workspace)}`,{signal});
        const base=rules.items.find(item=>item.status==='published');if(!base)throw new Error('请先发布基础类型规则，再新增类型。');
        const suffix=`/${summary.id}/rules`;
        resumeAfterRules.current={item:{...structuredClone(selected),payload:{...structuredClone(selected.payload),type:added.name},review_note:''},original:original?structuredClone(original):null,note,suffix};
        await write(signal,suffix,{operation_id:newOntologyOperationId(),expected_revision:summary.revision,base_ontology_id:base.id,schema,preview_ids:[],reviewed_preview_ids:[]});
        setMessage('新类型已保存为待发布规则，已选回当前条目。请核对属性并保存草稿，最后统一发布。');
      }finally{newTypeSaving.current=false;}
    });
  }
  async function history(signal: AbortSignal, more = false) {
    const value = await request<{ items: typeof events }>(signal, "/events", { after_id: more ? events.at(-1)?.id ?? 0 : 0, limit: 20 });
    setEvents(old => more ? [...old, ...value.items] : value.items); setHistoryOpen(true);
  }
  const definitions = selected && summary ? (selected.kind === "entity" ? summary.ontology.entity_types : summary.ontology.relation_types) : [];
  const definition = definitions.find(d => d.name === selected?.payload.type);
  const properties = (selected?.payload.properties ?? {}) as Record<string, unknown>;
  function lockNotice(inEditor=false){
    if(!locked||!summary)return null;
    return <div className="correction-warning editor-lock-notice" role="status"><p>{lockedReason}</p>
      {canReloadUnchangedDraft&&<button disabled={busy||ruleState.dirty||ruleState.busy||textEditing||dirty||!!pending.current} onClick={reloadUnchangedDraft}>重新载入当前知识</button>}
      {summary.stale_reason==='CORRECTION_BASE_CHANGED'&&!canReloadUnchangedDraft&&<p>请在“草稿操作与修改记录”中核对已有知识或规则调整，再决定如何处理旧草稿。</p>}
      {inEditor&&inline&&!busy&&!ruleState.busy&&<button onClick={()=>{if(leaveLocal()){setSelected(original?structuredClone(original):null);setEditorOpen(false);}}}>返回核对面板</button>}
    </div>;
  }
  const sourceChoices = summary && <><h3>原文对照</h3>{!sources && <p>点击“选择来源依据”，按需读取当前文档的来源片段。</p>}
    {(sourceWindow ? [sourceWindow] : sources?.items ?? []).map(source => <article className="correction-source" key={`${source.segment_id}:${source.start}`}><strong>{sourceLabel(source.locator, source.ordinal)}</strong><p>{source.text}</p>
      <button disabled={locked || !selected} onClick={() => attach(source)}>选为依据</button>
      {source.end < source.total_chars && <button disabled={busy} onClick={() => void run(async signal => setSourceWindow(await request<Source>(signal, `/${summary.id}/sources/${source.segment_id}`, { revision: summary.revision, start: source.end })))}>继续阅读此片段</button>}
      {source.start > 0 && <button disabled={busy} onClick={() => void run(async signal => setSourceWindow(await request<Source>(signal, `/${summary.id}/sources/${source.segment_id}`, { revision: summary.revision, start: Math.max(0, source.start - 2000) })))}>上一段原文</button>}</article>)}
    {sourceWindow && <button onClick={() => setSourceWindow(null)}>返回来源列表</button>}{sources && <Pager page={sources} disabled={busy} go={offset => void run(signal => evidence(signal, offset))} />}
    {inline && <button onClick={() => { setSources(null); setSourceWindow(null); }}>收起来源选择</button>}
  </>;
  const editorContent = summary ? <>
          <main>{!selected ? <p>选择条目进行调整，或新增漏抽的实体与关系。</p> : <><h3>{creating ? (selected.kind === "entity" ? "新增实体" : "新增关系") : (selected.kind === "entity" ? "实体调整" : "关系调整")}</h3>
            {lockNotice(true)}
            <fieldset disabled={locked}>
            {selected.kind === "entity" && <p className="muted">对象是原文中的具体事物；对象类型是对这类事物的抽象分类。修改只在保存到草稿后记录，发布后才用于知识网络。</p>}
            <div className={selected.kind === 'entity' ? 'correction-identity' : undefined}>
            {selected.kind === "entity" && <label>对象名称（规范名称）<input value={String(selected.payload.name ?? "")} onChange={e => payload("name", e.target.value)} maxLength={300} /></label>}
            <label>{selected.kind === 'entity' ? '对象类型（抽象分类）' : '关系类型'}<select value={String(selected.payload.type ?? "")} onChange={e => {if(e.target.value==='__new_type__')setNewTypeKind(selected.kind);else payload("type", e.target.value);}}><option value="">请选择类型</option>{Boolean(selected.payload.type)&&!definition&&<option value={String(selected.payload.type)}>未定义：{String(selected.payload.type)}（请配置或改用已有类型）</option>}{definitions.map(d => <option value={d.name} key={d.name}>{d.label}（{d.name}）</option>)}{inline&&<option value="__new_type__">新增{selected.kind==='entity'?'实体':'关系'}类型…</option>}</select></label>
            </div>
            <section className="correction-evidence"><h4>来源依据</h4><p>规范名称可以与原文提及不同；引用内容保留原文。</p>
              {inline && sources && <div className="correction-source-picker">{sourceChoices}</div>}
              {selected.evidence.map((e, index) => <article className="correction-quote" key={index}><div className="correction-source-actions"><span>{sourceLabel(e.locator ?? {})}</span><button onClick={() => update({ ...selected, evidence: selected.evidence.filter((_, i) => i !== index) })}>移除此引用</button><button onClick={() => void run(signal => evidence(signal))}>选择来源依据</button></div><blockquote>{e.excerpt || "该引用需要重新选择有效来源"}</blockquote></article>)}
              {!selected.evidence.length && <button onClick={() => void run(signal => evidence(signal))}>选择来源依据</button>}
            </section>
            {selected.kind === "entity" ? <label>别名（每行一个）<textarea value={Array.isArray(selected.payload.aliases) ? selected.payload.aliases.join("\n") : ""} onChange={e => payload("aliases", e.target.value ? e.target.value.split("\n") : [])} /></label>
              : <div className="correction-endpoints">{(["source_candidate_key", "target_candidate_key"] as const).map(field => <div key={field}><span>{field === "source_candidate_key" ? "起点" : "终点"}：{selected.endpoints?.[field]?.name ?? "尚未选择"}</span><button onClick={() => { setKeyword(""); void run(signal => choose(signal, field)); }}>选择{field === "source_candidate_key" ? "起点" : "终点"}</button></div>)}
                <button onClick={() => setSelected({ ...swapDirection(selected), endpoints: { source_candidate_key: selected.endpoints?.target_candidate_key!, target_candidate_key: selected.endpoints?.source_candidate_key! } })}>交换方向</button></div>}
            <h4>{selected.kind === 'entity' ? '对象属性' : '关系属性'}</h4>
            {!definition?.properties.length && !Object.keys(properties).length && <p>当前类型尚未定义属性。需要记录业务属性时，请先在类型定义中补充；不要把原文中的日期或角色自动当作新类型。</p>}
            {definition?.properties.map(property => <div key={property.name}><label>{property.label}{property.required ? "（必填）" : ""}<PropertyInput value={properties[property.name] ?? ""} change={value => payload("properties", { ...properties, [property.name]: value })} /></label></div>)}
            {Object.keys(properties).filter(key => !definition?.properties.some(p => p.name === key)).map(key => <div key={key}><label>当前类型未定义的属性：{key}<PropertyInput value={properties[key]} change={value => payload("properties", { ...properties, [key]: value })} /></label><p className="muted">需改用已定义属性或补充类型定义，保存后仍需通过校验。</p><button onClick={() => { const next = { ...properties }; delete next[key]; payload("properties", next); }}>移除此属性</button></div>)}
            <label>语义复核说明<textarea value={selected.review_note ?? ""} maxLength={2000} onChange={e => setSelected({ ...selected, review_note: e.target.value })} placeholder="出现语义提示且仍需保留时，说明原文依据" /></label>
            <label>本次修改说明（选填）<textarea value={note} maxLength={2000} onChange={e => setNote(e.target.value)} /></label>
            <div className="correction-toolbar"><button onClick={() => void run(signal => save(signal))}>保存草稿</button>{original && <><button onClick={() => { if (window.confirm("撤销此条目自基线以来的修改？")) void run(signal => write(signal, `/${summary.id}/items/${selected.id}/reset`, { operation_id: newOntologyOperationId(), expected_revision: summary.revision, note })); }}>撤销条目修改</button><button onClick={() => void run(remove)}>移除条目</button></>}</div></fieldset>
            {(original?.issues ?? []).map((issue, i) => <p key={i} className={`correction-${issue.severity}`}>{issue.message}</p>)}
            {dirty && <p>当前修改尚未保存，保存后重新检查本体、关联关系与来源。</p>}
            {removal && <div className="correction-warning"><h4>确认移除</h4><p>{removal.length ? `这会影响 ${removal.length} 条关系。可先返回逐条调整端点，或明确一并移除。` : "将从本篇文档的草稿中移除此条目。"}</p>{removal.map(i => <p key={i.id}>{itemLabel(i)}</p>)}
              <button disabled={locked} onClick={() => void run(signal => save(signal, [selected.id, ...removal.map(i => i.id)]))}>{removal.length ? "一并移除实体与这些关系" : "确认移除条目"}</button><button onClick={() => setRemoval(null)}>返回调整</button></div>}</>}
            {picker && choices && <section className="correction-picker"><h4>选择{picker === "source_candidate_key" ? "起点" : "终点"}实体</h4><label>查找实体<input value={keyword} onChange={e => setKeyword(e.target.value)} /></label><button disabled={busy} onClick={() => void run(signal => choose(signal, picker))}>查找</button>
              {choices.items.map(item => <button key={item.id} disabled={locked} onClick={() => { if (selected) update({ ...selected, payload: { ...selected.payload, [picker]: item.id }, endpoints: { ...selected.endpoints, [picker]: { id: item.id, name: String(item.payload.name), type: String(item.payload.type) } } }); setPicker(null); }}>{String(item.payload.name)} · {String(item.payload.type)}<small>{item.evidence[0]?.excerpt?.slice(0, 80)}</small></button>)}
              <Pager page={choices} disabled={busy} go={offset => void run(signal => choose(signal, picker, offset))} /><button onClick={() => setPicker(null)}>关闭选择</button></section>}
          </main>{!inline && <aside>{sourceChoices}</aside>}
  </> : null;
  return <section ref={dialog} tabIndex={-1} className={inline?'material-knowledge-review':'correction-overlay'} role={inline?'region':'dialog'} aria-modal={inline?undefined:true} aria-label={inline?'材料知识核对':'调整实体与关系'} onKeyDown={event => {
    const nestedDialog=event.target instanceof Element?event.target.closest('dialog'):null;
    if(inline || nestedDialog&&event.currentTarget.contains(nestedDialog))return;
    if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); if (leaveLocal()) close(); }
    if (event.key === "Tab") {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') ?? [])].filter(node => node.offsetParent !== null && !node.closest('fieldset:disabled') && (!node.closest('dialog')||!event.currentTarget.contains(node.closest('dialog'))));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <div className="correction-workbench"><header><div><h2>{inline?'知识核对':'调整实体与关系'}</h2><p>{documentName}</p></div>
      {inline ? <button className="icon-button" aria-label="修改记录" title="修改记录" disabled={busy || ruleState.busy} onClick={() => void run(signal => history(signal))}><DesignIcon name="history" /></button> : <button disabled={busy} onClick={() => { if (leaveLocal()) close(); }}>关闭</button>}</header>
      <p className={inline ? 'correction-scope' : ''}>{inline && <DesignIcon name="info" />}<span>草稿不影响已发布知识。{summary ? `当前草稿：${summary.counts.entity} 个实体 / ${summary.counts.relation} 条关系。` : error ? '知识草稿未载入，请查看下方提示。' : '正在读取本篇知识…'}{summary?.ontology_target && ` 按类型规则 v${summary.ontology_target.version_number} 核对。`}</span></p>
      {extraction&&summary?.status!=='submitted'&&<section className="review-next-step" aria-label="自动抽取结果待核对"><h3>自动抽取结果待核对</h3>
        <p><strong>当前已发布结果：</strong>{extractionDetails?.publication?extractionDetails.publication.entity_count!==undefined&&extractionDetails.publication.relation_count!==undefined?`${extractionDetails.publication.entity_count} 个实体 / ${extractionDetails.publication.relation_count} 条关系，仍然有效。`:'已有发布结果仍然有效，数量暂未返回。':extractionDetails?.publication===null?'尚无已发布结果。':'发布结果数量暂未读取成功。'}确认发布成功前保持不变。</p>
        <p><strong>本轮候选：</strong>{candidatePresentation?.counts}（全部候选：{extraction.entity_count} 个实体 / {extraction.relation_count} 条关系。）</p>
        <p>可采纳表示可以加入草稿，其中仍可能包含需要人工核对的不确定关系；能否发布以服务端发布预览的校验结果为准。</p>
        <div aria-label="未自动发布原因"><strong>本轮未自动发布原因：</strong>{extractionDetails?.blockers.length?extractionDetails.blockers.map((reason,index)=><p key={index}>{reason.message}{reason.code&&<small>（{reason.code}）</small>}</p>):<p>服务端要求人工核对，暂未返回具体拦截原因。可以查看候选；不会自动重新抽取或发布。</p>}</div>
        {!!extractionDetails?.issues.length&&<ul aria-label="完整性检查原因">{extractionDetails.issues.map((issue,index)=><li key={index}>第 {issue.batch_index+1} 批 · {({entities:'实体抽取',relations:'关系抽取',joint:'联合抽取'} as Record<string,string>)[issue.stage]||'抽取'}：{issue.message}（{issue.reason}）</li>)}</ul>}
        {(!extractionDetails||extractionDetails.unavailable||!extractionDetails.blockers.length)&&<button disabled={busy||dirty||!!pending.current} onClick={()=>void run(async signal=>setExtractionDetails(await readExtractionDetails(workspace,extraction,signal)))}>重新读取原因与发布结果</button>}
        <p><strong>草稿实际变更：</strong>{summary?`${summary.change_count} 项知识变更${summary.ontology_changed===true?'，另含规则变更':''}。`:'正在读取草稿变更。'}{hasActualChanges===false&&'尚未修改已发布内容。'}{summary&&hasActualChanges===null&&'草稿状态待确认，服务端尚未返回完整变更信息。'}{!hasPendingChanges&&candidateNextStep}</p>
      </section>}
      {inline&&summary?.status==='editing'&&!summary.stale_reason&&<button disabled={locked || dirty || batchEditing} onClick={returnToCandidates}>查看抽取候选</button>}
      {inline&&summary&&<div className="review-next-step" aria-label="本篇核对下一步"><strong>{summary.status==='editing'&&summary.stale_reason?'草稿基础已变化，请先处理':publication?.effective?'知识已发布，可以验证检索':hasPendingChanges?'有待发布修改，请先核对':extraction||suggestions?.total?candidateNextStep:'当前草稿没有待发布修改'}</strong>
        <p>{summary.status==='editing'&&summary.stale_reason?'请先处理下方草稿状态提示，再新增或调整实体与关系。原草稿已保留，不会自动覆盖。':hasPendingChanges?'先修正对象与关系、保存草稿，再点击“核对并发布”。类型定义与材料中的具体对象分别核对。':extraction?candidateNextStep:'下方实体和关系数量属于当前草稿。请先查看抽取候选并选择加入草稿，再核对发布；无需为了启用发布按钮随意编辑已有条目。'}</p>
        {onSearch&&<button disabled={busy||ruleState.busy||!!pending.current} onClick={onSearch}>验证本篇检索</button>}
        <button disabled={busy||dirty||ruleState.dirty||ruleState.busy||!!pending.current} onClick={()=>void run(signal=>load(signal,summary.id))}>刷新核对结果</button>
      </div>}
      {inline && summary && <div className="review-tabs" role="tablist" aria-label="知识核对内容">
        {(['entity','relation'] as const).map(tab => <button key={tab} role="tab" aria-selected={!rulesOpen && kind === tab} disabled={busy || ruleState.busy || ruleState.dirty || !!pending.current} onClick={() => {
          if (!leaveLocal()) return; setRulesOpen(false); setEditorOpen(false); void run(signal => load(signal, summary.id, tab));
        }}>{tab === 'entity' ? '实体' : '关系'} {summary.counts[tab]}</button>)}
        <button role="tab" aria-selected={rulesOpen} disabled={busy || !!pending.current} onClick={() => { if (leaveLocal()) { setSelected(original ? structuredClone(original) : null); setEditorOpen(false); setRulesOpen(true); } }}>类型建议 {materialStatus?.count ?? 0}</button>
      </div>}
      {inline&&summary&&!rulesOpen&&<section className="review-item-actions" aria-label="新增知识对象">
        {(!editorOpen||!selected)&&lockNotice()}
        <button disabled={locked} onClick={startNewItem}>新增{kind==='entity'?'实体':'关系'}</button>
        {!locked&&summary.counts.entity===0&&summary.counts.relation===0&&<p>{extraction?candidateNextStep:'暂无实体和关系，可以根据左侧原文手动新增实体，再按原文依据补充关系。'}</p>}
        {kind==='entity'&&<div className="review-selected-source"><strong>{selectedSource?`当前来源：${selectedSource.label}`:'尚未选择来源片段'}</strong>
          {selectedSource?.text&&<p>{selectedSource.text.slice(0,140)}{selectedSource.text.length>140?'…':''}</p>}
          <small>{selectedSource?'新增实体会带入此来源，保存草稿时同时建立来源映射。调整已有条目会保留它原有的来源。':'可先在正文选择片段，或在新增窗口中选择来源依据。'}</small></div>}
      </section>}
      {summary?.restored_from && <p className="correction-warning">此草稿从发布版本 v{summary.restored_from.version_number} 恢复知识。请按当前正文和本体核对，确认发布后才会生效。</p>}
      {error && <p role="alert" className="correction-error">{error}</p>}
      {bindingBlocked&&summary&&<div className="correction-warning" role="status">本轮候选绑定已变化，已保存草稿保持保留。请重新读取当前候选；草稿是否可继续编辑仍由服务端校验。
        <button disabled={busy||dirty||ruleState.dirty||ruleState.busy||batchEditing||!!pending.current} onClick={relocateCandidates}>重新定位当前候选</button>
      </div>}
      {reviewUnavailable&&!summary&&<p role="status">当前没有可核对的抽取候选，无需进行批量处理。请重新读取处理结果，或返回资料管理查看材料状态；已有发布结果保持不变。</p>}
      {leaseBlocked && <section className="correction-warning" aria-label="恢复编辑草稿">
        <p>已有保存的核对草稿。可以在这里继续，已保存的内容会保留；接管后，原编辑页面将停止编辑这份内容。</p>
        {recoverable.map(draft => <div key={draft.draft_id}>
          <span>修订 {draft.revision} · {new Date(draft.updated_at).toLocaleString()}{draft.legacy_unowned ? ' · 历史作者未知' : ''}</span>
          <button disabled={busy || !!pending.current} onClick={() => {
            if (!window.confirm(draft.legacy_unowned ? '这是作者未知的历史未确认草稿。确认认领并核对全部修改后再决定是否发布？' : '在此继续修改已保存的内容？其他页面将停止编辑这份内容，本页面未保存的条目修改将被重新载入。')) return;
            void run(signal => write(signal, `/${draft.draft_id}/claim`, { operation_id: newOntologyOperationId(),
              expected_revision: draft.revision, legacy_confirmed: draft.legacy_unowned }));
          }}>{draft.legacy_unowned ? '确认认领历史草稿' : '在此继续修改'}</button>
        </div>)}
        <button disabled={busy || !!pending.current} onClick={() => { if (leaveLocal()) {
          opening.current = newOntologyOperationId(); void run(signal => openDraft(signal, false));
        } }}>{extraction?'重新读取本轮草稿':'基于已发布结果开始编辑'}</button>
      </section>}
      {inline && !summary && materialNotice}
      {inline&&summary&&<div hidden={!rulesOpen}>{materialNotice}<MaterialRuleEditor key={`${summary.id}:${summary.ontology_version_id}`} workspace={workspace} documentId={documentId} summary={summary}
        status={materialStatus} disabled={bindingBlocked||leaseBlocked||busy||textEditing||dirty||!!pending.current||!!summary.stale_reason&&summary.stale_reason!=='ONTOLOGY_TARGET_CHANGED'||summary.status!=='editing'} onState={updateRuleState}
        save={body=>void run(signal=>write(signal,`/${summary.id}/rules`,body))} /></div>}
      {message && <p role="status">{message}</p>}
      {pending.current && <div className="correction-warning">保存结果尚未确认。<button disabled={busy} onClick={() => void run(signal => write(signal, pending.current!.suffix, pending.current!.body))}>重试原请求</button>
        <button disabled={busy} onClick={() => { if (window.confirm("放弃重试并重新加载已保存的内容？未确认修改需要核对。")) { pending.current = null; void run(signal => summary ? load(signal, summary.id) : openDraft(signal)); } }}>重新核对</button></div>}
      {!summary && <button disabled={busy||!!pending.current} onClick={() => {
        // Only an explicit retry after a definite rejection may refresh the
        // reference. Unknown writes retain their original envelope above.
        if(bindingBlocked){extractionRef.current=null;setExtraction(null);setBindingBlocked(false);opening.current=newOntologyOperationId();}
        void run(openDraft);
      }}>{busy ? "读取处理结果…" : "重新读取处理结果"}</button>}
      {summary && <><details className="review-more"><summary>草稿操作与修改记录</summary><div className="correction-toolbar"><span>草稿修订 {summary.revision} · {dirty ? "当前条目未保存" : "已保存"}</span>
        <button disabled={leaseBlocked || busy || dirty || ruleState.dirty || ruleState.busy || !!pending.current || summary.status !== 'editing'} onClick={() => {
          void run(async signal => {
            await request<Receipt>(signal, `/${summary.id}/release`, {}, { operation_id: newOntologyOperationId(), expected_revision: summary.revision });
            setLeaseBlocked(true); setRecoverable((await request<{items: RecoverableDraft[]}>(signal, '/leases')).items);
            setMessage('已释放编辑，已保存的草稿可随时恢复。');
          });
        }}>保存内容并释放编辑</button>
        <button disabled={busy || ruleState.dirty || ruleState.busy || dirty || Boolean(pending.current)} onClick={() => void run(signal => showPreview(signal))}>查看变更</button>
        <button disabled={busy} onClick={() => void run(signal => history(signal))}>修改记录</button>
        <button disabled={busy || ruleState.dirty || ruleState.busy || Boolean(pending.current)} onClick={() => { if (leaveLocal()) void run(signal => load(signal, summary.id)); }}>刷新草稿</button>
        <button disabled={busy || ruleState.busy || summary.status !== "editing" || Boolean(pending.current)} onClick={() => { if (window.confirm("放弃整篇草稿？已发布内容不受影响，修改记录仍会保留。")) void run(signal => write(signal, `/${summary.id}/discard`, { operation_id: newOntologyOperationId(), expected_revision: summary.revision, note })); }}>放弃整篇草稿</button></div></details>
        {summary.status === "discarded" && <button disabled={busy} onClick={() => { opening.current = newOntologyOperationId(); void run(signal => openDraft(signal, false)); }}>重新创建草稿</button>}
        {summary.stale_reason && (summary.status === 'editing' || (summary.stale_reason === 'STALE_DOCUMENT_VERSION' && publication && !['queued', 'running'].includes(publication.status))) && <div role="alert" className="correction-warning">正文或基础知识已变化。原草稿已保留，请重新核对；旧草稿不能直接生效。
          {summary.stale_reason==='CORRECTION_BASE_CHANGED'&&<p>已发布知识在草稿创建后发生变化。请先查看修改记录；若无需保留此草稿，可在“草稿操作与修改记录”中放弃，再重新创建草稿读取当前结果。</p>}
          {summary.stale_reason === 'STALE_DOCUMENT_VERSION' && <button disabled={busy || ruleState.dirty || ruleState.busy || Boolean(pending.current) || dirty} onClick={() => {
            if (window.confirm('将已保存的草稿内容转到当前正文？原草稿保留，旧来源会清空，必须重新选择依据。'))
              void run(signal => write(signal, `/${summary.id}/rebase`, { operation_id: newOntologyOperationId(), expected_revision: summary.revision }));
          }}>保留修改并转到当前正文</button>}</div>}
        {summary.requires_source_review && <p className="correction-warning">正文已更新，人工内容已保留在草稿中。旧证据不再沿用，请为保留的条目重新选择当前正文来源。</p>}
        {summary.ontology_target&&<p>当前核对规则：v{summary.ontology_target.version_number} · {summary.ontology_target.name}。原始基线和人工内容保留，发布前请核对新约束。</p>}
        {targetOntologyId&&summary.ontology_version_id!==targetOntologyId&&<button disabled={busy||dirty||!!pending.current||summary.status!=='editing'||!!summary.stale_reason&&summary.stale_reason!=='ONTOLOGY_TARGET_CHANGED'} onClick={()=>{
          if(window.confirm('将此草稿切换到当前发布本体核对？人工内容和原文来源保留，原有语义确认需按新规则重新核对；不会自动发布。'))
            void run(signal=>write(signal,`/${summary.id}/ontology`,{operation_id:newOntologyOperationId(),expected_revision:summary.revision,ontology_id:targetOntologyId}));
        }}>保留人工内容并切换本体</button>}
        <details ref={candidateSection} className="review-candidates" hidden={inline&&rulesOpen}><summary>{kind==='entity'?'实体':'关系'}抽取候选{suggestions ? ` · ${suggestions.total}` : ""}</summary>
        <button disabled={locked || dirty} onClick={() => void run(signal => showSuggestions(signal))}>{inline?'查看未入图与重抽结果':'查看重新抽取建议'}</button>
        {suggestions && <section className="correction-preview"><h3>{inline?'待核对的抽取结果':'重新抽取建议'}</h3>
          {suggestions.total>0&&<p>{kind==='entity'?'核对对象名称与类型，确认后加入草稿；需要修改时点击“调整”。':'核对起点、关系类型与终点，确认后加入草稿；需要修改时点击“调整”。'}</p>}
          {[...deferredCandidates].some(key=>key.startsWith(`${suggestions.run_id}/${kind}/`)) && <p>本类已忽略 {[...deferredCandidates].filter(key=>key.startsWith(`${suggestions.run_id}/${kind}/`)).length} 项（仅本次打开有效）。<button disabled={locked || dirty} onClick={() => setDeferredCandidates(previous=>new Set([...previous].filter(key=>!key.startsWith(`${suggestions.run_id}/${kind}/`))))}>恢复显示</button></p>}
          {!suggestions.total && <p>{candidatePresentation?.emptyMessage??(extraction?`本类暂无可采纳候选。${candidatePresentation?.adoptable===null?'可采纳总数暂不可用，请刷新候选列表或查看处理记录。':'可切换实体或关系查看其他候选。'}`:'当前没有完整就绪的建议。处理中或失败的抽取结果不能采纳。')}</p>}
          {suggestions.items.filter(suggestion => suggestion.proposal.kind===kind&&!deferredCandidates.has(`${suggestions.run_id}/${kind}/${suggestion.candidate_id}`)).map(suggestion => <article className="correction-candidate" key={suggestion.candidate_id}>
            <CandidateView item={suggestion.proposal} ontology={summary.ontology} />
            {suggestion.validation_errors.length > 0 && <p className="correction-warning">抽取时提示：{suggestion.validation_errors.join('；')}。加入后仍需处理草稿校验。</p>}
            {suggestion.comparison.length > 0 && <details><summary>草稿中的同名实体或同类型关系（{suggestion.comparison_total} 项，最多展示 3 项）</summary>
              {suggestion.comparison.map(item => <ChangeView key={item.id} change={{ item_id: item.id, before: item, after: suggestion.proposal }} />)}</details>}
            <div className="correction-toolbar">
            <button disabled={locked || dirty || suggestion.already_added} onClick={() => adoptSuggestion(suggestion)}>{suggestion.already_added ? '已加入草稿' : '确认加入草稿'}</button>
            <button disabled={locked || dirty || suggestion.already_added} onClick={() => editCandidate(suggestion)}>调整</button>
            <button disabled={locked || dirty || suggestion.already_added} onClick={() => setDeferredCandidates(previous => new Set([...previous, `${suggestions.run_id}/${kind}/${suggestion.candidate_id}`]))}>忽略</button>
            </div>
            {selected&&selected.kind===suggestion.proposal.kind&&<details><summary>替换已有条目</summary><button disabled={locked||dirty} onClick={()=>adoptSuggestion(suggestion,true)}>替换选中条目：{itemLabel(selected)}</button></details>}
          </article>)}
          {suggestions.total>0&&<Pager page={suggestions} disabled={busy} go={offset => void run(signal => showSuggestions(signal, offset))} />}
          <button onClick={() => setSuggestions(null)}>收起建议，保留当前内容</button>
        </section>}
        </details>
        {publication && <section className="correction-publication"><h3>发布记录</h3>
          <p role="status">{publication.effective ? '已发布，当前检索使用此版本。' : publication.status === 'succeeded' ? '此版本曾发布，当前已由后续结果替代。' : ({ queued: '等待发布，旧结果继续可用。', running: '正在发布，旧结果继续可用。', failed: '发布失败，旧结果继续可用。', cancelled: '发布已取消。' } as Record<string, string>)[publication.status]}</p>
          <p>工作台手动提交 · 修订 {publication.revision} · {new Date(publication.created_at).toLocaleString()} · 任务 {publication.job_id}</p>
          {publication.note && <p>{publication.note}</p>}{publication.error_message && <p role="alert">{publication.error_message}</p>}
          {['failed', 'cancelled'].includes(publication.status) && <button disabled={busy || Boolean(pending.current)} onClick={() => void run(signal => write(signal, `/${summary.id}/publication/retry`, { operation_id: newOntologyOperationId() }))}>重试原提交</button>}
          {!['queued', 'running'].includes(publication.status) && <button disabled={busy || Boolean(pending.current)} onClick={() => { opening.current = newOntologyOperationId(); void run(signal => openDraft(signal, false)); }}>基于当前结果创建新草稿</button>}
        </section>}
        <p className="correction-validation">{summary.validation.errors} 个约束问题 · {summary.validation.warnings} 条语义提示（{summary.validation.unreviewed} 条待复核）</p>
        {preview && <WorkbenchDrawer title="核对发布变更" canClose={!busy} close={() => {if (!batchEditing || window.confirm('本次批量选择尚未保存，确认关闭并放弃这些选择？已保存草稿不会改变。')) setPreview(null);}}>{error && <p role="alert" className="correction-error">{error}</p>}<section className="correction-preview"><h3>已保存的变更</h3><p>{preview.ready_for_confirmation ? "当前约束已通过，可继续核对变更内容。" : "请先修正或排除阻塞错误；对有原文依据的警告，核对来源并填写复核说明后重新校验。"} 此处仅预览，不会发布。</p>
          {pending.current && <div className="correction-warning">保存结果尚未确认，请恢复原请求后再继续。<button disabled={busy} onClick={() => void run(signal => write(signal,pending.current!.suffix,pending.current!.body))}>重试原请求</button></div>}
          {(hasPendingChanges || preview.issue_count > 0) && <PublicationValidation key={`${summary.id}:${preview.revision}:${preview.offset}`} preview={preview} items={validationItems} disabled={locked || dirty}
            returnToCandidates={returnToCandidates}
            onEditingChange={setBatchEditing}
            load={() => {if (locked || dirty) return; void run(async signal => setValidationItems(await readBatchItems(
              offset => request<Page<Item>>(signal, `/${summary.id}/items`, {revision: preview.revision, offset, limit: 50}), preview.revision)));}}
            inspect={id => {if (locked || dirty || batchEditing && !window.confirm('打开单条编辑会放弃当前批量选择，是否继续？已保存草稿不会改变。')) return; void run(signal => inspectValidationItem(signal,id));}}
            save={(plan, explanation) => {if (locked || dirty || preview.revision !== summary.revision) return;
              void run(signal => write(signal, `/${summary.id}/save`, operationEnvelope(preview.revision,plan.upserts,plan.removeIds,explanation,newOntologyOperationId())));}} />}
          {summary.ontology_status==='draft'&&<section className="review-rule-publication"><h4>本次同时发布类型规则</h4><p>以下规则变化影响知识库后续抽取；实体和关系的修正仅更新本篇材料。</p><OntologyChangeSummary before={rulePreviewBase} after={summary.ontology as OntologyDefinition} expanded /></section>}
          {preview.items.map(change => <ChangeView key={change.item_id} change={change} action={<button disabled={locked || batchEditing} onClick={() => { if (window.confirm("撤销这一项变更？")) void run(signal => write(signal, `/${summary.id}/items/${change.item_id}/reset`, { operation_id: newOntologyOperationId(), expected_revision: summary.revision, note: "" })); }}>撤销此项变更</button>} />)}
          {!hasPendingChanges && preview.issue_count === 0 && <div className="review-next-step" role="status"><strong>{candidatePresentation?.emptyMessage??'尚未选择要发布的新结果'}</strong>
            <p>{extraction?candidateNextStep:'草稿没有待发布变更，无需填写批量说明。请先查看抽取候选，选择需要保留的实体和关系并加入草稿，再核对发布。若没有候选或不需要更新，可关闭窗口，保留现有发布结果。'}</p>
            <button disabled={locked || dirty || batchEditing} onClick={returnToCandidates}>查看抽取候选</button>
            <button disabled={busy || batchEditing} onClick={() => setPreview(null)}>返回核对页面</button>
          </div>}
          {!preview.total && hasPendingChanges && <p>没有实体或关系内容变更，请核对本次规则或来源更新。</p>}{preview.total>0&&<Pager page={preview} disabled={busy || batchEditing} go={offset => void run(signal => showPreview(signal, offset))} />}
          {batchEditing && <p role="status">批量选择尚未保存，请先确认保存，或清空选择后再发布。</p>}
          {hasPendingChanges&&<button className="correction-confirm-publish primary" disabled={locked || dirty || batchEditing || !preview.ready_for_confirmation} onClick={() => {
            if (window.confirm(`确认发布已核对的草稿修订 ${summary.revision}？共 ${preview.total} 项知识变更。${summary.ontology_status==='draft'?'同时发布待确认规则，影响本知识库后续抽取；其他材料不会自动重抽。':''}知识发布成功后替换本篇文档的结果。`))
              void run(signal => write(signal, `/${summary.id}/${inline?'apply':'submit'}`, { operation_id: newOntologyOperationId(), expected_revision: summary.revision, note,...(inline?{confirmed:true}:{}) }));
          }}>{inline?'确认发布':'确认并发布此修订'}</button>}
          </section></WorkbenchDrawer>}
        {historyOpen && <WorkbenchDrawer title="修改记录" canClose={!busy} close={() => setHistoryOpen(false)}><section className="correction-history"><h3>修改记录</h3><p>工作台来源不代表已识别具体操作者。以下记录均为草稿操作。</p>
          {events.map(event => <article key={event.id}><strong>{({ create: "创建草稿", save: "保存修改", reset: "撤销条目修改", discard: "放弃草稿" } as Record<string, string>)[event.action]}</strong>
            <span> · {new Date(event.created_at).toLocaleString()} · 工作台手动操作 · 修订 {event.revision}</span>{event.note && <p>{event.note}</p>}<button disabled={busy} onClick={() => void run(async signal => setEventChanges({ id: event.id, page: await request<Page<Change>>(signal, `/events/${event.id}`) }))}>查看修改内容</button>
            <button disabled={busy || Boolean(pending.current)} onClick={() => { if (leaveLocal()) void run(async signal => { await load(signal, event.draft_id); setHistoryOpen(false); }); }}>查看草稿及发布记录</button></article>)}
          {eventChanges && <div>{eventChanges.page.items.map(change => <ChangeView key={change.item_id} change={change} />)}{!eventChanges.page.total && <p>这条记录没有条目内容修改。</p>}<Pager page={eventChanges.page} disabled={busy} go={offset => void run(async signal => setEventChanges({ id: eventChanges.id, page: await request<Page<Change>>(signal, `/events/${eventChanges.id}`, { offset }) }))} /></div>}
          <button disabled={busy || events.length === 0} onClick={() => void run(signal => history(signal, true))}>更多记录</button><button onClick={() => setHistoryOpen(false)}>收起记录</button></section></WorkbenchDrawer>}
        {inline&&!rulesOpen&&<h3>{summary.status==='submitted'?'已提交的结果':'待发布草稿'} · {kind==='entity'?'实体':'关系'} {summary.counts[kind]}</h3>}
        <div className="correction-columns" hidden={inline && rulesOpen}><aside><div className="correction-toolbar" hidden={inline}>{(["entity", "relation"] as const).map(value => <button key={value} disabled={busy || Boolean(pending.current)} aria-pressed={kind === value} onClick={() => { if (leaveLocal()) void run(signal => load(signal, summary.id, value)); }}>{value === "entity" ? "实体" : "关系"}（{summary.counts[value]}）</button>)}</div>
          {!inline&&<button disabled={locked} onClick={startNewItem}>新增{kind === "entity" ? "实体" : "关系"}</button>}
          {page?.items.map(item => <button className="correction-item" key={item.id} disabled={busy || Boolean(pending.current)} aria-pressed={selected?.id === item.id} onClick={() => select(item)}>
            <span className="correction-card-heading"><strong>{itemLabel(item)}</strong><span className="badge">{(item.kind === 'entity' ? summary.ontology.entity_types : summary.ontology.relation_types).find(type => type.name === item.payload.type)?.label ?? String(item.payload.type)}</span></span>
            {item.evidence[0]?.excerpt && <blockquote>“{item.evidence[0].excerpt.slice(0,180)}”</blockquote>}
            <small>{item.evidence.length} 条来源 · {item.issues?.filter(i => i.severity === "error").length ?? 0} 个问题</small>
            <span className="correction-card-heading"><small>{item.evidence[0] ? sourceLabel(item.evidence[0].locator ?? {}) : '需要补充依据'}</small><span>{locked?'查看（暂不可编辑）':'调整'}</span></span>
          </button>)}
          {page && page.total>0 && <Pager page={page} disabled={busy || Boolean(pending.current)} go={offset => { if (leaveLocal()) void run(signal => load(signal, summary.id, kind, offset)); }} />}</aside>
          {!inline && editorContent}</div>
          {inline && selected && editorOpen && <WorkbenchDrawer title={creating ? (selected.kind === 'entity' ? '新增实体' : '新增关系') : (selected.kind === 'entity' ? '编辑实体' : '编辑关系')} canClose={!busy && !ruleState.busy} close={() => {
            if (!leaveLocal()) return;
            setSelected(original ? structuredClone(original) : null); setEditorOpen(false); setSources(null); setPicker(null);
          }}>{error && <p role="alert" className="correction-error">{error}</p>}<div className="correction-columns correction-editor-drawer">{editorContent}</div></WorkbenchDrawer>}
          {inline&&selected&&newTypeKind&&<ConfigurationDrawer value={summary.ontology as OntologyDefinition} selection={{kind:newTypeKind,index:null}} disabled={busy} feedback={pending.current?'保存结果尚未确认。关闭类型窗口后，请重试原请求，避免重复创建。':error} applyLabel="保存类型并返回" hint="类型先保存为待发布规则，返回后继续核对当前条目；最终确认发布后才生效。" onApply={saveNewType} onClose={()=>{if(!newTypeSaving.current)setNewTypeKind(undefined);}} />}
          </>}
      {inline && !reviewUnavailable && <footer className="review-footer" aria-label="草稿与发布操作">
        <div className="review-footer-status"><span><DesignIcon name="saved" />{busy ? '正在处理…' : pending.current ? '保存结果尚未确认，请重试原请求' : dirty || ruleState.dirty ? '有未保存修改' : summary?.status==='editing'&&summary.stale_reason ? '草稿基础已变化，请先处理' : publication ? publication.effective ? '已发布，当前检索使用此版本' : ({queued:'等待发布，旧结果继续可用',running:'正在发布，旧结果继续可用',failed:'发布失败，请查看发布记录并重试',cancelled:'发布已取消，旧结果继续可用',succeeded:'此版本已被后续结果替代'} as Record<string,string>)[publication.status] ?? '请查看发布记录' : summary?.status === 'discarded' ? '草稿已放弃' : summary ? hasPendingChanges?'草稿已保存，尚未发布':extraction?candidateNextStep:'暂无待发布修改' : error ? '知识草稿未载入' : '正在读取知识草稿'}
          {summary && <small>{new Date(summary.updated_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</small>}</span>
          <small>{summary ? `${summary.change_count} 项知识变化` : '原文与知识独立处理'}{summary?.ontology_status === 'draft' ? ' · 含待发布规则' : ''}{ruleState.dirty ? ' · 请先保存类型页的规则调整' : ''}</small></div>
        <div className="review-footer-actions"><button className="text-button" disabled={busy || ruleState.dirty || ruleState.busy || dirty || !summary || !!pending.current} onClick={() => void run(signal => showPreview(signal))}>查看变更</button>
          <button disabled={locked || !dirty} onClick={() => void run(signal => save(signal))}>保存草稿</button>
          <button className="primary" disabled={locked || dirty || !summary || !hasPendingChanges} onClick={() => void run(signal => showPreview(signal))}><DesignIcon name="publish" />核对并发布</button></div>
      </footer>}
    </div>
  </section>;
}

function Pager<T>({ page, disabled, go }: { page: Page<T>; disabled: boolean; go: (offset: number) => void }) {
  return <nav className="correction-pager" aria-label="分页"><button disabled={disabled || page.offset === 0} onClick={() => go(Math.max(0, page.offset - page.limit))}>上一页</button><span>{page.total ? page.offset + 1 : 0}–{Math.min(page.total, page.offset + page.items.length)} / {page.total}</span><button disabled={disabled || page.offset + page.items.length >= page.total} onClick={() => go(page.offset + page.limit)}>下一页</button></nav>;
}
function PropertyInput({ value, change }: { value: unknown; change: (value: unknown) => void }) {
  if (typeof value === "boolean") return <select value={String(value)} onChange={e => change(e.target.value === "true")}><option value="true">是</option><option value="false">否</option></select>;
  if (Array.isArray(value)) return <div>{value.map((v, i) => <PropertyInput key={i} value={v} change={next => change(value.map((old, index) => index === i ? next : old))} />)}</div>;
  if (value && typeof value === "object") return <div>{Object.entries(value).map(([key, v]) => <label key={key}>{key}<PropertyInput value={v} change={next => change({ ...value, [key]: next })} /></label>)}</div>;
  return <input type={typeof value === "number" ? "number" : "text"} value={String(value ?? "")} onChange={e => change(typeof value === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />;
}
function CandidateView({item, ontology}: {item:Item; ontology:Summary['ontology']}) {
  const definition=(item.kind==='entity'?ontology.entity_types:ontology.relation_types).find(type=>type.name===item.payload.type);
  const properties=Object.entries(item.payload.properties as Record<string,unknown> ?? {});
  const entity=item.kind==='entity';
  return <>
    <h4>{entity?'对象名称':'关系对象'}：{itemLabel(item)}</h4>
    <p><strong>{entity?'对象类型（抽象分类）':'关系类型'}：</strong>{definition?.label ?? '未定义类型'}（{String(item.payload.type ?? '未填写')}）<span className="badge">模型分类 · 待核对</span></p>
    {entity && <p>别名：{Array.isArray(item.payload.aliases)&&item.payload.aliases.length?item.payload.aliases.join('、'):'无'}</p>}
    <h5>{entity?'对象属性':'关系属性'}</h5>
    {properties.length?<dl className="candidate-properties">{properties.map(([key,value])=><div key={key}><dt>{definition?.properties.find(property=>property.name===key)?.label??key}{!definition?.properties.some(property=>property.name===key)&&'（类型中未定义）'}</dt><dd><ValueView value={value}/></dd></div>)}</dl>:<p className="muted">未提取到属性值，请结合原文核对；这里不会根据日期等独立候选自动补填属性。</p>}
    <h5>原文依据</h5>
    {item.evidence.length?item.evidence.map((e,index)=><div key={index}><small>{sourceLabel(e.locator??{})}</small><blockquote>{e.excerpt||'该引用需要重新选择有效来源'}</blockquote></div>):<p className="correction-warning">缺少来源依据，加入草稿后需补充。</p>}
  </>;
}

function ChangeView({ change, action }: { change: Change; action?: ReactNode }) {
  const item = change.after ?? change.before!;
  return <article className="correction-change"><div className="correction-change-heading"><div><strong>{item.kind === "entity" ? String(item.payload.name || "未命名实体") : String(item.payload.type)}</strong><span> · {changedFields(change).join("、")}</span></div>{action}</div>
    <div className="correction-before-after">{[change.before, change.after].map((value, i) => <div key={i}><h4>{i === 0 ? "修改前" : "修改后"}</h4>{value ? <><p>{value.kind === "entity" ? String(value.payload.name) : itemLabel(value)} · {String(value.payload.type)}</p>
      {Object.entries(value.payload.properties as Record<string, unknown> ?? {}).map(([k, v]) => <div key={k}>{k}：<ValueView value={v} /></div>)}
      {Array.isArray(value.payload.aliases) && <p>别名：{value.payload.aliases.join("、") || "无"}</p>}
      {value.evidence.map((e, index) => <blockquote key={index}>{e.excerpt}</blockquote>)}{value.review_note && <p>复核说明：{value.review_note}</p>}</> : <p>无</p>}</div>)}</div></article>;
}

function ValueView({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ul>{value.map((v, i) => <li key={i}><ValueView value={v} /></li>)}</ul>;
  if (value && typeof value === "object") return <dl>{Object.entries(value).map(([key, v]) => <div key={key}><dt>{key}</dt><dd><ValueView value={v} /></dd></div>)}</dl>;
  return <span>{typeof value === "boolean" ? (value ? "是" : "否") : String(value ?? "未填写")}</span>;
}
