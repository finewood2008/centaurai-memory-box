const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const btn=(action,label,off=false,index='')=>`<button type="button" class="btn btn-secondary" data-cv="evidence-${action}" data-index="${esc(index)}" ${off?'disabled':''}>${label}</button>`;
export function evidenceHelpHTML(flow,{questions=false}={}){
  const c=flow?.changes;if(!flow?.evidence||c.independent||!c.state.selected.length)return '';
  const off=flow.state.busy||!!c.record.pending,available=c.owner?.draftId&&c.state.summary?.status==='editing'&&!c.state.summary.stale_reason;
  return `<section class="cv-evidence-help"><p>纠正分类时保留对象的原文引用；未提供的属性可以留空。修改名称或属性时，可选择原文帮助核对。</p>${questions?btn('classification','仅调整分类，重新建议',off):''}${available?btn('open','查看／选择原文',off):''}<p class="muted">用业务语言说明即可，无需填写原文技术编号。引用原文后仍需生成建议并确认保存。</p></section>`;
}
export function evidencePickerHTML(flow){
  const p=flow?.evidence?.state;if(!p)return '';
  const off=flow.state.busy||!!flow.changes.record.pending,page=p.page;
  return `<section class="cv-evidence-picker" aria-label="选择材料原文"><header><h3>选择材料原文</h3>${btn('close','收起原文',off)}</header><p>打开原文片段，选中需要引用的文字，再放入对话参考。</p><div class="cv-source-choices">${page.items.map((item,index)=>`<button type="button" class="btn btn-secondary" data-cv="evidence-read" data-index="${index}" ${off?'disabled':''}>第 ${esc(page.offset+index+1)} 段 · ${esc(String(item.text||'').slice(0,60))}</button>`).join('')||'<p>当前材料没有可读取的原文片段。</p>'}</div><div class="conversation-toolbar">${btn('prev','上一页',off||page.offset===0)}<span>原文片段 ${page.total?`${page.offset+1}–${page.offset+page.items.length}`:'0'} / ${page.total}</span>${btn('next','下一页',off||page.offset+page.items.length>=page.total)}</div>${p.source?`<label for="cv-evidence-text">在以下原文中选中文字</label><textarea id="cv-evidence-text" rows="7" readonly>${esc(p.source.text)}</textarea>${p.source.end<p.source.total_chars?'<p class="muted">当前仅显示这段原文的一部分。</p>':''}${btn('window-prev','上一部分',off||p.source.start===0)}${btn('window-next','下一部分',off||p.source.end>=p.source.total_chars)}${btn('quote','引用选中原文到对话',off)}<p>这里只添加对话参考，不修改材料或草稿引用。</p>`:''}</section>`;
}
export function evidenceReferenceHTML(flow){
  const ref=flow?.evidence?.displayedReference;if(!ref)return flow?.evidence&&!flow.changes.independent&&flow.changes.owner?.draftId&&flow.changes.state.selected.length?btn('open','查看原文，引用到对话',flow.state.busy||!!flow.changes.record.pending):'';
  return `<aside class="cv-evidence-reference"><strong>${ref.unbound?'原文参考 · 定位需重新选择':'原文参考 · 待服务端核对'}</strong><blockquote>${esc(ref.quote)}</blockquote>${ref.unbound?btn('open','重新选择原文',flow.state.busy||!!flow.changes.record.pending||!flow.changes.owner?.draftId):''}${btn('clear','取消原文参考',flow.state.busy||!!flow.changes.record.pending)}<small>${ref.unbound?'已恢复引用文字，未恢复原文定位或编辑凭据；可重新选择原文供核对。':'原文已放入输入框；修改要求仍需发送，保存需另行确认。'}</small></aside>`;
}
