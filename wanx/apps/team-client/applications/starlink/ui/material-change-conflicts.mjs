import {factContext,factName,factSchema} from './material-fact-cards.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const changeConflictNotice='修改存在约束冲突，尚未写入草稿。请先核对受影响的条目；可取消本轮建议，返回草稿继续调整。';
export function hasChangeConflicts(result){return !!(Array.isArray(result?.conflicts)&&result.conflicts.length||Number.isSafeInteger(result?.conflict_count)&&result.conflict_count>0);}
export function changeConflictsHTML(result,flow){
  if(!hasChangeConflicts(result))return '';
  const conflicts=(Array.isArray(result.conflicts)?result.conflicts:[]).filter(c=>c&&typeof c==='object').slice(0,20),total=Math.max(conflicts.length,Number.isSafeInteger(result.conflict_count)?result.conflict_count:0);
  const schema=factSchema(flow),context=factContext(flow),types=[...(schema?.entity_types||[]),...(schema?.relation_types||[])];
  const label=(name,kind)=>{
    const scoped=kind==='relation'?schema?.relation_types:kind==='entity'?schema?.entity_types:types;
    return scoped?.find(t=>t.name===name)?.label||types.find(t=>t.name===name)?.label;
  };
  const readable=(value,kind)=>String(value||'').replace(/\b[A-Za-z][A-Za-z0-9_]*\b/g,name=>label(name,kind)||name);
  const name=c=>{
    const known=context.find(i=>i.id===(c.item_id||c.object?.item_id));if(known)return factName(known,context,schema);
    const value=typeof c.object?.name==='string'?c.object.name:'';
    const typeLabel=label(value,c.object?.kind);
    if(typeLabel)return typeLabel;
    return value&&!/^[A-Z][A-Z0-9_]*$/.test(value)&&!/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value)?value:c.object?.kind==='relation'?'受影响的关系':'受影响的条目';
  };
  return `<section class="cv-change-conflicts" role="status"><h3>修改暂不能应用 · ${total} 项冲突</h3><p>这次建议尚未写入草稿。请核对受影响条目后重新生成建议，不会自动删除关系或扩大选择范围。</p>${conflicts.map(c=>`<article><strong>${esc(name(c))}</strong><p>${esc(readable(c.message,c.object?.kind)||'分类、关系端点或来源需要进一步核对。')}</p>${c.suggested_handling?`<p>建议处理：${esc(readable(c.suggested_handling,c.object?.kind))}</p>`:''}</article>`).join('')}${result.conflicts_truncated||total>conflicts.length?`<p>当前仅显示 ${conflicts.length} 项，共 ${total} 项。请缩小调整范围，或先核对已列出的问题后重新生成建议。</p>`:''}</section>`;
}
