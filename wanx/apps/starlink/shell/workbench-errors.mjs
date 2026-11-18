const sourceCodes = new Set(['SOURCE_VERSION_CONFLICT','SOURCE_NOT_READY','SOURCE_CONFIRMATION_STALE','SOURCE_OPERATION_CONFLICT']);
// Only public codes and HTTP refusal metadata cross the workbench IPC boundary.
const known = /^(?:(?:SEMANTICA|WAREHOUSE|MIGRATION|ACCESS_KEY|MODEL|MODELING|SKILL|REASONING|CORRECTION|ONTOLOGY|KNOWLEDGE|RELEASE|RESTORE|HOST_SESSION)_[A-Z_]+|INVALID_CORRECTION_[A-Z_]+|INVALID_RESOURCE|LLM_NOT_CONFIGURED)$/;
const uncertain = new Set(['SEMANTICA_CONNECTION_FAILED', 'SEMANTICA_SERVICE_TIMEOUT']);
const messages = {
  SOURCE_VERSION_CONFLICT: '正文版本已变化，请重新核对当前正文后确认。',
  SOURCE_NOT_READY: '正文尚未解析完成，请读取最新进度后再确认。',
  SOURCE_CONFIRMATION_STALE: '当前正文的确认已失效，请重新确认正文。',
  SOURCE_OPERATION_CONFLICT: '确认操作与原请求不一致，请读取最新进度后再继续。',
  INVALID_RESOURCE: '当前桌面无法转发此操作，请更新星图客户端后重试',
  SEMANTICA_OPERATION_NOT_ALLOWED: '当前万象接口尚未支持此操作，请更新万象服务后重试',
  SEMANTICA_INVALID_REQUEST: '请求参数与当前万象接口不兼容，请同步更新客户端和服务端',
  SEMANTICA_QUERY_NOT_ALLOWED: '请求查询参数与当前万象接口不兼容，请同步更新客户端和服务端',
  CORRECTION_RELATIONS_REQUIRE_ACTION: '此实体仍有关联关系，请先调整关系，或使用“移除条目”一并移除实体与关联关系',
  CORRECTION_REVISION_CONFLICT: '草稿已变化，请刷新后重试',
  CORRECTION_BASE_CHANGED: '草稿基础已变化，请重新核对',
  CORRECTION_BASE_NOT_READY: '材料知识尚未就绪，请先完成处理',
  CORRECTION_REVIEW_NOT_READY: '当前没有可核对的自动抽取结果，请刷新材料状态；不会打开旧候选',
  CORRECTION_REVIEW_CHANGED: '本轮候选或草稿绑定已变化，请保留已保存内容并重新读取当前结果',
  CORRECTION_PUBLICATION_PENDING: '发布任务尚未结束，请稍后重新核对',
  CORRECTION_SESSION_REQUIRED: '知识核对缺少编辑会话，请更新并重新打开星图客户端',
  CORRECTION_SESSION_CONFLICT: '草稿由另一个页面持有，请明确恢复后继续核对',
  CORRECTION_LEASE_EXPIRED: '编辑会话已暂停，已保存内容保留，请恢复草稿',
  CORRECTION_LEASE_CHANGED: '编辑归属已变化，请重新恢复草稿',
  CORRECTION_CLAIM_REQUIRED: '历史草稿尚未认领，请核对后确认认领',
  CORRECTION_OCCUPIED: '其他用户正在编辑此材料，请稍后重试',
  CORRECTION_BASE_INCOMPLETE: '已发布知识记录不完整，请先检查发布状态',
  SEMANTICA_UPGRADE_REQUIRED: '知识管理接口版本不匹配，请更新后端及星图客户端',
  SEMANTICA_SERVICE_TIMEOUT: '处理等待超时，请先刷新核对操作结果，再决定是否重试',
  SEMANTICA_INDEX_REQUIRED: '当前数据仓需要先建立检索索引。请在上方查看索引状态。',
  SEMANTICA_INDEX_STALE: '材料已有更新。请在上方查看索引进度，完成后再检索。',
  SEMANTICA_NO_PARSED_CONTENT: '请等至少一份材料解析完成，再建立检索索引。',
  SEMANTICA_EMBEDDING_NOT_CONFIGURED: '当前数据仓尚未配置检索向量模型。请在模型设置中检查。',
  ONTOLOGY_CONSTRAINT: '类型或关系不符合本体约束，请检查当前规则后调整',
  ONTOLOGY_CONTEXT_TOO_SMALL: '所选材料或类型规则超过模型上下文预算，请减少选择后重试',
  ONTOLOGY_INVALID_OUTPUT: '模型未返回有效建议，请检查处理模型后重新生成',
  ONTOLOGY_MODEL_FAILED: '本体建议生成失败，请检查处理模型后重试',
  ONTOLOGY_MODEL_TIMEOUT: '本体建议生成超时，请稍后重新生成',
  ONTOLOGY_OPERATION_CONFLICT: '此操作标识已用于其他配置，请刷新版本列表核对后重新提交',
  ONTOLOGY_OWNER_REQUIRED: '当前会话不能管理本体，请确认账号及数据仓权限',
  ONTOLOGY_SOURCE_MISMATCH: '本体建议与所选来源不一致，请核对材料后重新生成',
  ONTOLOGY_SOURCE_NOT_FOUND: '建议来源材料不存在或不可访问，请刷新材料列表',
  ONTOLOGY_SOURCE_NOT_READY: '材料正文尚未就绪，请等待处理完成后重试',
  ONTOLOGY_SUGGESTION_BUSY: '正在生成本体建议，请等待当前请求完成',
  ONTOLOGY_SUGGESTION_EXPIRED: '本体建议已过期，请重新生成后再保存',
  ONTOLOGY_SUGGESTION_STALE: '类型规则或来源材料已变化，请刷新后重新生成建议',
  ONTOLOGY_TARGET_CHANGED: '目标类型规则已变化，请刷新并重新核对',
  ONTOLOGY_UPDATE_BUSY: '本体更新仍在处理中，请等待任务结束',
  ONTOLOGY_UPDATE_CONFIRMATION_REQUIRED: '本体更新需要确认，请核对影响范围后再提交',
  ONTOLOGY_UPDATE_STALE: '本体更新的基础已变化，请刷新后重新核对',
  RELEASE_DOCUMENT_UNAVAILABLE: '此版本的材料已删除或不可访问，请选择其他材料',
  RELEASE_ITEM_NOT_FOUND: '发布版本中的条目不存在，请刷新版本详情',
  RELEASE_NOT_FOUND: '发布版本不存在或不可访问，请刷新版本列表',
  RELEASE_PROJECTION_INCOMPLETE: '发布结果尚不完整，请检查发布任务后再查看版本',
  RESTORE_CONFIRMATION_REQUIRED: '恢复需要明确确认，请核对恢复预览后再提交',
  RESTORE_KNOWLEDGE_UNAVAILABLE: '此历史材料没有可恢复的已发布知识，请选择其他版本',
  RESTORE_NOTE_INVALID: '恢复说明不符合要求，请修改后重新提交',
  RESTORE_PREVIEW_STALE: '恢复预览已变化，请重新预览并确认',
  RESTORE_SNAPSHOT_INCOMPLETE: '历史快照不完整，无法恢复，请选择其他完整版本',
};
export function workbenchErrorReply(error) {
  const code = typeof error?.code === 'string' && error.code.length <= 96 && (known.test(error.code) || sourceCodes.has(error.code)) ? error.code : 'SEMANTICA_REQUEST_FAILED';
  const status = !uncertain.has(code) && Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 0;
  return { ok: false, code, status, message: messages[code] || '知识操作未完成，请重试或重新核对' };
}
export function workbenchFailure(value, status) {
  const reply = workbenchErrorReply({ code: value?.code || (status === 404 ? 'SEMANTICA_UPGRADE_REQUIRED' : undefined), status });
  return Object.assign(new Error(reply.message), { code: reply.code, status: reply.status, publicMessage: reply.message });
}
