import {useEffect, useRef, useState} from 'react';
import {groupPublicationIssues, publicationIssueAdvice, type IssueCategory} from '../../../shared/publication-validation.mjs';
import {buildBatchPlan, canReviewWarnings, type BatchAction, type BatchPlan} from '../correctionBatch';
import {itemLabel, type Item, type Preview} from '../corrections';

const titles: Record<IssueCategory, string> = {error:'阻塞错误', warning:'待核对警告', reviewed:'已核对警告', info:'可忽略提示'};
export default function PublicationValidation({preview, items, disabled, load, inspect, save, onEditingChange,returnToCandidates}: {
  preview: Preview; items: Item[] | null; disabled: boolean; load: () => void;
  inspect: (id: string) => void; save: (plan: BatchPlan, note: string) => void;
  onEditingChange: (editing: boolean) => void;
  returnToCandidates?:()=>void;
}) {
  const [action, setAction] = useState<BatchAction>('review');
  const [ids, setIds] = useState<string[]>([]), [properties, setProperties] = useState<string[]>([]);
  const [note, setNote] = useState(''), [error, setError] = useState('');
  const [plan, setPlan] = useState<BatchPlan | null>(null), [offset, setOffset] = useState(0);
  const batch=useRef<HTMLElement>(null),noteInput=useRef<HTMLTextAreaElement>(null);
  const editing = ids.length > 0 || plan !== null;
  useEffect(() => {onEditingChange(editing); return () => onEditingChange(false);}, [editing,onEditingChange]);
  const issues = items ? items.flatMap(i => i.issues || []) : preview.issues;
  const grouped = groupPublicationIssues(issues);
  const complete = items !== null || preview.issue_count === preview.issues.length;
  const eligible = (items || []).filter(i => action === 'review' ? canReviewWarnings(i) : action === 'relations' ? i.kind === 'relation' :
    i.payload.properties && typeof i.payload.properties === 'object' && !Array.isArray(i.payload.properties) && Object.keys(i.payload.properties).length > 0);
  const choices = eligible.slice(offset, offset + 20);
  const propertyNames = [...new Set((items || []).filter(i => ids.includes(i.id)).flatMap(i => Object.keys(i.payload.properties as Record<string, unknown> || {})))];
  const off = disabled || plan !== null;
  function reset(next: BatchAction) {setAction(next); setIds([]); setProperties([]); setOffset(0); setError('');}
  function toggle(id: string) {setIds(old => old.includes(id) ? old.filter(x => x !== id) : old.length < 100 ? [...old, id] : old); setProperties([]); setError('');}
  function chooseAdvice(item:Item,next:BatchAction){
    reset(next);setIds([item.id]);setNote('');
    requestAnimationFrame(()=>{batch.current?.scrollIntoView({block:'nearest'});noteInput.current?.focus({preventScroll:true});});
  }
  return <section className="publication-validation" aria-label="发布校验与批量处理">
    <h3>发布校验结果</h3>
    <p className="validation-counts">{(Object.keys(titles) as IssueCategory[]).map(category =>
      <span key={category}>{titles[category]} {complete ? '' : '已载入 '}{grouped[category].reduce((sum, g) => sum + g.count, 0)} 项</span>)}</p>
    {!complete && <p>当前只返回前 {preview.issues.length} / {preview.issue_count} 项提示。读取完整条目后可查看全量分类和批量处理。</p>}
    <p>空缺属性不阻止发布。警告须核对原文依据后填写说明；说明不能替代来源证据。错误须修正或排除，不能通过填写说明放行。批量保存只修改草稿，仍需再次核对并确认发布。</p>
    {(Object.keys(titles) as IssueCategory[]).map(category => grouped[category].length > 0 && <details key={category} open={category === 'error' || category === 'warning'}>
      <summary>{titles[category]} · {grouped[category].length} 条事实</summary>
      {grouped[category].map(group => {
        const item = items?.find(i => i.id === group.itemId) || preview.items.find(c => c.item_id === group.itemId)?.after;
        const advice=[...new Set(group.issues.map(publicationIssueAdvice).filter((text):text is string=>!!text))];
        return <article className={`validation-fact correction-${category === 'reviewed' ? 'info' : category}`} key={group.itemId}>
          <strong>{item ? itemLabel(item) : `事实 ${group.itemId}`}</strong>
          <ul>{group.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>
          {!!advice.length&&<div className="validation-advice"><strong>处理建议</strong>{advice.map(text=><p key={text}>{text}</p>)}</div>}
          <button disabled={disabled || !!plan} onClick={() => inspect(group.itemId)}>查看事实与原文</button>
          {items&&item&&category==='warning'&&canReviewWarnings(item)&&<button disabled={off} onClick={()=>chooseAdvice(item,'review')}>核对后填写说明</button>}
          {items&&item?.kind==='relation'&&['warning','error'].includes(category)&&<button disabled={off} onClick={()=>chooseAdvice(item,'relations')}>排除这条关系</button>}
        </article>;
      })}
    </details>)}
    {items === null ? <button disabled={disabled} onClick={load}>读取完整条目，批量处理</button> : <section className="validation-batch" aria-label="批量处理" ref={batch}>
      <h4>批量处理草稿</h4>
      <label>处理方式<select value={action} disabled={off} onChange={e => reset(e.target.value as BatchAction)}>
        <option value="review">核对警告，填写共同说明</option><option value="properties">移除指定属性</option><option value="relations">排除不成立的关系</option>
      </select></label>
      <p>{action === 'review' ? '仅显示有待核对警告且没有错误的事实。请查看原文后再确认；共同说明将替换所选事实的原核对说明。' : action === 'properties' ? '显示有属性的事实。请明确选择要移除的属性，系统不会根据提示文字猜测或自动删除。' : '只排除选中的关系，保留两端实体。已发布内容在再次确认发布前不变。'}</p>
      {!eligible.length ? <div><p role="status">{action === 'review'
        ? '当前没有需要填写说明的警告，无需在此操作。有错误时请返回上方对应事实修正；如尚未选择抽取结果，请返回候选列表。'
        : action === 'relations' ? '当前草稿没有可排除的关系。若要加入本轮抽取的关系，请返回关系候选列表。'
        : '当前草稿没有可移除的属性，无需在此操作。'}</p>{returnToCandidates&&<button disabled={disabled||editing} onClick={returnToCandidates}>返回抽取候选</button>}</div> : <>
      <div className="correction-toolbar"><span>已选 {ids.length} / 100 条</span>
        <button disabled={off || !choices.length} onClick={() => {setIds(choices.map(i => i.id));setProperties([]);}}>选择本页（替换原选择）</button>
        <button disabled={off || !eligible.length} onClick={() => {setIds(eligible.slice(0,100).map(i => i.id));setProperties([]);}}>选择{eligible.length > 100 ? '前 100 条' : '全部符合条件的事实'}</button>
        <button disabled={off || !ids.length} onClick={() => {setIds([]);setProperties([]);}}>清空选择</button></div>
      {choices.map(item => <article className="validation-batch-item" key={item.id}>
        <label><input type="checkbox" disabled={off || ids.length >= 100 && !ids.includes(item.id)} checked={ids.includes(item.id)} onChange={() => toggle(item.id)}/>{itemLabel(item)} · {String(item.payload.type)}</label>
        <details><summary>属性、提示与原文依据</summary><dl>{Object.entries(item.payload.properties as Record<string,unknown> || {}).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{JSON.stringify(value)}</dd></div>)}</dl>
          <ul>{item.issues?.filter(i => i.severity !== 'info').map((issue,index) => <li key={index}>{issue.message}</li>)}</ul>
          {item.evidence.map((e,index) => <blockquote key={index}>{e.excerpt || '请打开事实查看完整原文依据'}</blockquote>)}
          {item.review_note && <p>原核对说明：{item.review_note}</p>}
          <button disabled={off} onClick={() => inspect(item.id)}>打开事实与原文</button>
        </details></article>)}
      <nav className="correction-pager"><button disabled={off || offset === 0} onClick={() => setOffset(Math.max(0,offset-20))}>上一页</button><span>{eligible.length ? offset+1 : 0}–{Math.min(offset+20,eligible.length)} / {eligible.length}</span><button disabled={off || offset+20 >= eligible.length} onClick={() => setOffset(offset+20)}>下一页</button></nav>
      {action === 'properties' && <fieldset disabled={off}><legend>明确选择要移除的属性（只移除所选事实中实际存在的属性）</legend>{propertyNames.map(key => <label key={key}><input type="checkbox" checked={properties.includes(key)} onChange={() => setProperties(old => old.includes(key) ? old.filter(k => k !== key) : [...old,key])}/>{key}</label>)}</fieldset>}
      <label>{action === 'review' ? '共同核对说明' : '处理原因'}<textarea ref={noteInput} value={note} disabled={off} maxLength={1500} onChange={e => setNote(e.target.value)} placeholder="说明原文如何支持判断，或为何移除这些内容"/></label>
      {error && <p role="alert" className="correction-error">{error}</p>}
      {!plan && <button disabled={disabled || !ids.length || !note.trim()} onClick={() => {try {setPlan(buildBatchPlan(items,ids,action,note,properties));setError('');} catch(e) {setError((e as Error).message);}}}>核对本次批量修改</button>}
      {plan && <div className="validation-batch-confirm" role="region" aria-label="确认批量修改"><h4>确认本次处理范围</h4><p>{plan.description}</p><p>说明：{note}</p>
        <ul>{[...plan.upserts.map(i => i.id),...plan.removeIds].map(id => {const item = items.find(i => i.id === id)!; return <li key={id}>{itemLabel(item)} · {id}
          {action === 'properties' && <ul>{properties.filter(key => Object.hasOwn(item.payload.properties as object,key)).map(key => <li key={key}>{key}：{JSON.stringify((item.payload.properties as Record<string,unknown>)[key])} → 移除</li>)}</ul>}</li>;})}
        </ul><button disabled={disabled} onClick={() => setPlan(null)}>返回调整</button><button disabled={disabled} onClick={() => save(plan,note.trim())}>确认保存草稿</button></div>}
      </>}
    </section>}
  </section>;
}
