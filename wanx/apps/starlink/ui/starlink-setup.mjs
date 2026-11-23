import {identityKey} from '../shared/onboarding-contract.mjs';
import {knowledgeCurrent, publicationCurrent} from './conversation-progress.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
})[char]);
const steps = ['新建星图', '确认整理规则', '导入并核对资料', '查看星图'];

// Only guided warehouses that actually confirmed their rules enter this flow.
// Empty graph counts alone cannot distinguish an existing warehouse from a new one.
export function readStarlinkSetup(storage, identity, warehouseId) {
  if (identity?.dataScope !== 'personal' || !warehouseId) return null;
  try {
    const record = JSON.parse(storage.getItem(key(identity, warehouseId)) || 'null');
    return record?.warehouseId === warehouseId && record.phase === 'first-material' ? record : null;
  } catch {
    return null;
  }
}

function key(identity, warehouseId) {
  return 'starlink.first-graph.v1.' + identityKey(identity) + '.' + warehouseId;
}

export function saveStarlinkSetup(storage, identity, warehouseId, record) {
  if (identity?.dataScope !== 'personal' || !warehouseId) return;
  const storageKey = key(identity, warehouseId);
  if (record) storage.setItem(storageKey, JSON.stringify({...record, warehouseId, phase:'first-material'}));
  else storage.removeItem(storageKey);
}

export function setupMaterial(flow) {
  const detail = flow?.state.detail;
  const confirmed = publicationCurrent(detail) || knowledgeCurrent(detail, flow?.state.knowledge);
  if (!detail?.document_id || !detail.document_version_id || !confirmed || !detail.outcome?.current_run_id) return null;
  return {documentId:detail.document_id, versionId:detail.document_version_id, runId:detail.outcome.current_run_id};
}

export function firstSourceEdge(edges, material, hasCitation) {
  if (!material?.documentId || !material.versionId || !material.runId) return null;
  return edges.find(edge => edge.evidence.some(source => source.document_id === material.documentId &&
    (source.document_version_id || source.version_id) === material.versionId &&
    hasCitation(source))) || null;
}

export function starlinkSetupSteps(step) {
  return `<ol class="starlink-setup-steps" aria-label="建立星图的进度">${steps.map((label, index) =>
    `<li ${index===step?'aria-current="step"':''} class="${index<step?'is-done':''}">${label}</li>`).join('')}</ol>`;
}

export function starlinkMaterialSetup({flow, record, ready, setupUnavailable}) {
  const detail = flow?.state.detail;
  const material = setupMaterial(flow);
  let message = '整理规则已确认。选一份最能回答星图目标的资料，先用它建立第一批关系。';
  let actions = '';
  if (setupUnavailable) {
    message = '这台盒子暂未提供材料核对服务。你的整理规则已保存。';
  } else if (!flow?.state.loaded) {
    message = flow?.state.error || '正在读取星图进度…';
  } else if (ready) {
    message = '核对后的关系已加入星图，可以点开关系查看原文。';
    actions = '<button type="button" class="btn btn-primary" data-action="first-starlink-open">查看星图</button>';
  } else if (material) {
    message = '已保存核对结果，正在确认星图里是否有可追溯的关系。也可以换一份更贴合目标的资料。';
    actions = '<button type="button" class="btn btn-secondary" data-action="first-starlink-open">检查星图</button>';
  } else if (detail?.document_id) {
    message = '我会沿用星图目标整理这份资料。先确认正文，再核对候选与原文，最后把认可的关系加入星图。';
  }
  const canAdjust=detail?.status==='awaiting_review' && !flow.state.busy && !flow.saved.pending && !flow.changes.record.pending &&
    !flow.state.openMaterialEditor && !material;
  return `<section class="starlink-setup-intro" aria-label="建立星图">
    ${starlinkSetupSteps(ready?3:2)}
    <div class="starlink-setup-summary"><div><h2>${ready?'第一批关系已就绪':detail?.document_id?'整理第一份资料':'导入第一份资料'}</h2>
      ${record.goal?`<p class="starlink-setup-goal"><strong>星图目标</strong> ${escape(record.goal)}</p>`:''}
      <p role="status">${escape(message)}</p></div><div class="starlink-setup-actions">
      ${actions}
      ${canAdjust?'<button type="button" class="btn btn-secondary" data-action="update-warehouse-rules">调整整理规则</button>':''}
      ${flow?.state.error||setupUnavailable?`<button type="button" class="btn btn-secondary" data-action="first-starlink-models">检查模型设置</button>`:''}
      </div></div></section>`;
}
