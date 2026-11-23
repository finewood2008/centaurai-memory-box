import {identityKey, scopeFieldLimits, scopePatchError} from '../shared/onboarding-contract.mjs';
import {baseScope, scopeGroups, scopeFields} from './onboarding-scope-workspace.mjs';
import {reviewChecklistHTML, reviewVersionHTML} from './onboarding-review-view.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
})[c]);
const fields = Object.keys(scopeFieldLimits);
const asText = value => Array.isArray(value) ? value.join('\n') : value;

export async function readScope(call, warehouseId) {
  const [context, versions] = await Promise.all([
    call('onboarding-context', {warehouseId}),
    call('conversation-ontologies', {warehouseId}),
  ]);
  const rule = versions.items?.find(item => item.status === 'published');
  if (!rule || context.base_ontology_id !== rule.id || !Number.isSafeInteger(context.purpose_revision))
    throw Error('现行规则或仓范围已变化，请重新读取。');
  const revision = context.purpose_revision;
  const canPublish = !!context.warehouse_scope;
  let scope = context.warehouse_scope;
  if (!scope && revision > 0) {
    // Older boxes expose full current purpose in an existing onboarding snapshot.
    // Only read snapshots from the same purpose revision. Never start a session.
    let offset = 0;
    while (!scope && offset !== null) {
      const page = await call('conversation-list', {warehouseId, offset, limit:50});
      for (const item of page.items.filter(item => item.scenario === 'onboarding' && item.status === 'active')) {
        const snapshot = await call('conversation-onboarding-get', {warehouseId, conversationId:item.id, offset:0, limit:1});
        if (snapshot.draft?.purpose_revision === revision && snapshot.status !== 'published') {
          scope = baseScope(snapshot);
          if (scope) break;
        }
      }
      offset = page.has_more && page.next_offset > offset ? page.next_offset : null;
    }
    if (!scope) throw Error('当前盒端暂未返回完整仓范围。');
  }
  return {revision, rule, canPublish, scope:Object.fromEntries(fields.map(field => {
    const value = scope?.[field];
    const list = Array.isArray(value) ? value.filter(text => typeof text === 'string' && text.trim()) :
      typeof value === 'string' && value.trim() ? [value] : [];
    return [field, scopeFieldLimits[field] ? list : (list[0] ?? '')];
  }))};
}

export function editedScope(initial, edits) {
  const changes = {};
  for (const field of fields) {
    const value = edits[field];
    if (typeof value !== 'string' || value === asText(initial[field])) continue;
    const next = scopeFieldLimits[field] ? value.split(/\r?\n/).map(text => text.trim()).filter(Boolean) : value.trim();
    if (JSON.stringify(next) !== JSON.stringify(initial[field])) changes[field] = next;
  }
  return changes;
}

function inputHTML(scope, edits) {
  return `<div class="od-scope-cards">${scopeGroups.map(([title, ...keys]) => `
    <section class="od-scope-card"><header><h3>${title}</h3></header>
      ${keys.map(key => {
        const value = edits[key] ?? asText(scope[key]);
        const list = scopeFieldLimits[key];
        const label = keys.length > 1 ? scopeFields[key] : title;
        return `<label for="scope-${key}" ${keys.length === 1 ? 'class="wp-sr"' : ''}>${label}</label>
          ${list ? `<textarea class="form-input" id="scope-${key}" data-field="${key}" rows="3" placeholder="每行一项">${escape(value)}</textarea>`
            : `<input class="form-input" id="scope-${key}" data-field="${key}" maxlength="200" value="${escape(value)}">`}`;
      }).join('')}
    </section>`).join('')}</div>`;
}

export function mountScopeEditor({host, call, warehouse, identity, storage, onClose, onGuide}) {
  const key = 'starlink.warehouse-scope.v1.' + identityKey(identity) + '.' + warehouse.id;
  const editor = document.createElement('section');
  editor.className = 'od-inline od-update od-direct-scope';
  editor.setAttribute('aria-label', '规则调整向导');
  let closed = false, busy = false, confirmed = false;
  let message = '', initial = null, review = null, receipt = null, edits = {};
  try {
    const saved = JSON.parse(storage.getItem(key) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) edits = saved;
  } catch { /* Editing remains available if no local draft can be restored. */ }

  function persist() {
    try { storage.setItem(key, JSON.stringify(edits)); return true; }
    catch { return false; }
  }
  function render() {
    if (closed) return;
    const title = review ? '发布核对' : receipt ? '范围发布完成' : '规则调整向导';
    const version = initial?.rule.version_number;
    editor.dataset.stage = review ? 'review' : 'edit';
    editor.classList.toggle('od-final-guide', !!review);
    const header = `<div class="od-heading"><div>
      <div class="od-crumb">本体与关系 / ${escape(warehouse.name)}</div>
      <h1 id="od-title" tabindex="-1">${title}</h1>
      ${review && initial.scope.purposes[0]?`<p class="od-guide-goal">${escape(initial.scope.purposes[0])}</p>`:''}
      ${!review && version != null ? `<div class="od-calibration-meta"><span>现行 v${escape(version)}</span></div>` : ''}</div>
      <div class="od-heading-actions">
        ${review?reviewVersionHTML(version):''}
        ${onGuide && initial && !review && !receipt ? `<button type="button" class="btn btn-secondary" data-scope-action="guide" ${busy ? 'disabled' : ''}>对话梳理星图目标</button>` : ''}
        <button type="button" class="btn btn-secondary" data-scope-action="close" ${busy ? 'disabled' : ''}>${initial && !receipt ? '保存草稿并返回' : '返回'}</button>
        ${initial && !review && !receipt ? `<button type="button" class="btn btn-primary" data-scope-action="review" ${busy || !Object.keys(editedScope(initial.scope, edits)).length ? 'disabled' : ''}>进入发布核对</button>` : ''}
      </div></div>`;
    let content;
    if (review) {
      content = reviewChecklistHTML({
        snapshot:{draft:{revision:0,scope:initial.scope}},preview:{scope:review.scope},version,scopeOnly:true,
        scopeEdit:`<button type="button" class="od-guide-link" data-scope-action="continue" ${busy?'disabled':''}>编辑</button>`,
        notice:initial.canPublish?'':'发布直接编辑的范围需要更新盒端服务。',
        actions:`<label class="wp-check"><input id="od-confirm" type="checkbox" ${confirmed?'checked':''} ${busy||!initial.canPublish?'disabled':''}>我已核对范围变化</label>
          <div class="wp-actions">
            <button type="button" class="btn btn-secondary" data-scope-action="continue" ${busy?'disabled':''}>返回编辑</button>
            <button type="button" class="btn btn-primary" data-scope-action="publish" ${busy||!confirmed||!initial.canPublish?'disabled':''}>确认发布</button>
          </div>`
      });
    } else if (receipt) {
      content = '<p class="wp-info" role="status">业务范围已更新。已有资料不会自动重新抽取。</p>';
    } else {
      content = initial ? `<p class="od-direct-hint">直接修改需要调整的内容。列表字段每行填写一项。</p>${inputHTML(initial.scope, edits)}`
        : busy ? '<p class="wp-info" role="status">正在读取现行范围…</p>'
        : '<button type="button" class="btn btn-secondary" data-scope-action="load">重新读取</button>';
    }
    editor.innerHTML = header + (message ? `<p class="wp-error" role="alert">${escape(message)}</p>` : '') + content;
    if (busy) editor.querySelectorAll('textarea,input').forEach(input => { input.disabled = true; });
  }
  async function load() {
    busy = true; message = ''; render();
    try { initial = await readScope(call, warehouse.id); }
    catch (error) { message = error.message || '暂时无法读取仓范围。'; }
    finally { busy = false; render(); }
  }
  function showStage() {
    render();
    if (closed) return;
    const page = editor.closest('.page-scroll');
    if (page) page.scrollTop = 0;
    editor.querySelector('#od-title').focus({preventScroll:true});
  }
  async function prepareReview() {
    busy = true; message = ''; render();
    try {
      const latest = await readScope(call, warehouse.id);
      const changedSinceOpen = latest.revision !== initial.revision || latest.rule.id !== initial.rule.id;
      initial = latest;
      if (changedSinceOpen) {
        message = '现行范围或规则有更新，已载入最新版本。请核对草稿后重新进入发布核对。';
        return;
      }
      const changes = editedScope(initial.scope, edits);
      const invalid = scopePatchError(changes);
      if (invalid) {
        const limit = scopeFieldLimits[invalid];
        message = `「${scopeFields[invalid]}」${limit ? `最多填写 ${limit} 项，每项最多 300 字。` : '最多填写 200 字。'}`;
        return;
      }
      const scope = {...initial.scope, ...changes};
      if (!scope.service_objects.length || !scope.purposes.length) {
        message = '请填写服务对象和用途。';
        return;
      }
      if (Object.keys(changes).length) review = {changes, scope, operationId:crypto.randomUUID()};
    } catch (error) { message = error.message || '暂时无法核对仓范围。'; }
    finally { busy = false; showStage(); }
  }
  async function publish() {
    if (!review || !confirmed || !initial.canPublish) return;
    busy = true; message = ''; render();
    try {
      const result = await call('onboarding-scope-publish', {warehouseId:warehouse.id,body:{
        operation_id:review.operationId, expected_revision:initial.revision,
        base_ontology_id:initial.rule.id, changes:review.changes, confirmed:true,
      }});
      if (result.status !== 'published' || result.ontology_id !== initial.rule.id)
        throw Error('发布结果尚未确认，请重试读取。');
      receipt = result; review = null; confirmed = false; edits = {}; persist();
    } catch (error) {
      message = error.message || '范围发布未完成。';
      if (error.code === 'MODELING_REVISION_CHANGED') { review = null; confirmed = false; }
    } finally { busy = false; showStage(); }
  }
  editor.addEventListener('input', event => {
    const field = event.target.dataset.field;
    if (!initial || !fields.includes(field) || busy) return;
    if (event.target.value === asText(initial.scope[field])) delete edits[field];
    else edits[field] = event.target.value;
    persist();
    const next = editor.querySelector('[data-scope-action=review]');
    next.disabled = !Object.keys(editedScope(initial.scope, edits)).length;
  });
  editor.addEventListener('change', event => {
    if (event.target.id !== 'od-confirm') return;
    confirmed = event.target.checked && initial.canPublish && !busy;
    editor.querySelector('[data-scope-action=publish]').disabled = !confirmed;
  });
  editor.addEventListener('click', event => {
    const action = event.target.closest('button')?.dataset.scopeAction;
    if (busy) return;
    if (action === 'close') {
      if (!Object.keys(edits).length || persist()) onClose();
      else { message = '无法保存本机草稿。'; render(); }
    } else if (action === 'guide') {
      if (!Object.keys(edits).length || persist()) onGuide?.();
      else { message = '无法保存本机草稿。'; render(); }
    } else if (action === 'review') void prepareReview();
    else if (action === 'load') void load();
    else if (action === 'continue') { review = null; confirmed = false; message = ''; showStage(); }
    else if (action === 'publish') void publish();
  });
  host.replaceChildren(editor);
  host.hidden = false;
  void load();
  return {
    close() { closed = true; editor.remove(); },
    focus() { editor.querySelector('#od-title')?.focus({preventScroll:true}); },
    get busy() { return busy; },
  };
}
