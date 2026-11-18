import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson } from '../request';
import { startVisiblePolling } from '../polling';
import type { SuggestionPreview } from '../ontologySuggestions';

export type MaterialOntologyStatus = { document_id: string; task_id?: string; status: string; count: number; handled?: boolean; message?: string };

export function useMaterialOntology(workspace: string, enabled: boolean) {
  const [items, setItems] = useState<Record<string, MaterialOntologyStatus>>({});
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const run = ++generation.current;
    try {
      const result = await requestJson<{items: MaterialOntologyStatus[]}>(`/api/ontology-suggestions/materials?workspace_id=${encodeURIComponent(workspace)}`, undefined, 15000);
      if (run !== generation.current) return;
      setItems(Object.fromEntries(result.items.map(item => [item.document_id, item]))); setError('');
    } catch (reason) {
      if (run !== generation.current) return;
      setError('本体建议状态暂时无法读取，请刷新重试。');
      throw reason;
    }
  }, [workspace, enabled]);
  useEffect(() => {
    generation.current++;
    setItems({}); setError('');
    if (!enabled) return;
    const stop = startVisiblePolling({refresh, delay:()=>5000, onError:()=>{}});
    return () => { generation.current++; stop(); };
  }, [enabled, refresh]);
  return {items, error, refresh};
}

export function materialOntologyLabel(status?: MaterialOntologyStatus): string {
  if (!status || status.handled) return '';
  if (status.status === 'completed' && status.count) return `${status.count} 条本体建议待确认`;
  if (status.status === 'queued' || status.status === 'running') return '本体建议处理中';
  if (status.status === 'failed') return '本体建议生成失败';
  if (status.status === 'stale') return '本体建议待更新';
  return '';
}

export default function MaterialOntologyNotice({workspace, documentId, status, error, disabled, refresh, onReview}: {
  workspace:string; documentId:string; status?:MaterialOntologyStatus; error:string; disabled:boolean;
  refresh:()=>Promise<void>; onReview:(preview:SuggestionPreview)=>void;
}) {
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState('');
  const alive=useRef(true), pending=useRef(false);
  const interaction=useRef(0);
  useEffect(()=>{interaction.current++;},[disabled,workspace,documentId]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function action(kind:'schedule'|'review'|'dismiss') {
    if(pending.current || disabled) return;
    pending.current=true;setBusy(true);setFailure('');
    const started=interaction.current;
    try {
      const result=await requestJson<SuggestionPreview>(`/api/ontology-suggestions/materials/${encodeURIComponent(documentId)}/${kind}`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspace,...(kind==='dismiss'?{task_id:status?.task_id}:{})})},15000);
      if(!alive.current) return;
      if(kind==='review') {
        if(started!==interaction.current) {setFailure('页面状态已变化，请完成正文校对后重新打开建议。');return;}
        onReview(result);
      }
      else await refresh().catch(()=>{if(alive.current)setFailure('操作已完成，但状态刷新失败，请稍后刷新。');});
    } catch(reason){if(alive.current)setFailure(reason instanceof Error?reason.message:'操作失败');}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  const waiting=status?.status==='queued'||status?.status==='running';
  const completed=status?.status==='completed';
  return <section className="ontology-notice material-ontology-notice" aria-label="材料本体建议">
    <strong>本体规则建议</strong>
    <p>{error || (waiting?'正文已就绪，本体建议正在后台处理，不影响原有检索流程。':completed?
      status.handled?'本批建议已核对。':status.count?`有 ${status.count} 条建议待核对，自动显示在下方核对区。`:'本次没有产生可采纳扩展，可能已有规则能够覆盖；也可能受模型或取样范围限制。':
      status?.message || '新解析的材料会自动分析本体建议；已有材料也可以手动生成。')}</p>
    <p>在本页核对类型、实体和关系，保存后统一确认应用。未确认的修改不会进入检索。</p>
    {failure&&<p role="alert">{failure}</p>}
    <div className="ontology-table-actions">
      {completed&&<button type="button" disabled={busy||disabled} onClick={()=>void action('review')}>查看并确认建议</button>}
      {completed&&!status.handled&&status.count>0&&<button type="button" disabled={busy||disabled} onClick={()=>void action('dismiss')}>无需调整，标记已核对</button>}
      {!waiting&&!completed&&<button type="button" disabled={busy||disabled||!!error} onClick={()=>void action('schedule')}>{status?.status==='failed'?'重试本体建议':status?.status==='stale'?'重新生成本体建议':'生成本体建议'}</button>}
      {error&&<button type="button" disabled={busy} onClick={()=>void refresh().catch(()=>{})}>刷新状态</button>}
    </div>
  </section>;
}
