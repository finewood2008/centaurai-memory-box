const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=(v,n=12)=>[...String(v||'')].length>n?[...String(v)].slice(0,n-1).join('')+'…':String(v||'');
const kindLabel=kind=>kind==='entity_types'?'实体类型':'关系类型';
const title=d=>d.label||d.name;
const names=(values,schema)=>(values||[]).map(n=>schema.entity_types?.find(e=>e.name===n)?.label||n).join('、');

function definitionHTML(d,kind,schema){
  return `<p>${esc(d.definition||'暂无定义说明')}</p>${d.classification_boundary?`<p>分类边界：${esc(d.classification_boundary)}</p>`:''}${kind==='relation_types'?`<p class="ob-relation-direction">${esc(names(d.source_types,schema))} → ${esc(names(d.target_types,schema))}</p>`:''}
    ${(d.properties||[]).length?`<ul class="ob-property-list">${d.properties.map(p=>`<li><strong>${esc(title(p))}</strong> <small>${esc(p.name)}</small> <span>${p.required?'必填':'选填'}</span>${p.definition?`<p>${esc(p.definition)}</p>`:''}</li>`).join('')}</ul>`:'<p class="ob-muted">暂无属性</p>'}`;
}

export function ontologyDefinitionsHTML(schema,prefix='ob-def'){
  return ['entity_types','relation_types'].map(kind=>`<section class="ob-definition-group"><h3>${kindLabel(kind)} · ${(schema?.[kind]||[]).length}</h3>
    ${(schema?.[kind]||[]).map((d,i)=>`<details id="${prefix}-${kind}-${i}" data-definition-key="${esc(kind+':'+d.name)}" class="ob-definition-row"><summary><strong>${esc(title(d))}</strong><small>${esc(d.name)}</small><span>${(d.properties||[]).length} 项属性</span></summary>${definitionHTML(d,kind,schema)}</details>`).join('')||'<p class="ob-muted">暂无定义</p>'}</section>`).join('');
}

export function ontologyChangesHTML(changes=[],schema={}){
  if(!changes.length)return '<p class="ob-muted">本次没有定义变化，将沿用当前规则。</p>';
  return `<ul class="ob-change-list">${changes.map(c=>{
    const status=!c.before?'新增':!c.after?'移除':'修改',d=c.after||c.before||{name:c.name};
    return `<li><div class="ob-change-heading"><span class="ob-change-badge">${status}</span><strong>${esc(title(d))}</strong><small>${kindLabel(c.kind)} · ${esc(c.name)}</small></div>
      ${c.before&&c.after?`<details><summary>查看修改前后</summary><div class="ob-change-compare"><section><h4>修改前</h4>${definitionHTML(c.before,c.kind,schema)}</section><section><h4>修改后</h4>${definitionHTML(c.after,c.kind,schema)}</section></div></details>`:definitionHTML(d,c.kind,schema)}</li>`;
  }).join('')}</ul>`;
}

export {ontologyGraphHTML} from './onboarding-network-view.mjs';
