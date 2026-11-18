import {useEffect,useRef,useState} from 'react';
import {requestJson} from '../request';
import {OntologyDialogue,nextInstruction,publishInstruction,type DialogueTarget} from '../ontologyDialogue';
import type {OntologyDefinition} from '../ontology';
import OntologyChangeSummary from './OntologyChangeSummary';
import OntologyPreview from './OntologyPreview';
import {WorkbenchDrawer} from './WorkbenchUI';
import './OntologyAssistant.css';

export default function OntologyAssistant({baseId,schema,target,onClose,onBusy,onDirty,onPublished,initialText='',onTextChange,inline=false}:{
  baseId:string;schema:OntologyDefinition;target:DialogueTarget;onClose:()=>void;onBusy:(value:boolean)=>void;onDirty?:(value:boolean)=>void;onPublished:()=>void|Promise<void>;
  initialText?:string;onTextChange?:(value:string)=>void;inline?:boolean;
}){
  const [,render]=useState(0),alive=useRef(true);
  const [flow]=useState(()=>new OntologyDialogue(requestJson,baseId,()=>{if(alive.current)render(n=>n+1);},schema));
  const [facts,setFacts]=useState(target.scope==='facts'),[text,setText]=useState(initialText),[confirmed,setConfirmed]=useState(false);
  const [resumeRequested,setResumeRequested]=useState(false);
  const [assistantPanel, setAssistantPanel] = useState<'chat' | 'proposal'>('chat');
  const [syncing,setSyncing]=useState(false),[syncError,setSyncError]=useState('');
  const published=useRef('');
  const previewContent=useRef<HTMLDivElement>(null);
  const c=flow.current,p=flow.preview,suggestion=flow.proposal,locked=flow.busy||!!flow.pending||!!flow.settling||syncing;
  async function syncPublication(){
    setSyncing(true);setSyncError('');
    try{await onPublished();}catch{if(alive.current)setSyncError('本体已发布，但主页面刷新失败。请重新读取生效本体；不需要重复发布。');}
    finally{if(alive.current)setSyncing(false);}
  }
  useEffect(()=>{alive.current=true;if(!facts)void flow.open();return()=>{alive.current=false;};},[flow,facts]);
  useEffect(()=>{flow.baseId=baseId;},[flow,baseId]);
  useEffect(()=>{onBusy(locked);return()=>onBusy(false);},[locked,onBusy]);
  useEffect(()=>{onDirty?.(!!text.trim());onTextChange?.(text);return()=>onDirty?.(false);},[text,onDirty,onTextChange]);
  useEffect(()=>{setConfirmed(false);},[p,text]);
  useEffect(()=>{
    if (!p) return;
    if (inline) setAssistantPanel('proposal');
    if (previewContent.current) previewContent.current.scrollTop = 0;
  },[p,inline]);
  useEffect(()=>{
    const accepted=flow.acceptedInput;
    if(accepted)setText(value=>value===accepted.instruction?'':value);
  },[flow.acceptedInput]);
  useEffect(()=>{
    if(c?.status==='published'&&published.current!==c.conversation_id){published.current=c.conversation_id;void syncPublication();}
  },[c,onPublished]);
  useEffect(()=>{
    if((!c?.active_turn_id&&!flow.settling)||flow.busy||flow.pending)return;
    const timer=setTimeout(()=>void flow.refresh(),3000);return()=>clearTimeout(timer);
  },[c,flow,flow.busy,flow.pending,flow.settling]);
  const canCompose=!facts&&flow.opened&&!c?.active_turn_id&&!locked&&!flow.needsRefresh;
  const canDraft=!facts&&(!flow.opened||canCompose);
  const stale=c?.status==='stale',editable=canCompose&&!stale;
  const baseline=flow.baselineSchema||schema;
  const unsent=!!text.trim(),draft=c?.status==='editing'?c.draft?.schema:undefined;
  const changed=!!draft&&flow.hasChanges()===true;
  const proposed=!stale&&flow.awaitingProposal?suggestion:undefined;
  const publishedSchema=c?.status==='published'&&c.publication_effective!==false?c.draft?.schema||schema:schema;
  const canApply=editable&&!unsent&&suggestion?.status==='proposed'&&!suggestion.questions.length;
  async function resume(){
    if(!canCompose||!stale)return;
    const value=text;
    await flow.start();
    if(flow.error)return;
    setResumeRequested(false);
    if(value.trim())await flow.send(value);
  }
  async function send(){
    if(!canCompose)return;
    if(stale){setResumeRequested(true);return;}
    const value=text;await flow.send(value);
    if(!flow.error&&(nextInstruction(value)||publishInstruction(value)))setText(current=>current===value?'':current);
  }
  const proposal = <section className="assistant-proposal" hidden={inline && assistantPanel !== 'proposal'}>
      <div className="section-title"><h3>{p?'发布预览':proposed||changed?'修改预览':'当前发布版本'}</h3><div className="assistant-actions">
        {proposed?<span className="badge">建议 · 未应用</span>:changed?<span className="badge">草稿 · 未发布</span>:<span className="badge">已发布</span>}
        {changed&&!p&&!proposed&&<button className="primary" disabled={!editable||unsent||c?.can_preview===false||!!c?.draft?.questions.length} onClick={()=>void flow.prepare()}>查看发布预览</button>}
      </div></div>
      <div className="assistant-preview-content" ref={previewContent}>
      {p&&<section className="assistant-impact" aria-label="规则发布影响">
        <h3>发布影响摘要</h3><p>仅发布规则，已有知识保留；其他材料不会自动重新抽取。删除类型不会连带删除已有知识。</p>
        <p>仓内材料共 {p.impact.total} 份；本页分析 {p.impact.items.length} 份。</p>
        {p.impact.items.map(item=><article key={item.document_id}><strong>{item.name}</strong><p>{{certain:'确定受影响',possible:'可能受影响',unknown:'影响待确认',unchanged:'未发现影响'}[item.certainty]||item.certainty}{item.protected?' · 有人工修订保护':''}{item.active_task_count?` · ${item.active_task_count} 项任务处理中`:''}</p>{item.reasons.map((reason,i)=><p key={i}>{reason}</p>)}</article>)}
        {(p.impact.offset>0||p.impact.has_more)&&<div className="assistant-rounds"><button disabled={!editable||unsent||p.impact.offset===0} onClick={()=>void flow.prepare(Math.max(0,p.impact.offset-20))}>上一页影响</button><button disabled={!editable||unsent||!p.impact.has_more} onClick={()=>void flow.prepare(p.impact.offset+20)}>下一页影响</button></div>}
        {!p.impact.valid&&<p role="alert">当前预览未通过校验，暂不能发布。请核对影响并调整规则后重新预览。</p>}
      </section>}
      {c?.status==='published'&&<p role="status" className="muted">{syncing?'修改已发布，正在刷新主页面…':syncError?'修改已发布，主页面尚待刷新。':c.publication_effective===false?'本次修改曾发布，当前已有更新版本。可以基于最新版本继续对话。':'修改已发布，可以继续对话。'}</p>}
      <OntologyPreview schema={proposed?.schema||(changed?draft:undefined)||publishedSchema} statusLabel={proposed?'建议，未应用':changed?'草稿，未发布':'当前发布版本'}/>
      {stale&&c?.draft&&<details className="assistant-retained-draft"><summary>查看保留的旧草稿</summary><p>旧草稿基于先前版本，尚未合并到当前本体。</p><OntologyPreview schema={c.draft.schema} statusLabel="旧草稿，版本已过期"/>
        <OntologyChangeSummary before={publishedSchema} after={c.draft.schema}/>
        {suggestion&&suggestion.status!=='applied'&&<details><summary>查看旧建议（未应用）</summary><OntologyPreview schema={suggestion.schema} statusLabel="旧建议，未应用"/></details>}
      </details>}
      {proposed?<>
        <OntologyChangeSummary before={draft||baseline} after={proposed.schema} suggestion/>
        {!!proposed.dependencies.length&&<details className="assistant-dependencies"><summary>关联影响</summary><ul>{proposed.dependencies.map((item,i)=><li key={i}>{item}</li>)}</ul></details>}
      </>:changed&&draft?<OntologyChangeSummary before={baseline} after={draft}/>:null}
      </div>
      {p&&<section className="assistant-publication-actions" aria-label="确认发布规则">
        <p role="status">尚未发布。确认发布后，修改才会显示在生效本体中。</p>
        <label><input type="checkbox" checked={confirmed} disabled={!editable||unsent||!p.impact.valid} onChange={e=>setConfirmed(e.target.checked)}/>我已核对规则差异与影响，确认仅发布规则</label>
        <button className="primary" disabled={!editable||unsent||!confirmed||!p.impact.valid||flow.awaitingProposal} onClick={()=>{if(!text.trim())void flow.publish(confirmed);}}>确认发布规则</button>
      </section>}
    </section>;
  const conversation = <aside className="assistant-conversation" aria-label="规则对话" hidden={inline && assistantPanel !== 'chat'}>
      {!inline && <div className="section-title"><h3>对话</h3></div>}
      <div className="assistant-chat-content">
      {(!c?.history?.items.length||c.status==='published')&&<p className="assistant-welcome">想调整哪些实体、关系或属性？</p>}
      <div className="assistant-messages">{c?.status!=='published'&&[...(c?.history?.items||[])].reverse().map(turn=><article key={turn.resource_id}>
        {turn.instruction&&<p className="assistant-user">你：{turn.instruction}</p>}
        <p>{turn.answer||turn.message||turn.summary||({generating:'正在生成建议…',failed:'本次生成失败，原草稿保留。',stale:'本次结果已过期。'}[turn.status])||'处理已完成，请核对当前建议及草稿。'}</p>
      </article>)}</div>
      {!stale&&flow.awaitingProposal&&suggestion&&<section className="assistant-suggestion" aria-label="待确认建议">
        <p>{suggestion.summary}</p>
        {!!suggestion.questions.length&&<><strong>请补充说明</strong><ol>{suggestion.questions.map((q,i)=><li key={i}>{q}</li>)}</ol></>}
        {suggestion.status==='stale'&&<p>此建议已过期，请描述要求重新生成。</p>}
        <button disabled={!canApply} onClick={()=>void flow.apply()}>确认应用到草稿</button>
      </section>}
      {flow.note&&(flow.settling||c?.active_turn_id||flow.note.includes('失败')||flow.note.includes('恢复'))&&<p role="status">{flow.note}</p>}
      <details className="assistant-history"><summary onClick={()=>{if(!flow.busy)void flow.list();}}>历史对话</summary>
        {flow.rounds.map(round=><button key={round.id} disabled={locked} onClick={()=>void flow.readHistory(round.id)}>{round.created_at?new Date(round.created_at).toLocaleString():'修改记录'}</button>)}
        {flow.more&&<button disabled={locked} onClick={()=>void flow.list(true)}>更多历史</button>}
        {flow.historyState&&<div className="assistant-messages">{[...(flow.historyState.history?.items||[])].reverse().map(turn=><article key={turn.resource_id}><p>你：{turn.instruction}</p><p>{turn.answer||turn.message||turn.summary||turn.status}</p></article>)}</div>}
      </details>
      </div>
      <div className="assistant-composer">
      {stale&&resumeRequested&&<div className="assistant-resume-confirmation" role="group" aria-label="确认基于最新版本继续">
        <p>基于最新生效版本继续？{unsent?'将按输入框中的要求生成新建议。':'你可以继续输入新的修改要求。'}旧草稿保留，不会自动合并或发布。</p>
        <button disabled={!canCompose} onClick={()=>void resume()}>确认基于最新版本继续</button><button disabled={!canCompose} onClick={()=>setResumeRequested(false)}>暂不继续</button>
      </div>}
      <textarea aria-label="规则调整要求" value={text} maxLength={8000} disabled={!canDraft} onChange={e=>setText(e.target.value)} placeholder={stale?'描述需要保留或调整的内容，发送后确认基于最新版本继续…':'描述要新增、修改或删除的内容…'} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>
      <div className="assistant-send"><small className="muted">Enter 发送 · Shift+Enter 换行</small>
      <button className="primary" disabled={!canCompose||!text.trim()} onClick={()=>void send()}>{flow.busy?'处理中…':'发送'}</button>
      </div></div>
    </aside>;
  return <WorkbenchDrawer title="知识助手" inline={inline} close={onClose} canClose={!locked} closeLabel={inline ? "返回生效规则" : "退出对话模式"} className="ontology-assistant">
    {facts?<section className="knowledge-card" aria-label="知识实例操作说明">
      <p>当前服务尚未提供仓级实例对话编辑接口，因此暂不能在这里新增、修改或删除实际知识。</p>
      <button onClick={()=>setFacts(false)}>对话调整本体类型与关系</button>
    </section>:<>
    <div className="assistant-feedback">
    {!flow.opened&&flow.busy&&<p role="status">正在读取上次的修改，可先输入调整要求，读取完成后即可发送。</p>}
    {flow.error&&<p role="alert" className="notice error">{flow.error}</p>}
    {syncError&&<div role="alert"><p>{syncError}</p><button disabled={syncing} onClick={()=>void syncPublication()}>重新读取生效本体</button></div>}
    {!flow.opened&&!flow.busy&&<button onClick={()=>void flow.open()}>重新读取当前修改</button>}
    {flow.needsRefresh&&<button disabled={flow.busy} onClick={()=>void flow.refresh()}>读取最新状态</button>}
    {flow.pending&&!flow.busy&&<div role="alert"><p>原请求结果尚未确认，恢复不会重复创建修改。</p><button onClick={()=>void flow.retry()}>恢复原请求</button></div>}
    {stale&&<div role="alert"><p>本体版本已更新，原草稿已保留。可以继续输入要求，确认后基于最新版本生成建议。</p><button disabled={!canCompose} onClick={()=>setResumeRequested(true)}>基于最新版本继续</button></div>}
    </div>
    {inline && <div className="rules-assistant-tabs" role="group" aria-label="规则对话工作区">
      <button type="button" aria-pressed={assistantPanel === 'chat'} onClick={() => setAssistantPanel('chat')}>对话</button>
      <button type="button" aria-pressed={assistantPanel === 'proposal'} onClick={() => setAssistantPanel('proposal')}>
        {p ? '核对与发布' : proposed || changed ? '查看修改' : '当前规则'}
        {(p || proposed || changed) && <span className="rules-assistant-dot" aria-hidden="true" />}
      </button>
    </div>}
    <div className="assistant-workspace">{inline ? <>{conversation}{proposal}</> : <>{proposal}{conversation}</>}</div></>}
  </WorkbenchDrawer>;
}
