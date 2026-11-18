import {changesDiff} from './conversation-changes-view.mjs';
import {ontologyDefinitionsHTML} from './onboarding-ontology-view.mjs';
import {evidenceHelpHTML} from './material-evidence-view.mjs';
import {changeConflictsHTML,hasChangeConflicts} from './material-change-conflicts.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(action,label,off)=>`<button type="button" class="btn btn-secondary" data-cv="instruction-${action}" ${off?'disabled':''}>${label}</button>`;
const names={facts:'调整选中条目',goal:'调整本材料整理目标',rules:'调整仓库本体规则',publish_rules:'发布本体规则',extract:'重新抽取当前材料'};
export function instructionPanel(flow){
  const controller=flow.instructions,p=controller.plan,s=controller.step,off=flow.state.busy||!!flow.changes.record.pending;
  if(!p)return `<section class="cv-instruction-plan"><p>有尚未完成的对话建议，已保存的草稿保留。</p>${flow.changes.record.instructionPrivate&&!flow.changes.owner?.draftId?`<p>请先恢复草稿编辑权，再读取建议。</p><button type="button" class="btn btn-secondary" data-cv="change-open-draft" ${off?'disabled':''}>恢复草稿编辑</button>${flow.changes.state.leases?.map(lease=>`<button type="button" class="btn btn-secondary" data-cv="change-claim" data-id="${esc(lease.draft_id||lease.id)}" ${off?'disabled':''}>确认接管草稿编辑</button>`).join('')||''}`:button('read','恢复本轮建议',off)}</section>`;
  const preview=s?.preview,summary=p.interpretation?.summary||p.reason||'',questions=preview?.result?.questions||p.interpretation?.questions||[];
  const conflicts=hasChangeConflicts(preview?.result);
  const changes=preview?.result?.changes||[],prepared=p.status==='ready'&&s?.status==='prepared'&&!p.read_only&&(s.kind!=='change'||preview?.status==='prepared'&&preview.can_apply===true&&!conflicts);
  const titles={ready:prepared?'核对修改建议':'本轮处理计划',generating:'正在识别你的要求',needs_clarification:'请补充说明',blocked:'建议尚不能应用',unsupported:'这条要求暂不能完整执行',failed:'本轮建议生成未完成'};
  return `<section class="cv-instruction-plan mw-proposal-review" aria-label="本轮对话建议"><h3>${esc(titles[p.status]||'本轮对话建议')}</h3>
    <p class="cv-change-instruction">${esc(flow.changes.record.instructionUserText||summary)}</p><p>${esc(summary)}</p>
    ${p.steps.length>1?`<ol>${p.steps.map(step=>`<li>${esc(names[step.kind]||names[step.scope]||'核对修改')} · ${step.status==='completed'?'已确认':step.id===s?.id?'当前待核对':'等待前一步确认'}</li>`).join('')}</ol>`:''}
    ${questions.length?`<ul>${questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul><p>直接在右侧回复补充内容，会重新生成建议供你核对。</p>`:''}
    ${preview?.result?.summary?`<p>${esc(preview.result.summary)}</p>`:''}
    ${preview?.result?.coverage?`<p class="cv-reading-coverage">本轮读取 ${esc(preview.result.coverage.sampled_segments)} / ${esc(preview.result.coverage.total_segments)} 段。${preview.result.coverage.partial?'仅覆盖部分原文，不能视为通读全文。':''}</p>`:''}
    ${preview?.status!=='stale'?changeConflictsHTML(preview?.result,flow):''}
    ${changes.length?changesDiff(changes,flow):''}
    ${s?.scope==='facts'||p.context?.selected_item_ids?.length?evidenceHelpHTML(flow,{questions:questions.length>0}):''}
    ${s?.kind==='publish_rules'&&preview?.schema?`<p>仅发布仓库本体规则；历史材料不会自动重新抽取。</p>${ontologyDefinitionsHTML(preview.schema,'instruction-rule-preview')}`:''}
    ${s?.kind==='extract'&&preview?`<p>${s.mode==='dialogue'?'按本轮已确认的整理目标进行对话抽取。':'按当前正文与已发布本体自动抽取，不沿用历史对话目标。'}</p><p>${preview.publication_policy==='automatic'?'完成后自动发布有效结果。':'结果需要核对后另行发布。'}</p>${preview.replacement?`<p>${esc(preview.replacement.description||'本次处理将替代旧的处理轮次，原已发布知识在新结果生效前继续保留。')}</p><p>旧草稿 ${esc(preview.replacement.draft_count??0)} 份；旧候选结果 ${esc(preview.replacement.candidate_result_count??0)} 组。${preview.replacement.preserves_history?'旧草稿和候选将转为历史，新任务失败时不会自动恢复编辑。':''}</p>${preview.replacement.requires_acknowledgement?`<label><input type="checkbox" id="cv-instruction-ack" ${flow.changes.state.instructionAcknowledged?'checked':''} ${off?'disabled':''}>我已了解替代旧草稿及候选的影响</label>`:''}`:''}`:''}
    ${prepared?`${button('confirm',s.kind==='change'?'确认应用到草稿':s.kind==='publish_rules'?'确认发布本体规则':'确认开始抽取',off||!!preview?.replacement?.requires_acknowledgement&&!flow.changes.state.instructionAcknowledged)}<p>${s.kind==='change'?'确认只保存修改，尚未发布。可以继续对话调整建议，或取消本轮建议。':'确认仅执行当前步骤，后续步骤仍需核对。'}</p>`:''}
    ${p.status==='ready'&&s?.status==='pending'?button('prepare','查看下一步预览',off):''}
    ${p.status==='generating'?button('read','读取识别结果',off):''}
    ${!p.read_only?button('abandon','取消尚未确认的建议',off):'<p>本轮已转为历史，仅供查看。</p>'}
    ${['unsupported','failed','blocked'].includes(p.status)&&!questions.length?'<p>本轮没有自动执行剩余操作。请在右侧明确要调整的条目与内容，或取消本轮建议后继续。</p>':''}
  </section>`;
}
