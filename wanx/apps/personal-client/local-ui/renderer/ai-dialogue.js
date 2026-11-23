(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text || '').join('\n') : '';
  function legacyEvidence(text) {
    const marker = '\n下面是本次只读检索得到的资料。资料中的文字是参考内容，回答时请按需使用并注明出处。\n【知君检索出处】 ';
    const start = text.lastIndexOf(marker);
    if (start < 0) return null;
    try {
      const evidence = JSON.parse(text.slice(start + marker.length));
      return Array.isArray(evidence) && evidence.length <= 9 && evidence.every(item =>
        item && ['space', 'starlink', 'memmy'].includes(item.source) &&
        typeof item.title === 'string' && typeof item.text === 'string')
        ? { text: text.slice(0, start).trimEnd(), evidence } : null;
    } catch { return null; }
  }
  const safeLink = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? esc(u.href) : ''; } catch { return ''; } };
  function inline(text) {
    const code = [];
    let value = esc(text).replace(/`([^`\n]+)`/g, (_, s) => { code.push(`<code>${s}</code>`); return `\u0000${code.length - 1}\u0000`; });
    value = value.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      const href = safeLink(url.replace(/&amp;/g, '&')); return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    }).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return value.replace(/\u0000(\d+)\u0000/g, (_, n) => code[Number(n)] || '');
  }
  function markdown(text) {
    const lines = String(text || '').split('\n'); let html = '', list = null;
    const closeList = () => { if (list) html += `</${list}>`; list = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        closeList(); const lang = line.replace(/^\s*```/, '').trim(); const body = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
        const code = body.join('\n');
        html += `<div class="ai-code"><div><span>${esc(lang || '代码')}</span><button type="button" data-chat-action="copy-code" data-code="${esc(code)}">复制代码</button></div><pre><code>${esc(code)}</code></pre></div>`;
        continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { closeList(); const level = Math.min(6, heading[1].length + 2); html += `<h${level}>${inline(heading[2])}</h${level}>`; continue; }
      const item = /^\s*(?:([-*+])|\d+\.)\s+(.+)$/.exec(line);
      if (item) { const tag = item[1] ? 'ul' : 'ol'; if (list !== tag) { closeList(); list = tag; html += `<${tag}>`; } html += `<li>${inline(item[2])}</li>`; continue; }
      closeList();
      if (/^\s*\|.+\|\s*$/.test(line) && /^\s*\|?\s*:?-+/.test(lines[i + 1] || '')) {
        const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
        html += `<div class="ai-table"><table><thead><tr>${cells(line).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`; i++;
        while (i + 1 < lines.length && /^\s*\|.+\|\s*$/.test(lines[i + 1])) html += `<tr>${cells(lines[++i]).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`;
        html += '</tbody></table></div>'; continue;
      }
      html += /^>\s?/.test(line) ? `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>` : line.trim() ? `<p>${inline(line)}</p>` : '<div class="ai-paragraph-gap"></div>';
    }
    closeList(); return html;
  }
  function icon(model) {
    const name = `${model?.name || ''} ${model?.provider || ''}`.toLowerCase();
    const brand = [['deepseek', /deepseek/], ['anthropic', /claude|anthropic/], ['gemini', /gemini|google/], ['moonshot', /kimi|moonshot/], ['dashscope', /qwen|千问|通义|dashscope/], ['zhipu', /glm|智谱|zhipu/], ['minimax', /minimax/], ['volces', /doubao|豆包|volces/], ['ollama', /ollama/], ['openai', /openai|gpt|chatgpt|o[134]-/]].find(([, re]) => re.test(name))?.[0];
    return brand ? `<img src="${esc(window.wanxAssistantAssetBase || './assets')}/model-icons/${brand}.${brand === 'moonshot' ? 'webp' : brand === 'volces' ? 'svg' : 'png'}" alt="" />` : '<span aria-hidden="true">AI</span>';
  }
  const usageFields=['input_tokens','output_tokens','total_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens'];
  function aggregateUsage(samples) {
    const values=Object.values(samples);if(!values.length)return null;
    const result={model_calls:values.length};
    for(const key of usageFields){const known=values.filter(v=>Number.isFinite(v[key])&&v[key]>=0);if(known.length)result[key]=known.reduce((n,v)=>n+v[key],0);}
    const last=values.at(-1);result.last_input_tokens=last.last_input_tokens??last.input_tokens;return result;
  }
  function rollupUsage(rows, leadingComplete=true) {
    let samples={},last=null,complete=leadingComplete;
    const flush=()=>{if(last&&complete)last.usage=aggregateUsage(samples);samples={};last=null;};
    for(const m of rows){delete m.usage;if(m.role==='user'){flush();complete=true;samples={...(m.usageSamples||{})};}else{if(m.callUsage)samples[m.id]=m.callUsage;if(m.role==='assistant')last=m;}}flush();return rows;
  }
  const answerIcons = {
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 5V4H6a2 2 0 0 0-2 2v10h1"/>',
    regenerate: '<path d="M20 4v5h-5M20 9a8 8 0 1 0 .2 5"/>',
    copied: '<path d="m5 12 4 4L19 6"/>',
  };
  function answerIcon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${answerIcons[name]}</svg>`;
  }
  function answerAction(action, id, disabled = false) {
    const regenerate = action === 'regenerate';
    const label = regenerate ? '重新生成' : '复制回答';
    return `<button type="button" data-chat-action="${action}" data-id="${esc(id)}" aria-label="${label}" title="${label}" ${disabled ? 'disabled' : ''}>${answerIcon(regenerate ? 'regenerate' : 'copy')}</button>`;
  }
  function transcriptMarkup(rows,render) {
    let out='',turn=[];
    const flush=()=>{if(!turn.length)return;const tools=turn.filter(m=>m.role==='tool'),others=turn.filter(m=>m.role!=='tool'&&m.role!=='usage'&&m.role!=='metadata');
      if(tools.length){const running=tools.some(t=>t.status==='running'),failed=tools.some(t=>['error','interrupted'].includes(t.status));out+='<details class="ai-process" data-process-key="'+esc(tools[0].id)+'"><summary>'+ (running?'正在执行工具':failed?'工具执行有未完成项':'已完成 '+tools.length+' 次工具调用')+'</summary>'+tools.map(render).join('')+'</details>';}
      out+=others.map(render).join('');turn=[];};
    for(const row of rows){if(row.role==='user'){flush();out+=render(row);}else turn.push(row);}flush();return out;
  }
  function historyMessages(raw) {
    let model = null; const result = [];let samples={};
    let answer, evidence = [];
    const flush=()=>{
      if (answer && Object.keys(samples).length) answer.usage = aggregateUsage(samples);
      if (answer && evidence.length) answer.evidence = evidence;
      answer = undefined; evidence = []; samples = {};
    };
    for (const [index, message] of (raw || []).entries()) {
      if (message.role === 'system') continue;
      if (message.role === 'user') {
        flush(); model = message.composer_context?.model || null;
        if (Array.isArray(message.zhijun_evidence)) evidence = message.zhijun_evidence;
      }
      const blocks = Array.isArray(message.content) ? message.content : [];
      let text = textOf(message.content);
      if (message.role === 'user') {
        const legacy = legacyEvidence(text);
        if (legacy) { text = legacy.text; evidence = legacy.evidence; }
      }
      const id = message.id || `history-${index}`;
      if(message.role==='assistant'&&message.usage)samples[id]=message.usage;
      if (text || message.role === 'user') result.push({ id, role: message.role, text, model: message.model_ref || message.usage?.model || model,
        files: message.inbound_attachments || [], callUsage:message.role==='assistant'?message.usage:null,status: message.status || 'completed' });
      else if(message.role==='assistant'&&message.usage)result.push({id,role:'usage',callUsage:message.usage});
      if (message.role === 'assistant' && text) answer = result.at(-1);
      for (const [n, b] of blocks.entries()) {
        if (['tool_use', 'tool_call', 'tool_result'].includes(b.type)) result.push({ id: `${id}-tool-${n}`, role: 'tool', callId: b.id,
          name: b.display_name || b.name || '工具', text: typeof b.output === 'string' ? b.output : b.output == null ? JSON.stringify(b.input || b.args || {}, null, 2) : JSON.stringify(b.output, null, 2),
          status: b.error_code ? 'error' : b.type === 'tool_result' ? 'completed' : 'called' });
      }
    }
    flush();return result;
  }
  function applyFrame(state, event) {
    if(event.type==='usage'){let user=state.messages.findLast(m=>m.role==='user');if(!user){user={id:'usage-root',role:'metadata'};state.messages.unshift(user);}user.usageSamples??={};user.usageSamples[event.call_id||JSON.stringify(event.usage)]=event.usage;const answer=state.messages.findLast(m=>m.role==='assistant');if(answer){for(const m of state.messages.slice(state.messages.indexOf(user)+1))delete m.usage;answer.usage=aggregateUsage(user.usageSamples);if(event.model)answer.model=event.model;}return;}
    if (event.type === 'turn_status') { state.active = Boolean(event.active); return; }
    if (event.type === 'token') {
      state.active = true;
      let last = state.messages.at(-1);
      if (!last || last.role !== 'assistant' || last.status !== 'running') {
        last = { id: `live-${++state.sequence}`, role: 'assistant', text: '', model: state.runModel, status: 'running' };
        state.messages.push(last);
      }
      last.text += String(event.content || '');const user=state.messages.findLast(m=>m.role==='user');if(user?.usageSamples){for(const m of state.messages.slice(state.messages.indexOf(user)+1))delete m.usage;last.usage=aggregateUsage(user.usageSamples);}
    }
    if (event.type === 'tool_call_chunk') {
      state.active = true; const key = event.id || `index-${event.index ?? 0}`;
      let tool = state.messages.findLast(m => m.role === 'tool' && m.status === 'running' && (m.callId === key || m.index === event.index && event.index != null));
      if (!tool) { tool = { id: `live-${++state.sequence}`, role: 'tool', callId: key, index: event.index, name: event.display_name || event.name || '工具', text: '', status: 'running' }; state.messages.push(tool); }
      if (event.id) tool.callId = event.id;
      if (event.name || event.display_name) tool.name = event.display_name || event.name;
      tool.text += typeof event.args === 'string' ? event.args : event.args ? JSON.stringify(event.args) : '';
    }
    if (event.type === 'tool_result') {
      for (const result of event.messages || []) {
        const key = result.tool_call_id || result.toolCallId;
        let tool = state.messages.findLast(m => m.role === 'tool' && m.callId === key);
        if (!tool) { tool = { id: `live-${++state.sequence}`, role: 'tool', callId: key, name: result.name || '工具' }; state.messages.push(tool); }
        tool.status = result.status === 'error' ? 'error' : 'completed';
        tool.text = textOf(result.content) || (typeof result.content === 'object' ? JSON.stringify(result.content, null, 2) : String(result.content || '已完成'));
      }
    }
    if (event.type === 'hitl_required') { state.pending = event.request; state.active = false; }
    if (event.type === 'error') { state.error = event.message || '本次任务未完成，请检查后重试。'; state.active = false; }
    if (event.type === 'done') {
      state.active = false;
      for (const m of state.messages) if (m.status === 'running') m.status = m.role === 'tool' ? 'interrupted' : 'completed';
    }
  }
  function legacyTrail(session, answerId) {
    const items = [], seen = new Set();
    while (answerId && !seen.has(answerId)) {
      seen.add(answerId); const group = session?.groups?.find(g => g.answers.some(a => a.id === answerId));
      if (!group) break;
      items.unshift({ group, answer: group.answers.find(a => a.id === answerId) }); answerId = group.parent_answer;
    }
    return items;
  }
  function legacyReference(session, answerId) {
    return `【来自旧版对话的历史参考：${session.title || '旧版对话'}】\n以下内容仅作为参考，保留原作者和回答来源。\n\n` + legacyTrail(session, answerId).map(({ group, answer }) => `用户：${group.prompt}\n${answer.name || 'AI'}：${answer.text || '（没有回答内容）'}`).join('\n\n') + '\n\n【请在此补充要继续处理的问题】\n';
  }
  const errors = {
    WAREHOUSE_NOT_FOUND:'数据仓已删除或不可访问，请重新选择。',SPACE_NOT_FOUND:'所选空间或文件夹已不存在，请重新选择。',
    SEMANTICA_SERVICE_UNAVAILABLE:'星图服务暂时无法连接，请稍后重试。',SERVICE_UNAVAILABLE:'资料服务暂时无法连接，请稍后重试。',
    ASSISTANT_CONVERSATION_CONFLICT:'这段对话已在其他窗口更新，请重新打开后再操作。草稿已保留。',
    ASSISTANT_CONVERSATION_NOT_FOUND:'这段对话不可用，或不属于当前账号与盒子。',
    ASSISTANT_MESSAGE_NOT_FOUND:'无法找到原消息，请恢复历史后重试。',
    AGENT_QUOTA_EXCEEDED: '当前账号的专家数量已达到上限，请在后台调整配额后重试。',
    FORBIDDEN: '通用专家已停用或当前账号无权访问，请联系管理员。',
    AGENT_NOT_RUNNING: '通用专家暂时未运行，请检查后台状态后恢复连接。',
    AGENT_FAILED: '通用专家启动失败，请检查后台配置后恢复连接。',
    BOX_CONNECTION_REQUIRED: "连接盒子后，即可使用AI 对话。", ASSISTANT_API_NOT_INSTALLED: "当前盒子需要更新AI 对话接口。已有对话数据会保留。",
    DIALOGUE_CONTEXT_CHANGED: '账号或盒子已改变，请重新连接。', DIALOGUE_ACCESS_DENIED: '当前账号暂时无法使用助理，请检查盒子授权。',
    ZHIJUN_MODE_UNCONFIRMED: '盒端尚未确认对话模式。请打开这段对话后重试。',
    ZHIJUN_ADVANCED_REQUIRED: '切到高级模式后可以保存长期记忆。',
    ASSISTANT_MODEL_NEEDS_IMAGE: '当前模型不支持图片，请在顶部选择支持图片的模型，或移除图片后再发送。',
    APPLICATION_MODEL_UNAVAILABLE: '等待管理员配置可用的对话默认模型。',
    MODEL_UNAVAILABLE: '所选模型已不可用，请在顶部重新选择；草稿和附件已保留。', ASSISTANT_TURN_ACTIVE: '这段对话仍在工作，完成或停止后即可继续。',
    ASSISTANT_ATTACHMENT_EXPIRED: '附件连接已过期，请重新添加。', ASSISTANT_UPLOAD_TOO_LARGE: '附件超过当前可上传大小，请缩小文件后重试。',
    ASSISTANT_TOO_MANY_ATTACHMENTS: '一条消息最多添加 8 个附件。', ASSISTANT_SEND_UNCERTAIN: '发送结果尚未确认，请恢复连接读取结果，避免重复发送。',
    ASSISTANT_ARTIFACT_DENIED: '这份产物当前无法读取，请恢复连接后重试。', ASSISTANT_FILE_TOO_LARGE: '文件过大，暂时无法预览。',
    CONNECTOR_NOT_BOUND: '空间连接已停用或变更，草稿已保留。请恢复连接后重试。',
    ASSISTANT_KNOWLEDGE_DENIED: '当前账号或本次选择无权读取此数据仓，请联系管理员授权。',
    ASSISTANT_KNOWLEDGE_EXPIRED: '知识库接入已取消或过期，请在对话设置中重新确认。',
    ASSISTANT_KNOWLEDGE_UNAVAILABLE: '星图数据仓暂时不可用，草稿和附件已保留。',
    ASSISTANT_KNOWLEDGE_CONFLICT: '授权已被其他管理员修改，请刷新后重试。',
    ASSISTANT_SPACE_SCOPE_REQUIRED: '请在对话设置中选择空间访问范围，草稿已保留。',
    SPACE_ACCESS_DENIED: '空间授权已取消、过期或超出所选范围，请重新选择访问范围。',
    CONNECTOR_MCP_LOAD_FAILED: '资料来源暂时无法连接，草稿已保留。请恢复连接后重试。',
  };
  const errorText = error => errors[error?.code] || '操作未完成，草稿已保留。请恢复连接后重试。';
  const sourceLabels={client:'客户端',weixin:'微信',wecom:'企业微信',feishu:'飞书',dingtalk:'钉钉',qq:'QQ',yuanbao:'元宝',cli:'终端',legacy:'旧版',unknown:'来源未知',other:'其他渠道'};
  const conversationSource=s=>s.kind==='legacy'?'legacy':({'dashboard':'client','wechat':'weixin'}[s.channel_type]||(sourceLabels[s.channel_type]?s.channel_type:s.channel_type?'other':'client'));
  function historyItems(sessions, legacySessions, organization = {}, options = {}) {
    const needle = (options.query || '').trim().toLocaleLowerCase();
    return [...sessions.map(s => ({ ...s, kind: 'thread', id: s.thread_id })), ...legacySessions.map(s => ({ ...s, kind: 'legacy', id: s.session_id }))].map(s => {
      const key = `${s.kind}:${s.id}`, meta = organization[key] || {};
      return { ...s, key, source:conversationSource(s), title: meta.title || s.title || '新对话', pinned: meta.pinned ?? s.pinned ?? false,
        status: meta.status || 'active', time: Number(s.last_active || s.updated_at || s.created_at || 0) };
    }).filter(s => (!options.status || s.status === options.status) && (!options.kind || options.kind === 'all' || s.kind === options.kind) && (s.title+' '+sourceLabels[s.source]).toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (options.sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : options.sort === 'oldest' ? a.time - b.time : b.time - a.time) || a.key.localeCompare(b.key));
  }
  window.wanxAssistantState = { esc, markdown, historyMessages, applyFrame, legacyReference, legacyTrail, historyItems, aggregateUsage, rollupUsage, transcriptMarkup };
  window.wanxDialogueState = { trail: legacyTrail, richText: markdown, isLocalModel: m => Boolean(m.is_local) };

  const dialogueModes = {
    ask: { label: '普通模式', hint: '问答、查资料和回忆', path: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.5-.7L3 21l1.7-6A8.5 8.5 0 1 1 21 11.5Z' },
    craft: { label: '高级模式', hint: '问答和回忆，也可以保存长期记忆', path: 'm4 16-1 5 5-1L21 7l-4-4L4 16m10-10 4 4' },
  };
  const modeIcon = mode => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${dialogueModes[mode].path}"/></svg>`;

  window.createAIDialogueView = ({ memory = false, request, onBoxes, compact = false, drawer = false, onSummary, resolvePageHelp, title = 'AI 对话', english = '', subtitle = '', introduction }) => {
    let channelsPanel, spaceAvailable = false, channelsAvailable = false, attachmentsAvailable = false;
    let root, context = null, generation = 0, epoch = 0, visible = false, connected = false, loaded = false, loading = false;
    let scope = null, models = [], selected = null, sessions = [], legacySessions = [], legacy = null, legacyId = null, legacyAnswer = null;
    let pendingHandoff=null,handoffBusy=false;
    let drawerWatchNeedsSync = false;
    let modelMode = 'auto', defaultModel = null, managedDefaults = false, modelChoice = 0;
    let conversationMode = 'ask', modeSupported = false, modePickerOpen = false, modeSaving = false;
    let recentRequested=compact;
    let conversationId=null, conversationRevision=0, versions=[], contextUsage=null, editingId=null;
    const drafts=new Map();
    let threadId = null, messages = [], draft = '', attachments = [], reference = '', historyOpen = !compact && !drawer, query = '', pickerOpen = false, modelQuery = '';
    let busy = false, uploading = false, opening = false, active = false, uncertain = false, pending = null, runModel = null, sequence = 0;
    let submittingTurn = false, stoppingTurn = false;
    let error = '', notice = '', hasMore = false, historyCount = 0, boxName = '', pendingPaint = '', submitted = null, refreshTimer = null, historyTimer = null, historyRequest = 0;
    let streamRecovery = null, refreshing = null;
    const streamRetryDelays = [300, 1000, 2500];
    let organization = {}, historyAvailable = false, historyStatus = 'active', historyKind = 'all', historySort = 'newest', historyPage = 1, historyBatch = false, historyBusy = false, managedKey = null, timezone = 'UTC';
    let spaceEnabled = false, spaceSelection = null, spaceLabel = '', spaceBusy = false, scopeSpaces = [], scopeMode = 'space', scopeSpaceId = 'personal', scopeFolderId = '', scopeFolders = [], scopeCrumbs = [];
    let knowledgeAvailable = false, knowledgeEnabled = false, knowledgeWarehouses = [], knowledgeCatalog = [], knowledgeBusy = false;
    let knowledgeQuery = '', knowledgeChoices = new Set(), artifactPath = null; const sourceLinks = new Map();
    const historySelection = new Set();
    const channelReadMarkers = new Map();
    let zhijunMemory;
    const sourceOptions = [
      ["space", "空间", "参考当前账号可读取的空间文件"],
      ["starlink", "星图", "参考当前账号可读取的个人星图资料"],
      ["memory", "智能体记忆", "参考已记内容和本机 AI 历史的相关片段"],
    ];
    const defaultSources = () => ({ space: true, starlink: true, memory: true });
    let selectedSources = defaultSources();
    const sourceFields = { space: 'folderId', starlink: 'warehouseId', memory: 'memoryAgent' };
    const scopeHeadings = { space: '选择空间文件夹', starlink: '选择星图仓库', memory: '选择记忆来源' };
    const scopeDefaults = { space: '全部个人空间', starlink: '全部可用仓库', memory: '全部记忆来源' };
    let sourceNames = {};
    let sourcePicker = null;
    let sourceSupport = false;
    const evidenceLabels = { space: '空间', starlink: '星图', memmy: '本机 AI 历史', memory: '已记内容' };
    const $ = s => root?.querySelector(s);
    const modelFor = id => models.find(m => m.id === id) || { name: id?.split('/').at(-1) || '通用专家', id };
    const state = () => ({ messages, active, pending, runModel, sequence, error });
    async function call(method, input = {}) {
      if ((!spaceAvailable && method.startsWith('space-')) || (!knowledgeAvailable && method.startsWith('knowledge-')) ||
          (!channelsAvailable && method.startsWith('channels-') && method !== 'channels-cancel') || (!attachmentsAvailable && method === 'upload')) {
        throw Object.assign(new Error('DIALOGUE_ACCESS_DENIED'), { code: 'DIALOGUE_ACCESS_DENIED' });
      }
      const response = await request(`dialogue.${method}`, { ...(method !== 'load' ? { scope } : {}), ...input });
      if (!response?.ok) throw Object.assign(new Error(response?.code || 'ASSISTANT_REQUEST_FAILED'), { code: response?.code });
      return response.value;
    }
    function stopWatch() {
      clearTimeout(refreshTimer);
      streamRecovery = null;
      refreshing = null;
      if (scope) void call('unwatch').catch(() => {});
    }
    function syncDrawerWatch() {
      if (!drawer || !drawerWatchNeedsSync || busy || opening || uploading || loading || handoffBusy) return;
      drawerWatchNeedsSync = false;
      if (!visible) stopWatch();
      else if (scope && threadId && !legacy) void openThread(threadId, false);
    }
    function release(files = attachments) { if (scope && files.length) void call('release', { handles: files.map(f => f.handle) }).catch(() => {}); }
    function reset() {
      channelsPanel?.reset();
      zhijunMemory?.reset();
      selectedSources = defaultSources();
      sourceNames = {};
      sourcePicker = null;
      if ($('[data-zhijun-picker]')?.open) $('[data-zhijun-picker]').close();
      sourceSupport = false;
      conversationMode = 'ask'; modeSupported = false; modePickerOpen = false; modeSaving = false;
      historyOpen = !compact && !drawer;
      channelReadMarkers.clear();
      drawerWatchNeedsSync = false;
      clearTimeout(historyTimer); historyRequest++; clearTimeout(refreshTimer); epoch++; stopWatch(); scope = null; loaded = false; loading = false; models = []; sessions = []; legacySessions = [];
      modelMode = 'auto'; defaultModel = null; managedDefaults = false; selected = null; legacy = null; legacyId = null; threadId = null; conversationId=null;conversationRevision=0;versions=[];contextUsage=null;editingId=null;drafts.clear(); messages = []; draft = ''; attachments = []; reference = ''; submitted = null;
      busy = false; active = false; uncertain = false; uploading = false; opening = false; pending = null; pendingPaint = ''; error = ''; notice = ''; pickerOpen = false;
      submittingTurn = false; stoppingTurn = false;
      if ($('[data-chat-artifact-dialog]')?.open) $('[data-chat-artifact-dialog]').close();
      if ($('[data-chat-history-dialog]')?.open) $('[data-chat-history-dialog]').close();
      spaceAvailable = false; channelsAvailable = false; attachmentsAvailable = false;
      knowledgeAvailable = false; knowledgeEnabled = false; knowledgeWarehouses = []; knowledgeCatalog = []; knowledgeBusy = false; artifactPath = null; sourceLinks.clear();
      for (const d of root?.querySelectorAll('dialog[open]') || []) d.close();
      if ($('[data-chat-space-dialog]')?.open) $('[data-chat-space-dialog]').close();
      spaceEnabled = false; spaceSelection = null; spaceLabel = ''; spaceBusy = false; scopeSpaces = []; organization = {}; historyAvailable = false; historyStatus = 'active'; historyKind = 'all'; historySort = 'newest'; historyPage = 1; historyBatch = false; historyBusy = false; managedKey = null; historySelection.clear();
      $('[data-artifact-content]')?.replaceChildren();
      if ($('[data-chat-artifacts]')) $('[data-chat-artifacts]').innerHTML = '';
      if (memory && introduction?.placeholder && $('[data-chat-input]')) $('[data-chat-input]').placeholder = introduction.placeholder;
      if ($('[data-chat-input]')) $('[data-chat-input]').value = '';
      if ($('[data-chat-search]')) $('[data-chat-search]').value = '';
      query = ''; recentRequested=compact; paint();
    }
    function acceptSessions(rows) {
      sessions = rows.map(row => row.unread && Number(row.last_active || row.updated_at || row.created_at) <=
        (channelReadMarkers.get(row.thread_id) ?? 0) ? { ...row, unread: false } : row);
    }
    function scheduleHistoryRefresh(){
      clearTimeout(historyTimer);historyTimer=null;
      if(root&&!compact&&visible&&connected&&loaded)historyTimer=setTimeout(()=>void refreshHistoryList(),10000);
    }
    async function refreshHistoryList(){
      if(!root||compact||!visible||!connected||!loaded)return;
      clearTimeout(historyTimer);
      const gen=generation,token=++historyRequest,expected=scope,previous=organization;
      try{
        const result=await call('history-list');
        if(gen!==generation||token!==historyRequest||scope!==expected||!visible)return;
        acceptSessions(result.sessions);
        if(organization===previous)organization=result.organization||{};
        paintHistory();
        if (memory && !messages.length && !active && !legacy) paintMessages();
        if (modelMode === 'auto' && !active && !busy) await refreshModelSelection();
      }catch{/* A background list refresh never replaces the draft or interrupts a turn. */}
      finally{if(gen===generation&&token===historyRequest)scheduleHistoryRefresh();}
    }
    async function load() {
      if (!connected || loading) return;
      const gen = generation, turn = epoch, choice = modelChoice; loading = true; error = ''; paintStatus();
      try {
        const result = await call('load');
        if (gen !== generation) return;
        scope = result.scope; sourceSupport = result.sidebarSources === true; models = result.models; acceptSessions(result.sessions); legacySessions = result.legacySessions; loaded = true;
        modeSupported = result.sidebarConversationModes === true;
        knowledgeAvailable = result.capabilities?.knowledge !== false;
        spaceAvailable = result.capabilities?.space !== false;
        channelsAvailable = result.capabilities?.channels !== false;
        attachmentsAvailable = result.capabilities?.attachments !== false;
        if (!spaceAvailable) { spaceEnabled = false; spaceSelection = null; spaceLabel = ''; if ($('[data-chat-space-dialog]')?.open) $('[data-chat-space-dialog]').close(); }
        if (!knowledgeAvailable) { knowledgeEnabled = false; knowledgeWarehouses = []; knowledgeChoices.clear(); if ($('[data-chat-knowledge-dialog]')?.open) $('[data-chat-knowledge-dialog]').close(); }
        if (!attachmentsAvailable) { attachments = []; for (const cached of drafts.values()) cached.attachments = []; if (submitted) submitted.attachments = []; }
        if (!channelsAvailable) channelsPanel?.reset();
        const settings = result.settings || {};
        if(!threadId)acceptSources(settings,result.validation_errors);
        organization = result.organization || {}; historyAvailable = result.historyManagementAvailable === true; timezone = result.timezone || 'UTC';
        if (!threadId && choice === modelChoice) acceptModelSelection(result);
        else if (selected && !models.some(m => m.id === selected)) error = errors.MODEL_UNAVAILABLE;
        if (result.legacyUnavailable) notice = '旧版记录暂时无法读取，可稍后恢复连接重试。';
        if(compact&&recentRequested&&turn===epoch&&!draft.trim()&&!attachments.length&&!active&&!pending){
          recentRequested=false;
          if(result.recentConversationId)await openThread(result.recentConversationId);
          else if(threadId)await newChat();
        }else if (threadId && turn === epoch) await openThread(threadId, false);

      } catch (e) { if (gen === generation) error = errorText(e); }
      finally { if (gen === generation) { loading = false; paint(); scheduleHistoryRefresh(); } }
    }
    function acceptModelSelection(value) {
      if (value.models) models = value.models;
      if (Object.hasOwn(value, 'defaultModel')) selected = value.defaultModel;
      modelMode = value.modelMode || (value.settings?.model ? 'manual' : 'auto');
      if (modelMode === 'auto' && Object.hasOwn(value, 'defaultModel')) defaultModel = selected;
      managedDefaults = value.managedDefaults === true;
    }
    async function refreshModelSelection() {
      const gen = generation, turn = epoch, choice = modelChoice;
      const result = await call('model', { refresh:true, modelMode, model:selected });
      if (gen !== generation || turn !== epoch || choice !== modelChoice) return;
      acceptModelSelection(result); paintModels(); paintStatus();
    }
    function acceptHistory(history, older = false) {
      for (const ref of history.knowledge_sources || []) sourceLinks.set(ref.warehouse_id + ':' + ref.evidence_id, ref);
      const incoming = historyMessages(history.messages);
      if (older) {
        const ids = new Set(messages.map(m => m.id)); messages = [...incoming.filter(m => !ids.has(m.id)), ...messages];
      } else {
        const serverHasReply = incoming.some(m => m.role === 'assistant');
        if (incoming.length && (!submitted || serverHasReply || !messages.some(m => m.role === 'assistant' && m.id.startsWith('live-')))) messages = incoming;
      }
      active = Boolean(history.turn_active); pending = history.hitl_pending || null; uncertain = false;
      hasMore = Boolean(history.has_more); historyCount = Number(history.offset || 0) + Number(history.limit || (history.messages || []).length);
      rollupUsage(messages,!history.has_more);
      const refs = history.artifact_refs?.length ? history.artifact_refs : history.artifacts || [];
      if ($('[data-chat-artifacts]')) $('[data-chat-artifacts]').innerHTML = refs.length ? `<span>本次产物</span>${refs.map(ref => {
        const path = typeof ref === 'string' ? ref : ref.path; return `<button type="button" data-chat-action="artifact" data-path="${esc(path)}">▤ ${esc(path.split('/').at(-1))}</button>`;
      }).join('')}` : '';
    }
    async function importHandoff() {
      if(!pendingHandoff||handoffBusy||!loaded||!root||busy||uploading||opening||drawer&&(!visible||loading))return;
      const value=pendingHandoff;pendingHandoff=null;handoffBusy=true;
      const identity = generation;
      try{
        if(value.scope!==scope)return;
        if (drawer && !conversationId && (draft.trim() || attachments.length || reference.trim())) {
          notice = '抽屉里的新对话草稿已保留，迷你对话的内容仍可在迷你对话里继续。';
          paintStatus();
          return;
        }
        if(value.conversationId)await openThread(value.conversationId);else await newChat();
        if (identity !== generation || value.scope !== scope || (drawer && (value.conversationId ?? null) !== conversationId)) return;
        const handoffEpoch = epoch;
        const stillCurrent = () => identity === generation && handoffEpoch === epoch && value.scope === scope;
        if(!draft.trim()&&!attachments.length&&(!drawer||!reference.trim())){draft=value.draft||'';attachments=attachmentsAvailable ? value.attachments||[] : [];reference=value.reference||'';$('[data-chat-input]').value=draft;}
        else if (drawer) {
          notice = '抽屉里的草稿已保留，迷你对话的内容仍可在迷你对话里继续。';
          paintStatus();
          return;
        } else if(value.draft&&value.draft!==draft)notice='主窗口草稿已保留，迷你助理的草稿仍在托盘中。';
        if(value.modelMode==='auto'){modelMode='auto';await refreshModelSelection();}
        else if(value.model){selected=value.model;modelMode='manual';}
        if(!value.conversationId && stillCurrent()){
          if(spaceAvailable&&value.context?.space?.enabled){const result=await call('space-grant',{enabled:true,selection:value.context.space.selection});if(!stillCurrent())return;spaceEnabled=true;spaceSelection=result.selection;spaceLabel=result.label;}
          if(knowledgeAvailable&&value.context?.knowledge?.enabled){const result=await call('knowledge-grant',{enabled:true,warehouses:value.context.knowledge.warehouses.map(w=>w.id)});if(!stillCurrent())return;knowledgeEnabled=true;knowledgeWarehouses=result.warehouses;}
        }
        if (stillCurrent()) paint();
      }catch(e){if(identity===generation){error=errorText(e);paintStatus();}}finally{handoffBusy=false;syncDrawerWatch();}
    }
    function acceptConversation(value) {
      if(!value)return;
      conversationId=value.id;conversationRevision=value.revision;versions=value.versions||[];
      acceptSources(value.context||{},value.validation_errors);
    }
    const canWriteMemory = () => modeSupported && conversationMode === 'craft';
    const memoryWriteHint = () => conversationMode !== 'craft'
      ? '切到高级模式后可以保存长期记忆。'
      : '当前盒端尚未支持高级模式的长期记忆写入。';
    function acceptConversationMode(value) {
      if (memory && Object.hasOwn(dialogueModes, value.conversationMode)) conversationMode = value.conversationMode;
    }
    async function chooseConversationMode(mode) {
      if (!Object.hasOwn(dialogueModes, mode) || $('[data-chat-action="modes"]').disabled) return;
      modePickerOpen = false;
      notice = '';
      if (!conversationId) {
        conversationMode = mode;
        paintStatus();
        $('[data-chat-action="modes"]').focus();
        return;
      }
      const gen = generation, turn = epoch;
      modeSaving = true; error = ''; paintStatus();
      try {
        const result = await call('sidebar-mode', { conversationId, mode });
        if (gen !== generation || turn !== epoch) return;
        acceptConversation(result.conversation);
        acceptConversationMode(result);
      } catch (e) {
        if (gen === generation && turn === epoch) error = errorText(e);
      } finally {
        if (gen === generation && turn === epoch) {
          modeSaving = false;
          paintStatus();
          $('[data-chat-action="modes"]').focus();
        }
      }
    }
    function acceptSources(ctx,validationErrors) {
      spaceEnabled=spaceAvailable&&ctx.space?.enabled===true;spaceSelection=spaceEnabled ? ctx.space?.selection||null : null;spaceLabel=spaceEnabled ? ctx.space?.label||'' : '';
      knowledgeEnabled=knowledgeAvailable&&ctx.knowledge?.enabled===true;knowledgeWarehouses=knowledgeEnabled ? ctx.knowledge?.warehouses||[] : [];
      if(validationErrors?.length) error=validationErrors.map(v=>(v.name||'资料')+'：'+errorText({code:v.code})).join('；');
    }
    function stashDraft() {if(conversationId)drafts.set(conversationId,{draft,attachments:attachments.slice(),reference});}
    async function refreshUsage() {
      if(compact||memory)return;
      if(!threadId||legacy){contextUsage=null;paintUsage();return;}
      const gen=generation,turn=epoch,id=threadId;
      try{const value=await call('usage',{threadId:id,model:selected});if(gen===generation&&turn===epoch&&id===threadId){contextUsage=value;paintUsage();}}catch{if(gen===generation&&turn===epoch){contextUsage=null;paintUsage();}}
    }
    function paintUsage() {
      const summary=$('[data-context-summary]');if(!summary)return;
      const used=contextUsage?.used_tokens,max=contextUsage?.max_tokens,known=Number.isFinite(used)&&used>0&&Number.isFinite(max)&&max>0;
      const number=n=>new Intl.NumberFormat('zh-CN').format(n);
      summary.textContent=known?'上下文 '+number(used)+' / '+number(max)+' · '+Math.min(100,Math.max(1,Math.round(used/max*100)))+'%':'上下文 · 暂无统计';
      const names={system_prompt:'系统提示',tool_definitions:'工具定义',rules:'规则',skills:'技能',mcp:'资料接入',subagent_definitions:'辅助工具',conversation:'对话内容'};
      $('[data-context-breakdown]').innerHTML=known?'<strong>上下文占用</strong><p>最近一次模型输入占用，不等于本轮累计消耗。</p>'+((contextUsage.segments||[]).map(v=>'<div><span>'+esc(names[v.key]||v.key)+'</span><span>约 '+number(v.tokens)+'</span></div>').join('')||'<p>当前没有组成明细。</p>')+'<small>组成明细为后台估算值。</small>':'<p>后台尚未返回可用的 Token 统计。</p>';
    }
    function paintVersions() {
      const node=$('[data-chat-versions]');if(!node)return;
      node.hidden=versions.length<2||Boolean(legacy);
      const index=versions.findIndex(v=>v.thread_id===threadId);
      node.innerHTML='<button type="button" data-chat-action="version-prev" aria-label="上一版" '+(index<=0||active||busy||pending?'disabled':'')+'>‹</button><span>第 '+(index+1)+' / '+versions.length+' 版</span><button type="button" data-chat-action="version-next" aria-label="下一版" '+(index>=versions.length-1||active||busy||pending?'disabled':'')+'>›</button>';
    }
    async function changeVersion(direction) {
      const index=versions.findIndex(v=>v.thread_id===threadId),target=versions[index+direction];if(!target||active||busy||pending)return;
      const gen=generation,turn=epoch,choice=modelChoice;busy=true;paintStatus();
      try{const result=await call('version-select',{conversationId,revision:conversationRevision,threadId:target.thread_id});if(gen!==generation||turn!==epoch)return;stopWatch();threadId=result.history.thread_id;acceptConversation(result.conversation);acceptConversationMode(result);acceptHistory(result.history);if(choice===modelChoice){if(result.modelSelection)acceptModelSelection(result.modelSelection);else if(result.history.model_ref){selected=result.history.model_ref;modelMode='manual';}}await call('watch',{threadId});contextUsage=null;paint();void refreshUsage();}
      catch(e){if(gen===generation&&turn===epoch)error=errorText(e);}finally{if(gen===generation&&turn===epoch){busy=false;paint();}}
    }
    async function revise(kind,id,text) {
      if(active||busy||pending||!conversationId)return;
      const gen=generation,turn=epoch;busy=true;error='';paintStatus();
      try{const result=await call('version',{conversationId,revision:conversationRevision,threadId,messageId:id,kind,text,model:selected,modelMode,...(memory && {sources:selectedSources})});if(gen!==generation||turn!==epoch)return;threadId=result.history.thread_id;acceptConversation(result.conversation);acceptConversationMode(result);messages=[];acceptHistory(result.history);runModel=result.model||selected;if(modelMode==='auto')selected=runModel;active=true;contextUsage=null;$('[data-chat-edit-dialog]').close();editingId=null;await call('watch',{threadId});scheduleRefresh(500);}
      catch(e){if(gen===generation&&turn===epoch){error=errorText(e);try{const restored=await call('open',{threadId:conversationId});if(gen===generation&&turn===epoch){acceptConversation(restored.conversation);acceptConversationMode(restored);threadId=restored.history.thread_id;acceptHistory(restored.history);await call('watch',{threadId});}}catch{}if($('[data-chat-edit-dialog]').open)$('[data-edit-error]').textContent=error;}}
      finally{if(gen===generation&&turn===epoch){busy=false;paint();}}
    }
    async function openThread(id, choose = true) {
      if (!scope || busy || uploading || modeSaving) return;
      if (conversationId !== id) {stashDraft();}
      if (threadId !== id && (spaceEnabled || knowledgeEnabled)) await call('release-context');
      const turn = ++epoch, gen = generation, choice = modelChoice; opening = true; stoppingTurn = false; modePickerOpen = false; error = ''; stopWatch(); paintStatus();
      try {
        const result = await call('open', { threadId: id, trackOpened:choose });
        if (turn !== epoch || gen !== generation) return;
        const changedConversation=conversationId!==result.conversation.id;
        const changedThread = threadId !== result.history.thread_id; threadId = result.history.thread_id;acceptConversation(result.conversation);acceptConversationMode(result);contextUsage=null;
        if(changedConversation){const cached=drafts.get(conversationId);draft=cached?.draft||'';attachments=attachmentsAvailable ? cached?.attachments||[] : [];reference=cached?.reference||'';$('[data-chat-input]').value=draft;} legacy = null; legacyId = null; submitted = null;
        if (changedThread) { messages = []; sourceLinks.clear(); }
        acceptHistory(result.history);
        if (result.channelReadThrough) {
          channelReadMarkers.set(conversationId, result.channelReadThrough);
          acceptSessions(sessions);
        }
        if (choose && choice === modelChoice && result.modelSelection) acceptModelSelection(result.modelSelection);
        else if (choose && choice === modelChoice && result.history.model_ref) { selected = result.history.model_ref; modelMode = 'manual'; }
        if (selected && !models.some(m => m.id === selected)) error = errors.MODEL_UNAVAILABLE;
        runModel = result.history.messages?.findLast(m=>m.role==='user')?.composer_context?.model || result.history.model_ref || selected;
        if (!drawer || visible) await call('watch', { threadId });
        void refreshUsage();
      } catch (e) { if (turn === epoch && gen === generation) error = errorText(e); }
      finally { if (turn === epoch && gen === generation) { opening = false; paint(); } }
    }
    async function newChat() {
      if (busy || uploading || modeSaving) return;
      recentRequested=false;
      const gen=generation,turn=epoch;
      const defaults=await call('release-context');
      if(gen!==generation||turn!==epoch)return;
      stashDraft();epoch++; stopWatch(); threadId = null;conversationId=null;conversationRevision=0;versions=[];contextUsage=null;spaceEnabled=false;spaceSelection=null;spaceLabel='';knowledgeEnabled=false;knowledgeWarehouses=[]; legacy = null; legacyId = null; legacyAnswer = null;
      conversationMode = 'ask'; modePickerOpen = false;
      messages = []; sourceLinks.clear(); active = false; uncertain = false; pending = null; pendingPaint = ''; draft = ''; attachments = []; reference = ''; submitted = null; hasMore = false;
      submittingTurn = false; stoppingTurn = false;
      error = ''; notice = ''; acceptModelSelection(defaults); acceptSources(defaults.context||{},defaults.validation_errors); if ($('[data-chat-input]')) { $('[data-chat-input]').value = ''; $('[data-chat-input]').style.height = ''; }
      if ($('[data-chat-artifacts]')) $('[data-chat-artifacts]').innerHTML = '';
      if (memory && introduction?.placeholder) $('[data-chat-input]').placeholder = introduction.placeholder;
      paint(); $('[data-chat-input]')?.focus();
    }
    function scheduleRefresh(delay) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refreshCurrent(), delay);
    }
    function scheduleStreamRecovery() {
      const delay = streamRetryDelays[streamRecovery.attempts];
      streamRecovery.failed = delay === undefined;
      if (!streamRecovery.failed) scheduleRefresh(delay);
      paintStatus();
    }
    async function refreshCurrent() {
      if (!visible || !connected || !scope || !threadId || legacy || streamRecovery?.failed) return;
      if (busy || opening || refreshing) {
        scheduleRefresh(300);
        return;
      }
      const turn = epoch, gen = generation, id = threadId;
      const recovery = streamRecovery, refresh = {};
      const isCurrent = () => refreshing === refresh && gen === generation && turn === epoch && id === threadId && visible && streamRecovery === recovery;
      refreshing = refresh;
      try {
        if (recovery) {
          recovery.attempts++;
          await call('watch', { threadId: id });
          if (!isCurrent()) return;
        }
        const result = await call('open', { threadId: id });
        if (!isCurrent()) return;
        if (result.history.thread_id !== id) {
          streamRecovery = null;
          error = errors.ASSISTANT_CONVERSATION_CONFLICT;
          paintStatus();
          return;
        }
        streamRecovery = null;
        acceptConversation(result.conversation);
        acceptHistory(result.history);
        if (recovery && submitted && !active && !result.history.history_loading) submitted.ended = true;
        paint(); void refreshUsage();
        if (result.history.history_loading) scheduleRefresh(Math.max(500, result.history.history_retry_after_ms || 1000));
      } catch (e) {
        if (!isCurrent()) return;
        if (recovery) scheduleStreamRecovery();
        else { error = errorText(e); paintStatus(); }
      } finally {
        if (refreshing === refresh) refreshing = null;
      }
    }
    async function send() {
      if (busy || uploading || opening || modeSaving || active || uncertain || streamRecovery || spaceBusy || knowledgeBusy || pending || legacy || !scope) return;
      const text = draft.trim(); if (!text && !attachments.length && !reference.trim()) return;
      if (!attachments.length && !reference.trim() && zhijunMemory?.requiresWrite(text) && !canWriteMemory()) {
        notice = memoryWriteHint(); paintStatus(); return;
      }
      if (!attachments.length && !reference.trim() && zhijunMemory?.command(text)) {
        draft = '';
        $('[data-chat-input]').value = '';
        paintStatus();
        return;
      }
      if (!models.some(m => m.id === selected)) return;
      const gen = generation, turn = epoch, sentFiles = attachmentsAvailable ? attachments.slice() : [], sentDraft = draft, sentReference = reference;
      let messageText = text;
      const helpRequest = text && resolvePageHelp?.();
      if (helpRequest) {
        busy = true;
        error = ''; notice = '';
        paintStatus();
        try {
          const help = await helpRequest;
          if (gen !== generation || turn !== epoch) return;
          if (help) messageText += `\n\n【当前页面帮助】\n${help}`;
        } catch {
          if (gen === generation && turn === epoch) error = '暂时无法读取当前页面提示，请重试。';
          return;
        } finally {
          if (gen === generation && turn === epoch) { busy = false; paintStatus(); }
        }
      }
      const prompt = sentReference.trim() ? `${sentReference.trim()}\n\n【现在的请求】\n${messageText}` : messageText;
      if (prompt.length > 32000) { error = '历史参考与消息合计最多 32000 字符，请删减参考内容后发送。'; paintStatus(); return; }

      submitted = { draft: sentDraft, reference: sentReference, attachments: sentFiles, prompt, model: selected, ended: false, failed: false };
      busy = true; submittingTurn = true; error = ''; notice = ''; active = true; runModel = selected;
      messages.push({ id: `optimistic-${++sequence}`, role: 'user', text: messageText, reference: sentReference, files: sentFiles }); paint();
      try {
        const result = await call('send', { threadId, revision:conversationRevision,model: selected, modelMode, prompt, attachments: sentFiles.map(f => f.handle), spaceEnabled, knowledgeEnabled, ...(memory && { sources: selectedSources, conversationMode }) });
        if (gen !== generation || turn !== epoch) return;
        threadId = result.threadId;acceptConversation(result.conversation);acceptConversationMode(result);
        if (result.model) { runModel = result.model; submitted.model = result.model; if (modelMode === 'auto') selected = result.model; }
        if (!submitted.failed && draft === sentDraft) { draft = ''; $('[data-chat-input]').value = ''; $('[data-chat-input]').style.height = ''; }
        if (!submitted.failed && reference === sentReference) reference = '';
        if (!submitted.failed) attachments = attachments.filter(f => !sentFiles.some(item => item.handle === f.handle));
        active = !submitted.ended && !pending;
        if (!sessions.some(s => s.thread_id === (conversationId || threadId))) sessions.unshift({ thread_id: conversationId || threadId, title: text.slice(0, 35) || '附件对话', last_active: Date.now() / 1000 });
        paintHistory();
      } catch (e) {
        if (gen !== generation || turn !== epoch) return;
        active = false; error = errorText(e); uncertain = Boolean(threadId) && !['APPLICATION_MODEL_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'ASSISTANT_ATTACHMENT_EXPIRED', 'ASSISTANT_TURN_ACTIVE', 'ASSISTANT_MODEL_NEEDS_IMAGE', 'ASSISTANT_KNOWLEDGE_DENIED', 'ASSISTANT_KNOWLEDGE_EXPIRED', 'ASSISTANT_KNOWLEDGE_UNAVAILABLE', 'SPACE_ACCESS_DENIED'].includes(e.code);
        if (!uncertain) messages = messages.filter(m => !m.id.startsWith('optimistic-'));
      } finally { if (gen === generation && turn === epoch) { busy = false; submittingTurn = false; paint(); } }
    }
    function paintModels() {
      const node = $('[data-chat-models]'); if (!node) return;
      const chosen=modelFor(selected);
      const description = modelMode === 'auto'
        ? '跟随默认 · ' + (selected ? chosen.name : managedDefaults ? '等待管理员配置' : '暂无可用模型')
        : selected ? chosen.name : '选择模型';
      const modelGlyph = icon(chosen);
      const triggerContent = memory
        ? (modelGlyph.startsWith('<img') ? modelGlyph : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/><rect x="10" y="10" width="4" height="4" rx="1"/></svg>')
        : modelGlyph;
      const labelAttributes = memory ? ` title="${esc(description)}" aria-label="选择模型 · ${esc(description)}" aria-controls="zhijun-model-options"` : '';
      const restoreFocus = node.contains(document.activeElement);
      node.innerHTML = `<button type="button" class="ai-footer-model" data-chat-action="models" aria-haspopup="dialog" aria-expanded="${pickerOpen}"${labelAttributes}><span class="ai-model-icon">${triggerContent}</span>${memory ? '' : `<span>${esc(description)}</span><span aria-hidden="true">⌄</span>`}</button>`;
      if (restoreFocus) node.firstElementChild.focus();
      $('[data-chat-model-picker]').hidden=!pickerOpen;
      const needle = modelQuery.trim().toLowerCase();
      const matches = models.filter(m => (m.name + ' ' + m.provider).toLowerCase().includes(needle));
      if (memory) {
        const mark = '<span class="ai-choice-check" aria-hidden="true">✓</span>';
        $('[data-chat-model-default]').innerHTML = `<button type="button" data-chat-action="model-auto" class="ai-model-option" aria-pressed="${modelMode === 'auto'}">
          <span class="ai-model-icon" aria-hidden="true">↻</span><span><strong>跟随默认</strong><small>${esc(defaultModel ? modelFor(defaultModel).name : selected && modelMode === 'auto' ? chosen.name : '使用当前默认模型')}</small></span>${mark}
        </button>`;
        $('[data-chat-model-options]').innerHTML = matches.map(m => `<button type="button" data-chat-action="model" data-id="${esc(m.id)}" class="ai-model-option" aria-pressed="${modelMode === 'manual' && m.id === selected}">
          <span class="ai-model-icon">${icon(m)}</span><span><strong>${esc(m.name)}</strong><small>${esc(m.provider)}</small></span>${mark}
        </button>`).join('') || '<p class="ai-empty-label">没有找到可用模型</p>';
      } else $('[data-chat-model-options]').innerHTML='<button type="button" data-chat-action="model-auto" class="ai-model-option" aria-pressed="'+(modelMode==='auto')+'"><span>跟随默认模型</span>'+(modelMode==='auto'?'✓':'')+'</button>'+ (matches.map(m=>'<button type="button" data-chat-action="model" data-id="'+esc(m.id)+'" class="ai-model-option" aria-pressed="'+(modelMode==='manual'&&m.id===selected)+'"><span class="ai-model-icon">'+icon(m)+'</span><span><strong>'+esc(m.name)+'</strong><small>'+esc(m.provider)+'</small></span>'+(modelMode==='manual'&&m.id===selected?'✓':'')+'</button>').join('')||'<p class="ai-empty-label">没有找到可用模型</p>');
      $('[data-chat-next-model]').textContent=active&&selected!==runModel?'下一轮使用 '+chosen.name+'，当前回答继续完成。':modelMode==='auto'&&managedDefaults&&!selected?errors.APPLICATION_MODEL_UNAVAILABLE:'';
    }
    function paintConversationMode() {
      const trigger = $('[data-chat-action="modes"]');
      if (!trigger) return;
      trigger.disabled = !scope || !loaded || !connected || opening || busy || active || uncertain || Boolean(pending || legacy) || modeSaving;
      if (trigger.disabled) modePickerOpen = false;
      const selected = dialogueModes[conversationMode].label;
      const pendingBoxUpdate = loaded && !modeSupported;
      if (trigger.dataset.mode !== conversationMode) trigger.innerHTML = modeIcon(conversationMode);
      trigger.title = '对话模式 · ' + selected + (pendingBoxUpdate ? '（待盒端支持）' : '');
      trigger.dataset.mode = conversationMode;
      trigger.setAttribute('aria-label', trigger.title);
      trigger.setAttribute('aria-expanded', String(modePickerOpen));
      $('[data-mode-panel]').hidden = !modePickerOpen;
      $('[data-mode-compatibility]').hidden = !pendingBoxUpdate;
      const input = $('[data-chat-input]');
      input.placeholder = conversationMode === 'craft' ? (introduction?.placeholder || '你想记住或想起什么？') : '你想问什么，或想起什么？';
      for (const button of root.querySelectorAll('[data-chat-action="select-mode"]')) {
        button.setAttribute('aria-pressed', String(button.dataset.id === conversationMode));
      }
    }
    function messageMarkup(message) {
      if (message.role === 'tool') return `<details class="ai-tool"><summary><span class="ai-tool-dot ${message.status}"></span>${esc(/wanx_knowledge_.*_xingtu_|Xingtu |星图知识库/i.test(message.name || '') ? '读取星图知识库' : /wanx_space_.*_space_|万象空间/i.test(message.name || '') ? '读取空间文件' : message.name || '工具')}<span>${message.status === 'running' ? '正在执行' : message.status === 'error' ? '未完成' : message.status === 'interrupted' ? '已中断' : message.status === 'called' ? '已调用' : '已完成'}</span></summary><pre>${esc(message.text || '正在处理…')}</pre></details>` + sourceButtons(message.text || '');
      const files = (message.files || []).map(f => `<span class="ai-sent-file">▤ ${esc(f.name || f.filename || '附件')}</span>`).join('');
      if (message.role === 'user') return `<article class="ai-user-message"><div>${message.reference ? '<small>含旧版对话参考</small>' : ''}<p>${esc(message.text)}</p>${files}${!message.id.startsWith('optimistic-')?`<button class="ai-message-edit" data-chat-action="edit" data-id="${esc(message.id)}" ${active||busy||pending?'disabled':''}>编辑重发</button>`:''}${zhijunMemory && threadId && message.text && !message.id.startsWith('optimistic-') ? `<button type="button" class="ai-message-edit" data-chat-action="remember-message" data-id="${esc(message.id)}">记住</button>` : ''}</div></article>`;
      const model = modelFor(message.model);
      const evidence = memory && message.evidence?.length ? `<section class="ai-zhijun-evidence" aria-label="本次参考出处">${message.evidence.map((item, index) =>
        `<details data-evidence-key="${esc(message.id)}:${index}"><summary>${esc(evidenceLabels[item.source] || '资料')} · ${esc(item.title)}</summary>
        <p>${esc(item.text)}</p>${item.threadId ? `<button type="button" data-chat-action="evidence-thread" data-id="${esc(item.threadId)}" data-message-id="${esc(item.messageId)}">查看原对话</button>` : ''}
        ${item.file_id || item.evidence_id ? `<button type="button" data-chat-action="evidence-source" data-id="${esc(message.id)}" data-evidence-index="${index}">打开资料</button>` : ''}</details>`
      ).join('')}</section>` : '';
      return `<article class="ai-answer"><header><span class="ai-answer-icon">${icon(model)}</span><strong>${esc(zhijunMemory ? '知君' : message.model ? model.name : '通用专家')}</strong>${message.status === 'running' ? '<span class="ai-answer-status">正在回答</span>' : ''}</header><div class="ai-answer-text">${markdown(message.text)}</div>${evidence}${message.text ? `<footer>${answerAction('copy', message.id)}${message.status !== 'running' ? answerAction('regenerate', message.id, active || busy || pending) : ''}</footer>` : ''}</article>`;
    }
    function paintScroll(){const area=$('[data-chat-messages]'),button=$('[data-scroll-bottom]');if(area&&button)button.hidden=area.scrollHeight-area.scrollTop-area.clientHeight<100;}
    function paintMessages() {
      const area = $('[data-chat-messages]'); if (!area) return;
      const expanded=new Set([...area.querySelectorAll('details[open][data-process-key]')].map(n=>n.dataset.processKey));
      const expandedEvidence = new Set([...area.querySelectorAll('details[open][data-evidence-key]')].map(node => node.dataset.evidenceKey));
      const follow = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
      if (legacy) {
        const leaves = legacy.groups?.flatMap(g => g.answers) || [];
        area.innerHTML = `<div class="ai-transcript"><div class="ai-legacy-banner"><div><strong>旧版对话 · 只读</strong><p>保留原始内容，选择要参考的回答后带入助理。</p></div><button data-chat-action="bring-legacy">带入助理继续 ↗</button></div>${legacy.groups.map(g => `<article class="ai-user-message"><div><p>${esc(g.prompt)}</p></div></article>${g.answers.map(a => `<article class="ai-answer"><header><strong>${esc(a.name || a.model)}</strong><label><input type="radio" name="legacy-answer" data-legacy-answer="${esc(a.id)}" ${a.id === legacyAnswer ? 'checked' : ''}/> 以此为参考终点</label></header><div class="ai-answer-text">${markdown(a.text || '')}</div><footer>${answerAction('copy-legacy', a.id)}</footer></article>`).join('')}`).join('')}</div>`;
        if (!leaves.length) area.innerHTML += '<p class="ai-empty-label">这段旧版对话没有回答内容。</p>';
        return;
      }
      if (!messages.length && !active) {
        const recent = memory && historyItems(sessions, [], organization, { status: 'active' }).find(item => item.time > 0);
        const shortcuts = memory && scope ? `<div class="ai-zhijun-start">
          ${recent ? `<button type="button" data-chat-action="continue-recent" data-id="${esc(recent.id)}" class="ai-zhijun-recent">
          <small>接着聊 · ${esc(sourceLabels[recent.source])}</small><strong>${esc(recent.title)}</strong><span aria-hidden="true">↗</span></button>` : ''}
          <div><button type="button" data-chat-action="quick-remember">记一件事</button></div></div>` : '';
        area.innerHTML = `<div class="ai-welcome${memory ? ' ai-zhijun-welcome' : ''}">${introduction
          ? `<h3>${esc(introduction.heading)}</h3><p>${esc(introduction.text)}</p>`
          : compact
          ? '<p class="ai-welcome-eyebrow">从一个想法，到下一步行动</p><h3>今天，想完成什么？</h3><p>把问题、材料或想法交给我，一起推进手头的工作。</p>'
          : "<h3>想找什么记忆或文件？</h3><p>直接提问，AI 会在你勾选的来源中查找星图资料和空间文件。</p>"
        }${shortcuts}${!connected ? "<button class=\"ai-connect\" data-chat-action=\"boxes\">连接盒子</button>" : ''}</div>`;
      } else {
        area.innerHTML = `<div class="ai-transcript">${hasMore ? '<button class="ai-load-older" data-chat-action="older">查看更早的消息</button>' : ''}${transcriptMarkup(messages,messageMarkup)}${active && messages.at(-1)?.role !== 'assistant' ? `<div class="ai-working"><span></span>正在处理…</div>` : ''}</div>`;
      }
      if (!legacy && sourceLinks.size && !area.querySelector('.ai-knowledge-sources')) area.querySelector('.ai-transcript')?.insertAdjacentHTML('beforeend', sourceButtons(JSON.stringify({ assistant_knowledge_sources: [...sourceLinks.values()] })));
      for (const node of area.querySelectorAll('details[data-evidence-key]')) node.open = expandedEvidence.has(node.dataset.evidenceKey);
      for(const node of area.querySelectorAll('[data-process-key]'))if(expanded.has(node.dataset.processKey))node.open=true;
      if (follow && (!memory || messages.length || active)) area.scrollTop = area.scrollHeight;
      paintScroll();
    }
    const allHistory = () => historyItems(sessions, legacySessions, organization);
    const filteredHistory = () => historyItems(sessions, legacySessions, organization, { query, status: historyStatus, kind: historyKind, sort: historySort });
    const historyDate = time => {
      if (!time) return '';
      try { return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time * 1000)); }
      catch { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: '2-digit', day: '2-digit' }).format(new Date(time * 1000)); }
    };
    function paintHistory() {
      if (!$('[data-chat-history]')) return;
      $('[data-chat-history]').hidden = !historyOpen; $('.ai-dialogue').classList.toggle('history-collapsed', !historyOpen);
      const historyEntry = $('.ai-history-leading');
      historyEntry.hidden = !compact && historyOpen;
      historyEntry.setAttribute('aria-expanded', String(historyOpen));
      const unreadBadge = $('[data-history-unread]');
      if (unreadBadge) {
        const count = allHistory().filter(item => item.kind === 'thread' && item.status === 'active' && item.unread).length;
        unreadBadge.hidden = count === 0;
        unreadBadge.textContent = count > 99 ? '99+' : String(count);
        historyEntry.setAttribute('aria-label', count ? `展开历史对话，${count} 段未读` : '展开历史对话');
      }
      for (const button of root.querySelectorAll('.ai-history-views [data-history-status]')) button.setAttribute('aria-pressed', String(button.dataset.historyStatus === historyStatus));
      $('[data-history-heading]').textContent = historyStatus === 'trash' ? '回收站' : historyStatus === 'archived' ? '已归档' : '历史';
      $('[data-history-back]').hidden = historyStatus === 'active';
      $('[data-history-reset]').hidden = historyKind === 'all' && historySort === 'newest';
      if (!historyOpen) $('[data-history-options]').open = false;
      $('[data-history-kind]').value = historyKind; $('[data-history-sort]').value = historySort;
      $('[data-history-manage]').textContent = historyBatch ? '结束批量管理' : '批量管理';
      $('[data-history-manage]').disabled = !historyAvailable || historyBusy;
      $('[data-history-refresh]').disabled = loading || historyBusy || !connected;
      const list = filteredHistory(), pages = Math.max(1, Math.ceil(list.length / 50)); historyPage = Math.min(historyPage, pages);
      const page = list.slice((historyPage - 1) * 50, historyPage * 50);
      let lastGroup;
      $('[data-chat-history-list]').innerHTML = page.map(s => {
        const group = s.pinned && historyStatus === 'active' ? '置顶' : '';
        const caption = group && group !== lastGroup ? '<p class="ai-history-caption">置顶</p>' : !group && lastGroup === '置顶' ? '<p class="ai-history-caption">最近</p>' : ''; lastGroup = group;
        const current = s.kind === 'thread' ? conversationId === s.id && !legacy : legacyId === s.id;
        return caption + `<div class="ai-history-row ${current ? 'current' : ''}">${historyBatch ? `<input type="checkbox" data-history-select="${esc(s.key)}" aria-label="选择 ${esc(s.title)}" ${historySelection.has(s.key) ? 'checked' : ''} ${historyBusy ? 'disabled' : ''}/>` : ''}<button class="ai-history-item" data-chat-action="${historyStatus === 'trash' ? 'history-menu' : s.kind === 'legacy' ? 'legacy' : 'open'}" data-id="${esc(s.id)}" data-key="${esc(s.key)}" title="${esc(s.title + (s.time ? ' · ' + historyDate(s.time) : ''))}" ${current ? 'aria-current="page"' : ''}><span>${memory && s.unread && s.status === 'active' ? '<i class="ai-history-unread-dot" aria-label="未读"></i>' : ''}${esc(s.title)}</span><small class="ai-history-source" data-source="${esc(s.source)}">${esc(sourceLabels[s.source])}</small></button><button class="ai-history-more" data-chat-action="history-menu" data-key="${esc(s.key)}" aria-label="管理 ${esc(s.title)}">⋯</button></div>`;
      }).join('') || `<p class="ai-history-empty">${query ? '没有找到匹配的对话。' : historyStatus === 'trash' ? '回收站是空的。删除的对话可在这里恢复。' : historyStatus === 'archived' ? '还没有归档的对话。' : '从第一句开始，聊过的内容会留在这里。'}</p>`;
      $('[data-history-pagination]').hidden = pages <= 1;
      $('[data-history-pagination]').innerHTML = `<span>${list.length} 段对话</span><button data-chat-action="history-prev" aria-label="上一页历史" ${historyPage === 1 ? 'disabled' : ''}>‹</button><span>${historyPage} / ${pages}</span><button data-chat-action="history-next" aria-label="下一页历史" ${historyPage === pages ? 'disabled' : ''}>›</button>`;
      $('[data-history-batch]').hidden = !historyBatch;
      $('[data-history-batch]').innerHTML = `<div><span>已选 ${historySelection.size} 项</span><button data-chat-action="history-manage">完成</button></div><div><button data-chat-action="history-select-page">${page.length && page.every(s => historySelection.has(s.key)) ? '取消本页' : '选择本页'}</button></div><div>${(historyStatus === 'trash' ? [['restore', '恢复']] : [['pin', '置顶'], [historyStatus === 'archived' ? 'unarchive' : 'archive', historyStatus === 'archived' ? '取消归档' : '归档'], ['trash', '删除']]).map(([op, label]) => `<button data-chat-action="history-bulk" data-operation="${op}" ${!historySelection.size || historyBusy ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
    }
    function toggleHistory() {
      historyOpen = !historyOpen;
      paintHistory();
      if (historyOpen) void refreshHistoryList();
    }
    function openHistoryMenu(key) {
      const row = allHistory().find(s => s.key === key); if (!row) return;
      managedKey = key;
      $('[data-history-dialog-title]').textContent = row.title;
      $('[data-history-rename-input]').value = row.title;
      $('[data-history-dialog-note]').textContent = historyAvailable ? '管理仅调整助理中的列表，不改写原对话内容。' : '当前盒子需要更新历史管理接口；原对话仍可查看和导出。';
      $('[data-history-rename-form]').hidden = row.status === 'trash' || !historyAvailable;
      $('[data-history-dialog-actions]').innerHTML = `${(row.status === 'trash' ? [['restore', '恢复对话']] : [[row.pinned ? 'unpin' : 'pin', row.pinned ? '取消置顶' : '置顶对话'], [row.status === 'archived' ? 'unarchive' : 'archive', row.status === 'archived' ? '取消归档' : '归档对话'], ['trash', '移到回收站']]).map(([op, label]) => `<button data-chat-action="history-apply" data-operation="${op}" ${!historyAvailable ? 'disabled' : ''}>${label}</button>`).join('')}<button data-chat-action="history-export">导出 JSON</button>`;
      $('[data-chat-history-dialog]').showModal();
    }
    async function organizeHistory(operation, keys, title) {
      if (historyBusy || !historyAvailable || !keys.length) return;
      const rows = allHistory().filter(s => keys.includes(s.key));
      if (rows.length > 100) { error = '每次最多选择 100 段对话。'; paintStatus(); return; }
      if (['trash', 'archive'].includes(operation) && (active || pending || busy || uploading) && rows.some(s => s.kind === 'thread' && s.id === threadId || s.kind === 'legacy' && s.id === legacyId)) {
        $('[data-history-dialog-note]').textContent = '这段对话正在工作，请完成或停止后再调整。'; return;
      }
      const gen = generation; historyBusy = true; paintHistory();
      for (const b of $('[data-chat-history-dialog]').querySelectorAll('button')) b.disabled = true;
      try {
        if (['trash', 'archive'].includes(operation) && (spaceEnabled || knowledgeEnabled) && rows.some(s => s.kind === 'thread' && s.id === threadId || s.kind === 'legacy' && s.id === legacyId)) await call('release-context');
        const result = await call('history-update', { operation, items: rows.map(s => ({ kind: s.kind, id: s.id })), ...(title !== undefined ? { title } : {}) });
        if (gen !== generation) return;
        organization = result.entries; historySelection.clear();
        if (['trash', 'archive'].includes(operation) && rows.some(s => s.kind === 'thread' && s.id === threadId || s.kind === 'legacy' && s.id === legacyId)) {
           epoch++; stopWatch(); threadId = null; legacy = null; legacyId = null; messages = []; active = false; pending = null; pendingPaint = ''; submitted = null; hasMore = false;
          $('[data-chat-artifacts]').innerHTML = ''; paintMessages(); paintPending(); paintStatus();
        }
        $('[data-chat-history-dialog]').close(); notice = operation === 'trash' ? '已移到回收站，可以随时恢复。' : '历史对话已更新。'; error = ''; paintStatus();
      } catch (e) {
        if (gen === generation) { $('[data-history-dialog-note]').textContent = errorText(e); error = errorText(e); paintStatus(); }
      } finally {
        if (gen === generation) { historyBusy = false; for (const b of $('[data-chat-history-dialog]').querySelectorAll('button')) b.disabled = false; paintHistory(); }
      }
    }
    function paintSpaceDialog() {
      if (!$('[data-chat-space-dialog]')) return;
      for (const radio of root.querySelectorAll('[data-space-mode]')) { radio.checked = radio.value === scopeMode; radio.disabled = spaceBusy; }
      $('[data-space-choice]').hidden = scopeMode === 'all';
      $('[data-space-directory]').hidden = scopeMode !== 'folder';
      $('[data-space-select]').innerHTML = scopeSpaces.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
      $('[data-space-select]').value = scopeSpaceId; $('[data-space-select]').disabled = spaceBusy;
      $('[data-space-crumbs]').innerHTML = '<button type="button" data-chat-action="space-root">空间根目录</button>' + scopeCrumbs.map(c => '<span> / </span><button type="button" data-chat-action="space-folder" data-id="' + esc(c.id) + '">' + esc(c.name) + '</button>').join('');
      $('[data-space-folders]').innerHTML = scopeFolders.map(f => '<button type="button" data-chat-action="space-folder" data-id="' + esc(f.id) + '"><span>▱ ' + esc(f.name) + '</span><span>›</span></button>').join('') || '<p>当前目录没有子文件夹。</p>';
      const name = scopeSpaces.find(s => s.id === scopeSpaceId)?.name || '所选空间';
      $('[data-space-selection]').textContent = scopeMode === 'all' ? '允许读取当前账号全部空间的内容' : scopeMode === 'space' ? '允许读取：' + name + ' · 全部内容' : '允许读取：' + name + (scopeCrumbs.length ? ' / ' + scopeCrumbs.map(c => c.name).join(' / ') : '') + ' · 含子文件夹';
      $('[data-space-confirm]').disabled = spaceBusy || !scopeSpaces.length || scopeMode === 'folder' && !scopeFolderId;
      for (const b of $('[data-space-directory]').querySelectorAll('button')) b.disabled = spaceBusy;
    }
    async function browseSpace(parent = '') {
      if (!spaceAvailable) return;
      const gen = generation, sid = scopeSpaceId; spaceBusy = true; paintSpaceDialog(); paintStatus();
      try {
        const result = await call('space-list', { spaceId: sid, parent });
        if (gen !== generation || sid !== scopeSpaceId) return;
        scopeFolderId = result.parent; scopeFolders = result.folders; scopeCrumbs = result.breadcrumbs;
        $('[data-space-note]').textContent = '';
      } catch (e) { if (gen === generation) $('[data-space-note]').textContent = errorText(e); }
      finally { if (gen === generation) { spaceBusy = false; paintSpaceDialog(); paintStatus(); } }
    }
    async function showSpaceSettings() {
      if (!spaceAvailable || spaceBusy || active || busy || pending || legacy || !scope) return;
      const gen = generation; scopeMode = spaceSelection?.mode || 'space'; scopeSpaceId = spaceSelection?.space_id || 'personal';
      scopeFolderId = spaceSelection?.folder_id || ''; scopeFolders = []; scopeCrumbs = []; spaceBusy = true;
      $('[data-space-note]').textContent = '正在读取空间目录…'; paintSpaceDialog(); paintStatus(); $('[data-chat-space-dialog]').showModal();
      try {
        const result = await call('space-list');
        if (gen !== generation) return;
        scopeSpaces = result.spaces;
        if (!scopeSpaces.some(s => s.id === scopeSpaceId)) scopeSpaceId = scopeSpaces[0]?.id || 'personal';
        spaceBusy = false;
        if (scopeMode === 'folder') await browseSpace(scopeFolderId);
        else $('[data-space-note]').textContent = '发送时按所选范围读取；取消勾选可停止后续读取。';
      } catch (e) { if (gen === generation) $('[data-space-note]').textContent = errorText(e); }
      finally { if (gen === generation) { spaceBusy = false; paintSpaceDialog(); paintStatus(); } }
    }
    async function disableSpace() {
      if (!spaceAvailable || !spaceEnabled) return;
      const gen = generation; spaceBusy = true; paintStatus();
      try { const changed=await call('space-grant', { enabled: false,threadId });acceptConversation(changed.conversation); if (gen === generation) { spaceEnabled = false; spaceSelection = null; spaceLabel = ''; } }
      finally { if (gen === generation) { spaceBusy = false; paintStatus(); } }
    }
    async function confirmSpace() {
      if (!spaceAvailable || spaceBusy) return;
      const selection = { mode: scopeMode, ...(scopeMode !== 'all' ? { space_id: scopeSpaceId } : {}), ...(scopeMode === 'folder' ? { folder_id: scopeFolderId } : {}) };
      const gen = generation; spaceBusy = true; paintSpaceDialog(); paintStatus();
      try {
        const result = await call('space-grant', { enabled: true, selection, threadId });
        if (gen !== generation) return;
        acceptConversation(result.conversation);spaceEnabled = result.enabled; spaceSelection = result.selection; spaceLabel = result.label;
        $('[data-chat-space-dialog]').close(); error = '';
      } catch (e) { if (gen === generation) $('[data-space-note]').textContent = errorText(e); }
      finally { if (gen === generation) { spaceBusy = false; paintSpaceDialog(); paintStatus(); } }
    }
    function sourceButtons(text) {
      if (!knowledgeAvailable) return '';
      let data; try { data = JSON.parse(text); } catch { return ''; }
      if (!Array.isArray(data?.assistant_knowledge_sources) || !data.assistant_knowledge_sources.length) return '';
      return '<div class="ai-knowledge-sources">' + data.assistant_knowledge_sources.filter(r => /^[A-Za-z0-9_-]{1,128}$/.test(r.evidence_id || '') && /^[a-f0-9-]{36}$/.test(r.warehouse_id || '')).map(r => {
        const key = r.warehouse_id + ':' + r.evidence_id; sourceLinks.set(key, r);
        return '<button type="button" data-chat-action="knowledge-source" data-id="' + esc(key) + '"><span>◈ ' + esc(r.warehouse_name) + '</span>' + esc(r.document_name || '查看证据来源') + ' ↗</button>';
      }).join('') + '</div>';
    }
    function paintKnowledgeDialog() {
      const list = $('[data-knowledge-options]'); if (!list) return;
      const needle = knowledgeQuery.trim().toLowerCase();
      list.innerHTML = knowledgeCatalog.filter(w => w.name.toLowerCase().includes(needle)).map(w => '<label><input type="checkbox" data-knowledge-choice value="' + esc(w.id) + '"' + (knowledgeChoices.has(w.id) ? ' checked' : '') + (!w.available || knowledgeBusy ? ' disabled' : '') + '/><span><strong>' + esc(w.name) + '</strong><small>' + (w.available ? '只读 · 检索、图谱和证据' : '暂不可用，请联系管理员') + '</small></span></label>').join('') || '<p>没有可用数据仓。请先在星图中准备数据仓；团队成员还需获得授权。</p>';
      $('[data-knowledge-confirm]').disabled = knowledgeBusy || !knowledgeChoices.size;
    }
    async function showKnowledgeSettings() {
      if (!knowledgeAvailable || knowledgeBusy || active || busy || pending) return;
      const gen = generation; knowledgeBusy = true; knowledgeChoices = new Set(knowledgeWarehouses.map(w => w.id)); knowledgeQuery = '';
      $('[data-knowledge-search]').value = ''; $('[data-knowledge-note]').textContent = '正在读取已授权仓库…';
      paintKnowledgeDialog(); paintStatus(); $('[data-chat-knowledge-dialog]').showModal();
      try {
        const value = await call('knowledge-list'); if (gen !== generation) return;
        knowledgeCatalog = value.items; knowledgeChoices = new Set([...knowledgeChoices].filter(id => knowledgeCatalog.some(w => w.id === id && w.available)));
        $('[data-knowledge-note]').textContent = '可多选；仅查询你有权使用的仓库。';
      } catch (e) { if (gen === generation) $('[data-knowledge-note]').textContent = errorText(e); }
      finally { if (gen === generation) { knowledgeBusy = false; paintKnowledgeDialog(); paintStatus(); } }
    }
    async function confirmKnowledge() {
      if (!knowledgeAvailable || knowledgeBusy || !knowledgeChoices.size) return;
      const gen = generation; knowledgeBusy = true; paintKnowledgeDialog(); paintStatus();
      try {
        const value = await call('knowledge-grant', { enabled: true, warehouses: [...knowledgeChoices], threadId });
        if (gen !== generation) return;
        acceptConversation(value.conversation);knowledgeEnabled = value.enabled; knowledgeWarehouses = value.warehouses; error = ''; $('[data-chat-knowledge-dialog]').close();
      } catch (e) { if (gen === generation) $('[data-knowledge-note]').textContent = errorText(e); }
      finally { if (gen === generation) { knowledgeBusy = false; paintKnowledgeDialog(); paintStatus(); } }
    }
    async function disableKnowledge() {
      if (!knowledgeAvailable) return;
      const gen = generation; knowledgeBusy = true; paintStatus();
      try { const changed=await call('knowledge-grant', { enabled: false,threadId });acceptConversation(changed.conversation); if (gen === generation) { knowledgeEnabled = false; knowledgeWarehouses = []; } }
      finally { if (gen === generation) { knowledgeBusy = false; paintStatus(); } }
    }
    async function previewKnowledge(key) {
      const ref = sourceLinks.get(key); if (!knowledgeAvailable || !ref || !threadId) return;
      const gen = generation, current = threadId;
      const value = await call('knowledge-evidence', { threadId, warehouseId: ref.warehouse_id, evidenceId: ref.evidence_id });
      if (gen !== generation || threadId !== current) return;
      artifactPath = null; $('[data-artifact-name]').textContent = value.warehouse.name + ' · ' + (ref.document_name || '证据来源');
      $('[data-artifact-content]').innerHTML = markdown(value.result.text || value.result.excerpt || JSON.stringify(value.result, null, 2));
      $('[data-artifact-note]').textContent = '只读证据 · 遵循数据仓保护规则';
      $('[data-chat-artifact-dialog] [data-chat-action="save-artifact"]').hidden = true;
      $('[data-chat-artifact-dialog]').showModal();
    }
    function paintPending() {
      const node = $('[data-chat-pending]'); if (!node) return;
      const key = JSON.stringify(pending?.action_requests || null); if (key === pendingPaint) return; pendingPaint = key;
      if (!pending?.action_requests?.length) { node.innerHTML = ''; return; }
      node.innerHTML = `<form data-chat-approval><div class="ai-approval-heading"><strong>${pending.action_requests.every(action => action.name === 'ask_user_question') ? '请选择或补充' : '助理需要你的确认'}</strong><span>回答后继续对话</span></div>${pending.action_requests.map((action, i) => {
        const questions = action.name === 'ask_user_question' ? action.args?.questions || [] : [];
        const allowed = pending.review_configs?.find(c => c.action_name === action.name)?.allowed_decisions || ['approve', 'reject'];
        return `<fieldset data-approval-index="${i}"><legend>${esc(action.description || (questions.length ? '请补充信息' : action.name))}</legend>${questions.length ? questions.map((q, n) => `<div class="ai-question"><p>${esc(q.question)}</p>${(q.options || []).map(o => `<label><input type="${q.multi_select ? 'checkbox' : 'radio'}" name="q-${i}-${n}" value="${esc(o.label)}"/> ${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</label>`).join('')}<textarea name="free-${i}-${n}" rows="2" placeholder="也可以直接填写你的回答" maxlength="8000"></textarea></div>`).join('') : `<pre>${esc(JSON.stringify(action.args || {}, null, 2))}</pre><div class="ai-approval-choices">${allowed.includes('approve') ? `<label><input type="radio" name="decision-${i}" value="approve" required/> 同意本次操作</label>` : ''}${allowed.includes('reject') ? `<label><input type="radio" name="decision-${i}" value="reject" required/> 拒绝本次操作</label>` : ''}${allowed.includes('respond') ? `<textarea name="response-${i}" rows="2" placeholder="填写回复" required></textarea>` : ''}</div>`}</fieldset>`;
      }).join('')}<button type="submit" class="ai-approval-submit">提交并继续</button></form>`;
    }
    function paintStatus() {
      if (!root) return;
      onSummary?.({ sources: memory
        ? sourceOptions.filter(([key]) => selectedSources[key]).map(([, label]) => label)
        : [spaceEnabled ? (spaceLabel || "文件空间") : '', knowledgeEnabled ? '星图知识库' : ''].filter(Boolean) });
      if (memory) {
        const labels = sourceOptions.filter(([key]) => selectedSources[key]).map(([, label]) => label);
        $('[data-zhijun-source-summary]').textContent = labels.join(' · ') || '已关闭';
        for (const button of root.querySelectorAll('[data-chat-action="source-settings"]')) {
          const key = button.dataset.sourceKey;
          button.textContent = sourceNames[key] || scopeDefaults[key];
          button.disabled = !scope || !selectedSources[key] || busy || active || Boolean(legacy);
        }
      }
      for (const [key, , description] of sourceOptions) {
        const control = root.querySelector(`[data-source-key="${key}"]`);
        if (!control) continue;
        control.setAttribute('aria-pressed', String(selectedSources[key]));
        control.disabled = !scope || busy || Boolean(legacy);
        control.title = loaded && !sourceSupport ? description + '。当前盒端版本可能不支持自动检索。' : description;
      }
      const streamError = streamRecovery?.failed ? '对话连接暂未恢复。恢复连接后会读取已有结果。' : '';
      const line = error || streamError || notice || (loading ? '正在连接助理…' : !connected ? "连接盒子后开始工作。" : !models.length && loaded ? '后台暂无可用的对话模型。配置后可恢复连接。' : '');
      const node = $('[data-chat-notice]'); node.hidden = !line;
      node.innerHTML = `<span>${esc(line)}</span>${connected && (error || streamError || uncertain || !models.length && loaded) ? '<button data-chat-action="reconnect">恢复连接</button>' : ''}`;
      const input = $('[data-chat-input]'); input.disabled = !connected || !scope || Boolean(legacy);
      const send = $('[data-chat-send]'); send.disabled = !scope || busy || uploading || opening || modeSaving || active || uncertain || Boolean(streamRecovery) || spaceBusy || knowledgeBusy || draft.length > 32000 || Boolean(pending) || Boolean(legacy) || (!models.some(m => m.id === selected) && !(zhijunMemory?.recognizes(draft.trim()) && !attachments.length && !reference.trim())) || !draft.trim() && !attachments.length && !reference.trim();
      const stop = $('[data-chat-stop]');
      const generating = active && !legacy;
      if (memory) {
        const canStop = generating && !submittingTurn && Boolean(threadId);
        const action = $('[data-zhijun-primary]');
        action.setAttribute('aria-busy', String(submittingTurn || (canStop && stoppingTurn)));
        send.hidden = canStop;
        const sendLabel = submittingTurn ? '发送中' : '发送';
        send.querySelector('.ai-zhijun-action-label').textContent = sendLabel;
        send.setAttribute('aria-label', sendLabel);
        stop.hidden = !canStop;
        stop.disabled = busy || stoppingTurn;
        const stopLabel = stoppingTurn ? '停止中' : '停止';
        stop.querySelector('.ai-zhijun-action-label').textContent = stopLabel;
        stop.setAttribute('aria-label', stopLabel);
      } else {
        send.textContent = busy ? '发送中' : '发送 ↑';
        stop.hidden = !generating;
        stop.disabled = busy;
      }
      if ($('[data-assistant-channels]')) { $('[data-assistant-channels]').hidden = !channelsAvailable; $('[data-assistant-channels]').disabled = !channelsAvailable; }
      $('[data-chat-attach]').hidden = !attachmentsAvailable;
      $('[data-chat-attach]').disabled = !attachmentsAvailable || !scope || busy || uploading || Boolean(legacy) || attachments.length >= 8;
      $('[data-chat-attach]').querySelector('span').textContent = uploading ? '正在添加…' : '添加附件';
      if (memory) $('[data-chat-attach]').title = uploading ? '正在添加…' : '添加附件';
      $('[data-top-space]').hidden = !spaceAvailable;
      $('[data-chat-space-toggle]').checked = spaceEnabled;
      $('[data-chat-space-toggle]').disabled = !spaceAvailable || !scope || spaceBusy || Boolean(legacy) || (!spaceEnabled && (active || busy || Boolean(pending)));
      $('[data-chat-space-settings]').hidden = !spaceEnabled;
      $('[data-chat-space-settings]').disabled = !spaceAvailable || spaceBusy || active || busy || Boolean(pending);
      $('[data-chat-space-settings]').textContent = spaceLabel ? `${spaceLabel} ⌄` : '选择访问范围';
      $('[data-chat-space-settings]').title = spaceLabel;
      $('[data-chat-knowledge-entry]').hidden = !knowledgeAvailable;
      $('[data-chat-knowledge-toggle]').checked = knowledgeEnabled;
      $('[data-chat-knowledge-toggle]').disabled = !knowledgeAvailable || !scope || knowledgeBusy || Boolean(legacy) || (!knowledgeEnabled && (active || busy || Boolean(pending)));
      $('[data-chat-knowledge-settings]').hidden = !knowledgeEnabled;
      $('[data-chat-knowledge-settings]').disabled = !knowledgeAvailable || knowledgeBusy || active || busy || Boolean(pending);
      $('[data-chat-knowledge-settings]').textContent = knowledgeWarehouses.length ? (knowledgeWarehouses.length===1?knowledgeWarehouses[0].name:'已选 '+knowledgeWarehouses.length+' 项') + ' ⌄' : '选择数据仓';
      paintVersions();
      paintUsage();
      $('[data-chat-composer]').hidden = Boolean(legacy);
      $('[data-chat-attachments]').innerHTML = attachments.map(file => `<span class="ai-attachment">▤ ${esc(file.name)}<button type="button" data-chat-action="remove-file" data-id="${esc(file.handle)}" aria-label="移除 ${esc(file.name)}">×</button></span>`).join('');
      $('[data-chat-reference]').hidden = !reference;
      if ($('[data-chat-reference-text]').value !== reference) $('[data-chat-reference-text]').value = reference;
      $('[data-chat-reference-count]').textContent = `${reference.length} / 32000 字符，可编辑删减`;
      paintConversationMode();
      for (const button of root.querySelectorAll('[data-chat-action="new"]')) button.disabled = !scope || busy || uploading || opening || modeSaving;
      for (const button of root.querySelectorAll('[data-chat-action="model"]')) button.disabled = !scope || opening;
    }
    function paint() { if (!root) return; paintModels(); paintMessages(); paintHistory(); paintPending(); paintStatus();if(pendingHandoff)void importHandoff();syncDrawerWatch(); }
    async function browseZhijunSources(kind, parent = '') {
      const dialog = $('[data-zhijun-picker]');
      const ticket = { kind, generation };
      sourcePicker = ticket;
      dialog.querySelector('h3').textContent = scopeHeadings[kind];
      const content = dialog.querySelector('[data-zhijun-picker-content]');
      content.textContent = '正在读取…';
      if (!dialog.open) dialog.showModal();
      try {
        const result = await call('sidebar-source-list', { kind, parent });
        if (sourcePicker !== ticket || generation !== ticket.generation || !dialog.open) return;
        const option = (entry, action = 'source-select', label = entry.name) =>
          `<button type="button" data-chat-action="${action}" data-id="${esc(entry.id)}" data-source-name="${esc(entry.name)}">${esc(label)}</button>`;
        const all = option({ id: '', name: scopeDefaults[kind] });
        if (kind === 'space') {
          content.innerHTML = all + (parent
            ? `<p>${esc(result.folder.name)}</p>${option({ id: result.parent, name: '返回上一级' }, 'source-browse')}${option(result.folder, 'source-select', '使用此文件夹（含子文件夹）')}`
            : '') + (result.folders || []).map(folder => option(folder, 'source-browse')).join('');
        } else if (kind === 'starlink') {
          content.innerHTML = all + (result.warehouses || []).map(row => option(row)).join('') +
            (result.warehouses?.length ? '' : '<p>没有可选的星图仓库。</p>');
        } else {
          content.innerHTML = all + (result.savedMemoryAvailable !== false ? option({ id: 'zhijun', name: '仅已记内容' }) : '') +
            (result.agentCatalogUnavailable ? '<p>本机 Agent 记忆服务暂不可用。</p>' : result.agents?.length
              ? result.agents.map(row => option(row)).join('') : '<p>暂无可选的 Agent 记忆。</p>');
        }
      } catch (error) {
        if (sourcePicker === ticket) content.textContent = error.code === 'ZHIJUN_SCOPE_UNSUPPORTED'
          ? '盒子连接变更，请重新打开知君后再试。'
          : {space: '暂时无法读取空间文件夹。', starlink: '暂时无法读取星图仓库。', memory: '暂时无法读取本机 Agent 记忆来源。'}[kind];
      }
    }
    function mountConversationSettings() {
      $('[data-chat-attach]').innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8"/></svg><span>添加附件</span>';
      $('[data-chat-attach]').setAttribute('aria-label', '添加附件');
      $('.ai-composer-bottom>span:not([data-chat-context-summary])')?.classList.add('ai-keyboard-hint');
      $('.ai-chat-workspace').insertAdjacentHTML('afterbegin','<div class="ai-source-bar" data-chat-source-bar><div data-top-space></div><div class="ai-composer-context" data-chat-knowledge-entry hidden><label class="ai-space-toggle"><input type="checkbox" data-chat-knowledge-toggle/>' + (compact ? '星图知识库' : '星图记忆') + '</label><button type="button" class="ai-space-scope" data-chat-action="knowledge-settings" data-chat-knowledge-settings hidden>选择数据仓</button></div><details class="ai-context-details"><summary data-context-summary>上下文 · 暂无统计</summary><section data-context-breakdown></section></details></div><div class="ai-version-controls" data-chat-versions hidden></div>');
      $('[data-top-space]').append($('[data-chat-space-toggle]').closest('.ai-composer-context'));
      if (memory) {
        const bar = $('[data-chat-source-bar]');
        bar.classList.add('ai-zhijun-source-bar');
        $('[data-chat-composer]').insertAdjacentHTML('afterbegin',
          `<details class="ai-zhijun-scope"><summary>参考资料 <span data-zhijun-source-summary></span></summary>
          <div class="ai-zhijun-sources" role="group" aria-label="回答参考资料">${sourceOptions.map(([key, label]) =>
            `<div class="ai-zhijun-source-row"><button type="button" class="ai-zhijun-source" data-chat-action="toggle-source" data-source-key="${key}" aria-pressed="true"><span aria-hidden="true"></span>${label}</button>
            <button type="button" class="ai-zhijun-settings" data-chat-action="source-settings" data-source-key="${key}" title="${scopeHeadings[key]}"></button></div>`
          ).join('')}</div></details>`);
        $('.ai-context-details').remove();
        $('.ai-dialogue').insertAdjacentHTML('beforeend', '<dialog class="ai-space-dialog ai-zhijun-picker" data-zhijun-picker aria-labelledby="zhijun-source-heading"><header><h3 id="zhijun-source-heading"></h3><button type="button" data-chat-action="source-close" aria-label="关闭参考范围">×</button></header><div data-zhijun-picker-content></div></dialog>');
      }
      $('.ai-composer-bottom').insertBefore($('.ai-model-section'),$('.ai-keyboard-hint'));
      if (memory) {
        const modelPicker = $('[data-chat-model-picker]');
        const search = $('[data-chat-model-search]');
        modelPicker.id = 'zhijun-model-options';
        modelPicker.setAttribute('aria-label', '选择模型');
        modelPicker.querySelector('strong').textContent = '选择模型';
        modelPicker.querySelector('button').type = 'button';
        search.placeholder = '搜索模型或供应商';
        search.setAttribute('aria-label', search.placeholder);
        search.insertAdjacentHTML('beforebegin', '<label class="ai-model-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></svg></label>');
        search.previousElementSibling.append(search);
        search.parentElement.insertAdjacentHTML('afterend', '<div class="ai-model-default" data-chat-model-default></div>');
        $('.ai-model-section').insertAdjacentHTML('afterend', `<div class="ai-mode-setting">
          <button type="button" class="ai-footer-mode" data-chat-action="modes" aria-controls="zhijun-mode-options" aria-haspopup="dialog" aria-expanded="false"></button>
          <div class="ai-mode-menu" id="zhijun-mode-options" data-mode-panel role="dialog" aria-label="对话模式" hidden>
            <div class="ai-mode-heading">对话模式</div>
            ${Object.entries(dialogueModes).map(([mode, option]) => `<button type="button" class="ai-mode-option" data-chat-action="select-mode" data-id="${mode}" aria-pressed="false">
              <span class="ai-mode-symbol">${modeIcon(mode)}</span><span class="ai-mode-copy"><strong>${option.label}</strong><small>${option.hint}</small></span><span class="ai-choice-check" aria-hidden="true">✓</span>
            </button>`).join('')}
            <p data-mode-compatibility hidden>当前盒端尚未支持切换。选择保存在本机。</p>
          </div>
        </div>`);
        const footer = $('.ai-composer-bottom');
        const tools = document.createElement('div');
        tools.className = 'ai-zhijun-tools';
        tools.append($('[data-chat-attach]'), $('.ai-model-section'), $('.ai-mode-setting'));
        const primary = document.createElement('div');
        primary.className = 'ai-zhijun-primary';
        primary.setAttribute('data-zhijun-primary', '');
        const send = $('[data-chat-send]'), stop = $('[data-chat-stop]');
        send.innerHTML = '<span class="ai-zhijun-action-label">发送</span><span class="ai-zhijun-action-symbol" aria-hidden="true">↑</span>';
        stop.innerHTML = '<span class="ai-zhijun-action-symbol" aria-hidden="true">■</span><span class="ai-zhijun-action-label">停止</span>';
        primary.append(send, stop);
        $('.ai-keyboard-hint')?.remove();
        footer.append(tools, primary);
      }
      $('.ai-dialogue').insertAdjacentHTML('beforeend', '<dialog class="ai-space-dialog ai-knowledge-dialog" data-chat-knowledge-dialog aria-labelledby="knowledge-dialog-title"><header><div><h3 id="knowledge-dialog-title">选择星图知识库</h3><p>可同时使用多个已授权数据仓。</p></div><button data-chat-action="knowledge-close" aria-label="关闭知识库选择">×</button></header><input type="search" data-knowledge-search placeholder="搜索数据仓" aria-label="搜索数据仓"/><div class="ai-knowledge-options" data-knowledge-options></div><p class="ai-space-note" data-knowledge-note role="status"></p><footer><button data-chat-action="knowledge-close">取消</button><button data-chat-action="knowledge-confirm" data-knowledge-confirm>使用所选数据仓</button></footer></dialog>');
      $('.ai-dialogue').insertAdjacentHTML('beforeend','<dialog class="ai-history-dialog ai-edit-dialog" data-chat-edit-dialog><header><h3>编辑重发</h3><button type="button" data-chat-action="edit-close" aria-label="关闭编辑">×</button></header><p>保留原消息与回答，修改后生成新版本。</p><textarea data-edit-text rows="7" maxlength="32000" aria-label="修改消息内容"></textarea><div data-edit-files></div><p data-edit-error role="status"></p><footer><button type="button" data-chat-action="edit-close">取消</button><button type="button" data-chat-action="edit-send">保存并发送</button></footer></dialog>');
      $('.ai-chat-workspace').insertAdjacentHTML('beforeend','<button class="ai-scroll-bottom" data-chat-action="scroll-bottom" data-scroll-bottom hidden aria-label="回到底部">↓ 回到底部</button>');
      $('[data-chat-messages]').addEventListener('scroll',paintScroll);
      $('[data-chat-input]').rows = 1;
      $('[data-chat-knowledge-toggle]').addEventListener('change', async event => { try { if (event.target.checked) await showKnowledgeSettings(); else await disableKnowledge(); } catch (e) { error = errorText(e); } paintStatus(); });
      $('[data-knowledge-search]').addEventListener('input', event => { knowledgeQuery = event.target.value; paintKnowledgeDialog(); });
      $('[data-knowledge-options]').addEventListener('change', event => { if (!event.target.matches('[data-knowledge-choice]')) return; if (event.target.checked) knowledgeChoices.add(event.target.value); else knowledgeChoices.delete(event.target.value); paintKnowledgeDialog(); });
    }
    function setup(element) {
      root = element;
      root.innerHTML = `<section class="ai-dialogue${compact ? ' history-collapsed' : ''}${memory ? ' ai-zhijun-dialogue' : ''}"><header class="ai-dialogue-heading${english ? ' wanx-section-banner' : ''}" ${english ? 'data-section="chat"' : ''}>
        <div class="ai-heading-left"><button type="button" data-chat-action="history" class="ai-history-toggle ai-history-leading" aria-label="${compact ? '展开或收起历史对话' : '展开历史对话'}" title="${compact ? '展开或收起历史对话' : '展开历史对话'}" aria-controls="ai-chat-history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg><span>历史</span>${memory ? '<span class="ai-history-unread" data-history-unread hidden aria-hidden="true"></span>' : ''}</button><div class="ai-page-title"><span class="ai-page-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 5.5h16a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4H15l-7 4v-4a4 4 0 0 1-4-4v-11a4 4 0 0 1 4-4Z"/><path class="ai-mark-spark" d="m17 9 1.8 4.2L23 15l-4.2 1.8L17 21l-1.8-4.2L11 15l4.2-1.8Z"/><path d="M23 7.5v4m-2-2h4"/></svg></span><div><h2>${esc(title)}${english ? ` <span class="wanx-section-english">${esc(english)}</span>` : ''}</h2><p>${esc(subtitle || '多种 AI，随时为你所用。')}</p></div></div></div>
        <div class="ai-page-actions"><button type="button" class="ai-history-toggle ai-channels-trigger" data-assistant-channels aria-label="通道设置" title="管理微信、企业微信、飞书与钉钉通道"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M14 6h1a3 3 0 0 1 3 3v2M10 18H9a3 3 0 0 1-3-3v-2"/></svg><span>通道设置</span></button>${compact ? '<button type="button" class="ai-sidebar-new ai-collapsed-new" data-chat-action="new">＋ 新对话</button>' : ''}</div>
      </header><div class="ai-assistant-workbench"><aside id="ai-chat-history" class="ai-history" data-chat-history aria-label="历史对话" hidden><div class="ai-sidebar-heading"><div class="ai-sidebar-brand"><strong data-history-heading>历史</strong></div><div class="ai-sidebar-actions"><details class="ai-history-options" data-history-options><summary aria-label="历史选项" title="历史选项">⋯</summary><div class="ai-history-menu-panel"><div class="ai-history-views" role="group" aria-label="历史分类"><button type="button" data-chat-action="history-filter" data-history-status="active" aria-pressed="true">全部对话</button><button type="button" data-chat-action="history-filter" data-history-status="archived" aria-pressed="false">已归档</button><button type="button" data-chat-action="history-filter" data-history-status="trash" aria-pressed="false">回收站</button></div><div class="ai-history-filters"><label><span>类型</span><select data-history-kind aria-label="对话类型"><option value="all">全部类型</option><option value="thread">助理会话</option><option value="legacy">旧版对话</option></select></label><label><span>排序</span><select data-history-sort aria-label="历史排序"><option value="newest">最近使用</option><option value="oldest">最早使用</option><option value="title">按名称</option></select></label></div><div class="ai-history-tools"><button type="button" data-chat-action="history-manage" data-history-manage>批量管理</button><button type="button" data-chat-action="history-refresh" data-history-refresh>刷新列表</button></div></div></details><button type="button" data-chat-action="history" aria-label="收起历史对话" title="收起历史对话">‹</button></div></div>${compact ? '' : '<button type="button" class="ai-sidebar-new" data-chat-action="new">＋ 新对话</button>'}<label class="ai-history-search"><span class="sr-only">搜索对话</span><input type="search" data-chat-search placeholder="搜索对话"/></label><button type="button" class="ai-history-back" data-history-back data-chat-action="history-filter" data-history-status="active" hidden>← 返回对话</button><button type="button" class="ai-history-reset" data-history-reset data-chat-action="history-reset-filters" hidden>清除筛选</button><div class="ai-history-batch" data-history-batch hidden></div><div data-chat-history-list></div><footer class="ai-history-pagination" data-history-pagination></footer></aside><div class="ai-chat-workspace"><div class="ai-model-section"><div class="ai-model-strip" data-chat-models></div><div class="ai-model-picker" data-chat-model-picker hidden role="dialog" aria-label="选择 AI 模型"><div><strong>选择 AI 模型</strong><button data-chat-action="close-models" aria-label="关闭模型选择">×</button></div><input type="search" data-chat-model-search placeholder="搜索模型或提供商" aria-label="搜索模型或提供商"/><div data-chat-model-options></div></div><p class="ai-model-hint" data-chat-next-model></p></div><div class="ai-chat-notice" data-chat-notice role="status" hidden></div><div class="ai-messages" data-chat-messages role="log" aria-label="助理对话记录"></div><div class="ai-bottom-dock"><div class="ai-artifacts" data-chat-artifacts></div><div class="ai-pending" data-chat-pending></div><form class="ai-composer" data-chat-composer><details class="ai-reference" data-chat-reference hidden open><summary>旧版对话参考 <span data-chat-reference-count></span><button type="button" data-chat-action="remove-reference">移除</button></summary><textarea data-chat-reference-text rows="4" aria-label="编辑旧版对话参考"></textarea></details><div class="ai-composer-context"><label class="ai-space-toggle"><input type="checkbox" data-chat-space-toggle/>文件空间</label><button type="button" class="ai-space-scope" data-chat-action="space-settings" data-chat-space-settings hidden>选择访问范围</button><span class="ai-space-readonly">按所选范围只读</span></div><div class="ai-attachments" data-chat-attachments></div><textarea data-chat-input rows="2" maxlength="32000" placeholder="${esc(introduction?.placeholder ?? (compact ? '把问题、材料或想法交给我…' : '搜索记忆或空间文件，例如：找一下上次会议的纪要…'))}" aria-label="给${esc(title)}发消息"></textarea><div class="ai-composer-bottom"><button type="button" data-chat-action="upload" data-chat-attach>＋ 添加附件</button><span>Enter 发送 · Shift + Enter 换行</span><button type="button" class="ai-stop" data-chat-action="stop" data-chat-stop hidden>■ 停止生成</button><button type="submit" class="ai-send" data-chat-send>发送 ↑</button></div></form></div></div></div><dialog class="ai-space-dialog" data-chat-space-dialog aria-labelledby="space-dialog-heading"><header><div><h3 id="space-dialog-heading">空间访问范围</h3><p>只读使用，访问范围只绑定当前对话。</p></div><button data-chat-action="space-close" aria-label="关闭空间范围设置">×</button></header><fieldset class="ai-space-modes"><legend class="sr-only">选择访问范围</legend><label><input type="radio" name="assistant-space-mode" value="all" data-space-mode/>全部空间</label><label><input type="radio" name="assistant-space-mode" value="space" data-space-mode/>指定空间</label><label><input type="radio" name="assistant-space-mode" value="folder" data-space-mode/>指定文件夹</label></fieldset><label class="ai-space-choice" data-space-choice>选择空间<select data-space-select aria-label="选择空间"></select></label><div class="ai-space-directory" data-space-directory hidden><nav data-space-crumbs aria-label="文件夹路径"></nav><div data-space-folders></div></div><p class="ai-space-selection" data-space-selection></p><p class="ai-space-note" data-space-note role="status"></p><footer><button data-chat-action="space-close">取消</button><button data-chat-action="space-confirm" data-space-confirm>使用所选范围</button></footer></dialog><dialog class="ai-history-dialog" data-chat-history-dialog aria-labelledby="history-dialog-heading"><header><h3 id="history-dialog-heading">管理对话</h3><button data-chat-action="history-close" aria-label="关闭历史管理">×</button></header><p class="ai-history-dialog-title" data-history-dialog-title></p><form data-history-rename-form><label>对话名称<input data-history-rename-input maxlength="100" required aria-label="对话名称"/></label><button type="submit">保存名称</button></form><div class="ai-history-dialog-actions" data-history-dialog-actions></div><p data-history-dialog-note role="status"></p></dialog><dialog class="ai-artifact-dialog" data-chat-artifact-dialog><div class="ai-artifact-title"><strong data-artifact-name></strong><button data-chat-action="close-artifact" aria-label="关闭产物预览">×</button></div><div data-artifact-content></div><div class="ai-artifact-footer"><span data-artifact-note></span><button data-chat-action="save-artifact">保存文件</button></div></dialog></section>`;
      $('[data-chat-input]').value = draft;
      mountConversationSettings();
      if (memory && window.createZhijunMemory) {
        zhijunMemory = window.createZhijunMemory({
          root: $('.ai-dialogue'),
          call: (method, input) => call(method, method === 'sidebar-memory' && input.action !== 'search'
            ? { ...input, conversationId, conversationMode } : input),
          ready: () => Boolean(scope && loaded && connected),
          canWrite: canWriteMemory,
          onWriteBlocked: () => { notice = memoryWriteHint(); paintStatus(); },
          origin: () => threadId && !legacy ? { threadId } : {},
          async openThread(id, messageId) {
            const gen = generation;
            await openThread(id);
            if (gen === generation && messageId)
              root.querySelectorAll('[data-chat-action="remember-message"]').forEach(button => {
                if (button.dataset.id === messageId) button.closest('article')?.scrollIntoView({ block: 'center' });
              });
          },
        });
        $('.ai-page-actions').insertAdjacentHTML('beforeend', '<button type="button" class="ai-history-toggle" data-chat-action="new">新对话</button>');
        const channelButton = $('[data-assistant-channels]');
        channelButton.querySelector('span').textContent = '手机通道';
        channelButton.setAttribute('aria-label', '手机通道');
      }
      if(compact) $('[data-assistant-channels]').remove();
      else channelsPanel = window.createAssistantChannelsPanel({root,call,getScope:()=>scope,getBoxName:()=>boxName,ready:()=>loaded&&connected&&channelsAvailable, zhijun: memory});
      $('[data-chat-input]').addEventListener('input', event => { draft = event.target.value; event.target.style.height = 'auto'; event.target.style.height = `${Math.min(160, event.target.scrollHeight)}px`; paintStatus(); });
      $('[data-chat-input]').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } });
      $('[data-chat-composer]').addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); void send(); });
      $('[data-chat-reference-text]').addEventListener('input', event => { reference = event.target.value; paintStatus(); });
      $('[data-chat-search]').addEventListener('input', event => { query = event.target.value; historyPage = 1; historySelection.clear(); paintHistory(); });
      $('[data-history-kind]').addEventListener('change', event => { historyKind = event.target.value; historyPage = 1; historySelection.clear(); paintHistory(); });
      $('[data-history-sort]').addEventListener('change', event => { historySort = event.target.value; historyPage = 1; paintHistory(); });
      $('[data-history-rename-form]').addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); if (managedKey) void organizeHistory('rename', [managedKey], $('[data-history-rename-input]').value.trim()); });
      $('[data-chat-space-toggle]').addEventListener('change', async event => {
        if (event.target.checked) { await showSpaceSettings(); paintStatus(); }
        else { try { await disableSpace(); } catch (e) { error = errorText(e); paintStatus(); } }
      });
      $('[data-chat-space-dialog]').addEventListener('cancel', () => { paintStatus(); });
      $('[data-space-select]').addEventListener('change', async event => { scopeSpaceId = event.target.value; scopeFolderId = ''; scopeFolders = []; scopeCrumbs = []; if (scopeMode === 'folder') await browseSpace(); else paintSpaceDialog(); });
      $('[data-chat-model-search]').addEventListener('input', event => { modelQuery = event.target.value; paintModels(); });
      root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modePickerOpen) {
          modePickerOpen = false; paintConversationMode();
          $('[data-chat-action="modes"]').focus();
          event.stopPropagation();
          return;
        }
        if (event.key === 'Escape' && memory && pickerOpen) {
          pickerOpen = false; paintModels();
          $('[data-chat-action="models"]').focus();
          event.stopPropagation();
          return;
        }
        if (event.key === 'Escape' && $('[data-history-options]').open) { $('[data-history-options]').open = false; event.stopPropagation(); return; } if (event.key === 'Escape' && !root.querySelector('dialog[open]')) { pickerOpen = false; historyOpen = false; paintModels(); paintHistory(); } });
      root.addEventListener('submit', async event => {
        const form = event.target.closest('[data-chat-approval]'); if (!form) return;
        event.preventDefault(); event.stopPropagation(); if (busy || !pending) return;
        const data = new FormData(form);
        let decisions;
        try { decisions = pending.action_requests.map((action, i) => {
          if (action.name === 'ask_user_question') {
            const answers = (action.args?.questions || []).map((q, n) => {
              const values = data.getAll(`q-${i}-${n}`).map(String), free = String(data.get(`free-${i}-${n}`) || '').trim();
              if (free) values.push(free);
              if (!values.length) throw new Error('请回答每个问题后再提交。');
              return `${q.question}\n${values.join('; ')}`;
            });
            return { type: 'respond', message: answers.join('\n\n') };
          }
          const response = String(data.get(`response-${i}`) || '').trim();
          return response ? { type: 'respond', message: response } : { type: String(data.get(`decision-${i}`)) };
        });
        } catch (e) { error = e.message; paintStatus(); return; }
        const gen = generation, turn = epoch; busy = true; paintStatus();
        try { await call('resume', { threadId, decisions }); if (gen !== generation || turn !== epoch) return; pending = null; active = true; paintPending(); }
        catch (e) { if (gen === generation && turn === epoch) error = errorText(e); }
        finally { if (gen === generation && turn === epoch) { busy = false; paintStatus(); } }
      });
      async function previewArtifact(filePath, save = false) {
      $('[data-chat-artifact-dialog] [data-chat-action="save-artifact"]').hidden = false;
        const gen = generation, turn = epoch;
        try {
          const value = await call('artifact', { threadId, path: filePath, save });
          if (gen !== generation || turn !== epoch) return;
          if (save) { $('[data-artifact-note]').textContent = value.saved ? '文件已保存。' : '已取消保存。'; return; }
          artifactPath = filePath; $('[data-artifact-name]').textContent = value.name;
          const node = $('[data-artifact-content]'); node.replaceChildren();
          if (value.dataURL) { const img = document.createElement('img'); img.src = value.dataURL; img.alt = value.name; node.append(img); }
          else if (value.text != null) { const pre = document.createElement('pre'); pre.textContent = value.text; node.append(pre); }
          else node.textContent = '这类文件暂不支持内嵌预览，可以保存后打开。';
          $('[data-artifact-note]').textContent = value.truncated ? '预览显示前 500000 字节，保存可获取完整文件。' : '';
          $('[data-chat-artifact-dialog]').showModal();
        } catch (e) { if (gen === generation && turn === epoch) { error = errorText(e); paintStatus(); } }
      }
      root.addEventListener('change', async event => { if (event.target.matches('[data-space-mode]')) { scopeMode = event.target.value; if (scopeMode === 'folder') await browseSpace(scopeFolderId); else paintSpaceDialog(); } if (event.target.dataset.historySelect) { const key = event.target.dataset.historySelect; event.target.checked ? historySelection.add(key) : historySelection.delete(key); paintHistory(); } if (event.target.dataset.legacyAnswer) legacyAnswer = event.target.dataset.legacyAnswer; });
      root.addEventListener('click', async event => {
        const options = $('[data-history-options]'); if (options.open && !options.contains(event.target)) options.open = false;
        if (modePickerOpen && !$('.ai-mode-setting')?.contains(event.target)) { modePickerOpen = false; paintConversationMode(); }
        if (memory && pickerOpen && !$('.ai-model-section').contains(event.target)) { pickerOpen = false; paintModels(); }
        const button = event.target.closest('[data-chat-action]'); if (!button || button.disabled) return;
        const action = button.dataset.chatAction, id = button.dataset.id, gen = generation, turn = epoch;
        if (modeSaving) return;
        try {
          if (action === 'modes') {
            modePickerOpen = !modePickerOpen;
            pickerOpen = false;
            paintModels(); paintConversationMode();
            if (modePickerOpen) $('[data-mode-panel] button[aria-pressed=true]')?.focus();
          }
          if (action === 'select-mode') await chooseConversationMode(id);
          if (action === 'toggle-source') {
            const key = button.dataset.sourceKey;
            if (Object.hasOwn(selectedSources, key)) selectedSources = { ...selectedSources, [key]: !selectedSources[key] };
            paintStatus();
            return;
          }
          if (action === 'source-settings') await browseZhijunSources(button.dataset.sourceKey);
          if (action === 'source-browse' && sourcePicker) await browseZhijunSources(sourcePicker.kind, id);
          if (action === 'source-close') $('[data-zhijun-picker]').close();
          if (action === 'source-select' && sourcePicker) {
            const kind = sourcePicker.kind;
            selectedSources = { ...selectedSources, [sourceFields[kind]]: id || undefined };
            sourceNames[kind] = id ? button.dataset.sourceName : '';
            $('[data-zhijun-picker]').close();
            paintStatus();
          }
          if (action === 'quick-remember') zhijunMemory?.remember('');
          if (action === 'continue-recent' && !busy && !opening && !active) await openThread(id);
          if (action === 'evidence-thread' && !busy && !opening && !active) {
            await openThread(id);
            if (gen === generation && button.dataset.messageId)
              for (const link of root.querySelectorAll('[data-chat-action="remember-message"]'))
                if (link.dataset.id === button.dataset.messageId) link.closest('article')?.scrollIntoView({ block: 'center' });
          }
          if (action === 'evidence-source') {
            const item = messages.find(message => message.id === id)?.evidence?.[Number(button.dataset.evidenceIndex)];
            if (!item) return;
            const value = await call('sidebar-source', {
              source: item.source, file_id: item.file_id, warehouse_id: item.warehouse_id, evidence_id: item.evidence_id,
            });
            if (gen !== generation || turn !== epoch || !visible) return;
            const preview = document.createElement('pre');
            preview.textContent = value.text;
            artifactPath = null;
            $('[data-artifact-name]').textContent = value.title || item.title;
            $('[data-artifact-content]').replaceChildren(preview);
            $('[data-artifact-note]').textContent = value.truncated ? '正文节选' : '资料出处';
            $('[data-chat-action="save-artifact"]').hidden = true;
            if (!$('[data-chat-artifact-dialog]').open) $('[data-chat-artifact-dialog]').showModal();
          }
          if (action === 'remember-message') {
            const message = messages.find(item => item.role === 'user' && item.id === id);
            if (message) zhijunMemory?.remember(message.text, id);
          }
          if (action === 'history') {
            toggleHistory();
            if (!compact) (historyOpen ? $('[data-chat-history] [data-chat-action="new"]') : $('.ai-history-leading'))?.focus();
          }
          if (action === 'history-menu') openHistoryMenu(button.dataset.key);
          if (action === 'history-close') $('[data-chat-history-dialog]').close();
          if (action === 'history-manage') { historyBatch = !historyBatch; historySelection.clear(); $('[data-history-options]').open = false; paintHistory(); }
          if (action === 'history-filter') { historyStatus = button.dataset.historyStatus; historyPage = 1; historySelection.clear(); $('[data-history-options]').open = false; paintHistory(); }
          if (action === 'history-reset-filters') { historyKind = 'all'; historySort = 'newest'; historyPage = 1; historySelection.clear(); paintHistory(); }
          if (action === 'history-prev') { historyPage--; historySelection.clear(); paintHistory(); }
          if (action === 'history-next') { historyPage++; historySelection.clear(); paintHistory(); }
          if (action === 'history-refresh') { $('[data-history-options]').open = false; await load(); }
          if (action === 'history-select-page') { const page = filteredHistory().slice((historyPage - 1) * 50, historyPage * 50), all = page.every(s => historySelection.has(s.key)); for (const row of page) all ? historySelection.delete(row.key) : historySelection.add(row.key); paintHistory(); }
          if (action === 'history-apply' && managedKey) await organizeHistory(button.dataset.operation, [managedKey]);
          if (action === 'history-bulk') await organizeHistory(button.dataset.operation, [...historySelection]);
          if (action === 'history-export' && managedKey && !historyBusy) {
            const row = allHistory().find(s => s.key === managedKey);
            if (row) { const result = await call('history-export', { kind: row.kind, id: row.id }); if (gen === generation) $('[data-history-dialog-note]').textContent = result.saved ? '对话文件已保存。' : '已取消导出。'; }
          }
          if (action === 'space-settings') await showSpaceSettings();
          if (action === 'space-root') await browseSpace();
          if (action === 'space-folder') await browseSpace(id);
          if(action==='version-prev')await changeVersion(-1);
          if(action==='version-next')await changeVersion(1);
          if(action==='scroll-bottom'){$('[data-chat-messages]').scrollTop=$('[data-chat-messages]').scrollHeight;paintScroll();}
          if(action==='edit'&&!active&&!pending&&!busy){const m=messages.find(m=>m.id===id&&m.role==='user');if(m){editingId=id;$('[data-edit-text]').value=m.text;$('[data-edit-files]').textContent=(m.files||[]).map(f=>f.name||f.filename||'附件').join(' · ');$('[data-edit-error]').textContent='';$('[data-chat-edit-dialog]').showModal();}}
          if(action==='edit-close')$('[data-chat-edit-dialog]').close();
          if(action==='edit-send'&&editingId)await revise('edit',editingId,$('[data-edit-text]').value);
          if(action==='regenerate')await revise('regenerate',id);
          if (action === 'knowledge-settings') await showKnowledgeSettings();
          if (action === 'knowledge-close') { $('[data-chat-knowledge-dialog]').close(); paintStatus(); }
          if (action === 'knowledge-confirm') await confirmKnowledge();
          if (action === 'knowledge-source') await previewKnowledge(id);
          if (action === 'space-close') { $('[data-chat-space-dialog]').close(); paintStatus(); }
          if (action === 'space-confirm') await confirmSpace();
          if (action === 'models') {
            pickerOpen = !pickerOpen;
            if (memory && pickerOpen) { modelQuery = ''; $('[data-chat-model-search]').value = ''; }
            paintModels();
            if (pickerOpen) { $('[data-chat-model-search]').focus(); await refreshModelSelection(); }
          }
          if (action === 'close-models') {
            pickerOpen = false; paintModels();
            if (memory) $('[data-chat-action="models"]').focus();
          }
          if (action === 'model-auto' || action === 'model' && models.some(m => m.id === id)) {
            const previous = selected, previousMode = modelMode, choice = ++modelChoice;
            modelMode = action === 'model-auto' ? 'auto' : 'manual';
            if (modelMode === 'manual') selected = id;
            pickerOpen = false; paintModels(); paintStatus();
            if (memory) $('[data-chat-action="models"]').focus();
            try {
              const result = await call('model', { threadId: legacy ? null : threadId, model: selected, modelMode });
              if (gen === generation && turn === epoch && choice === modelChoice) { if (result.modelMode) acceptModelSelection(result); error=''; paintModels(); paintStatus(); void refreshUsage(); }
            } catch (e) { if (gen === generation && turn === epoch && choice === modelChoice) { selected = previous; modelMode = previousMode; error = errorText(e); paintModels(); paintStatus(); } }
          }
          if (action === 'new') { await newChat(); if (drawer) { historyOpen = false; paintHistory(); } }
          if (action === 'reconnect') {
            error = '';
            if (streamRecovery) {
              streamRecovery = { attempts: 0, failed: false };
              scheduleRefresh(0);
              paintStatus();
            } else await load();
          }
          if (action === 'boxes') onBoxes();
          if (action === 'open') { if (legacy) { legacy = null; legacyId = null; } await openThread(id); if (drawer && !error) { historyOpen = false; paintHistory(); } }
          if (action === 'legacy' && !busy && !uploading) {

            if (spaceEnabled || knowledgeEnabled) await call('release-context');
            epoch++; const expected = epoch; stopWatch(); opening = true; paintStatus();
            const result = await call('legacy-open', { sessionId: id });
            if (gen !== generation || expected !== epoch) return;
            legacy = result.session; legacyId = id; legacyAnswer = legacy.groups?.at(-1)?.answers[0]?.id || null; opening = false; if (drawer) historyOpen = false; paint();
          }
          if (action === 'bring-legacy' && legacy) {
            const value = legacyReference(legacy, legacyAnswer); await newChat(); reference = value;
            if (value.length > 32000) error = '参考内容超过 32000 字符，请在下方删减后再发送。';
            paintStatus(); $('[data-chat-reference-text]').focus();
          }
          if (action === 'remove-reference') { reference = ''; paintStatus(); }
          if (action === 'older' && !active && !busy) {
            const value = await call('open', { threadId, offset: historyCount });
            if (gen !== generation || turn !== epoch) return;
            const area = $('[data-chat-messages]'), before = area.scrollHeight; acceptHistory(value.history, true); paintMessages(); area.scrollTop += area.scrollHeight - before;
          }
          if (action === 'upload' && attachmentsAvailable && !uploading) {
            uploading = true; error = ''; paintStatus();
            try {
              const value = await call('upload');
              if (gen !== generation || turn !== epoch || !attachmentsAvailable) return;
              const extra = value.files.slice(Math.max(0, 8 - attachments.length)); release(extra); attachments.push(...value.files.slice(0, 8 - attachments.length));
              if (extra.length) error = '一条消息最多添加 8 个附件，多余的附件未加入消息。';
            } finally { if (gen === generation && turn === epoch) { uploading = false; paintStatus(); } }
          }
          if (action === 'remove-file') { release(attachments.filter(f => f.handle === id)); attachments = attachments.filter(f => f.handle !== id); paintStatus(); }
          if (action === 'stop') {
            if (memory) { stoppingTurn = true; paintStatus(); }
            try {
              await call('stop', { threadId });
              if (!memory && gen === generation && turn === epoch) notice = '正在停止，已生成的内容会保留。';
            } finally {
              if (gen === generation && turn === epoch) { stoppingTurn = false; paintStatus(); }
            }
          }
          if (['copy', 'copy-code', 'copy-legacy'].includes(action)) {
            const value = action === 'copy-code' ? button.dataset.code : action === 'copy-legacy' ? legacy.groups.flatMap(g => g.answers).find(a => a.id === id)?.text : messages.find(m => m.id === id)?.text;
            if (value) {
              await navigator.clipboard.writeText(value);
              if (action === 'copy-code') {
                button.textContent = '已复制';
              } else {
                button.innerHTML = answerIcon('copied');
                button.setAttribute('aria-label', '已复制回答');
                button.title = '已复制回答';
              }
            }
          }
          if (action === 'artifact') await previewArtifact(button.dataset.path);
          if (action === 'close-artifact') $('[data-chat-artifact-dialog]').close();
          if (action === 'save-artifact' && artifactPath) await previewArtifact(artifactPath, true);
        } catch (e) { if (gen === generation) { opening = false; error = errorText(e); paintStatus(); } }
      });
      paint();
    }
    return {
      hostState(value) {
        const boxId = value.activeDeviceId || value.selectedDeviceId || value.connection?.deviceId;
        const phase = value.connectionPhase || value.phase;
        const ready = (!phase || ['ready', 'recovering', 'connected'].includes(phase)) && (value.canLaunchApplications !== false || phase === 'recovering');
        const next = ready && boxId ? (value.dataIdentity?.profileId ? value.dataContextId || null : value.account?.phase === 'authenticated' ? JSON.stringify([value.account.accountId, value.account.clientId, boxId, value.connection?.gatewayURL]) : null) : null;
        connected = Boolean(next && boxId); boxName = value.connection?.name || "盒子";
        if (next !== context) { generation++; reset(); context = next; if (visible && connected) void load(); }
        else paintStatus();
      },
      modelsChanged() { loaded = false; if (visible && connected) void load(); },
      mount(element) { if (!element) return; if (root !== element) setup(element); if ((!drawer || visible) && connected && !loaded && !loading) void load(); },
      fillSuggestion(text) {
        const input = $('[data-chat-input]');
        if (!input || input.disabled || typeof text !== 'string' || !text.trim()) return false;
        const empty = !draft.trim() && !attachments.length && !reference.trim();
        if (empty) {
          input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        input.focus();
        return empty;
      },
      visible(value) {
        if (visible === value) return;
        visible = value;
        if (drawer) drawerWatchNeedsSync = true;
        if (!visible) {
          clearTimeout(historyTimer); historyRequest++; channelsPanel?.reset();
          modePickerOpen = false; if (root) paintConversationMode();
          if (drawer) for (const dialog of root?.querySelectorAll('dialog[open]') || []) dialog.close();
          else stopWatch();
        } else if (connected && !loaded) void load();
        else {
          void refreshHistoryList();
          if (!drawer && scope && threadId && !legacy) void openThread(threadId, false);
        }
        if (drawer && visible && pendingHandoff) void importHandoff();
        syncDrawerWatch();
      },
      snapshot(){return {scope,conversationId,draft,attachments:attachments.slice(),reference,model:selected,modelMode,context:{space:{enabled:spaceEnabled,selection:spaceSelection},knowledge:{enabled:knowledgeEnabled,warehouses:knowledgeWarehouses}}};},
      newConversation(){return newChat();},
      restoreRecent(){
        if(draft.trim()||attachments.length||active||pending||busy||opening)return;
        recentRequested=true;loaded=false;if(visible&&connected&&!loading)void load();
      },
      showHistory: toggleHistory,
      event(value) {
        if(value.type==='handoff'){pendingHandoff=value;void importHandoff();return;}
        if (value.type === 'invalidated') { generation++; context = null; if (drawer) pendingHandoff = null; reset(); if (visible && connected) void load(); return; }
        if (value.scope !== scope) return;
        if (value.type === 'turn-submitting') { threadId = value.threadId; runModel = value.model; return; }
        if (value.threadId !== threadId || legacy) return;
        if (value.type === 'assistant-event') {
          if (value.event.type === 'turn_status' && submitted && !submitted.ended && !value.event.active) return;
          if (submitted && ['done', 'error', 'hitl_required'].includes(value.event.type)) submitted.ended = true;
          if (submitted && value.event.type === 'error') submitted.failed = true;
          const snapshot = state(); applyFrame(snapshot, value.event);
          messages = snapshot.messages; active = snapshot.active; pending = snapshot.pending; sequence = snapshot.sequence; error = snapshot.error;
          if (value.event.type === 'error' && submitted && !messages.some(m => m.role === 'assistant' && m.status === 'running')) {
            if (!draft) { draft = submitted.draft; $('[data-chat-input]').value = draft; }
            if (!reference) reference = submitted.reference;
            if (attachmentsAvailable && !attachments.length) attachments = submitted.attachments;
          }
          if (value.event.type === 'done' || value.event.type === 'hitl_required') scheduleRefresh(350);
          paintMessages(); paintPending(); paintStatus();
        }
        if (value.type === 'resume-ended') scheduleRefresh(200);
        if (value.type === 'stream-error' && visible) {
          streamRecovery = { attempts: streamRecovery?.attempts || 0, failed: false };
          scheduleStreamRecovery();
        }
      },
    };
  };
  // Old settings routes may still be reached by a saved navigation state. Keep
  // them harmless; model choice now lives in the persistent conversation header.
  window.createDialogueModelSettingsView = () => ({ hostState() {}, visible() {}, mount(element) { if (element) element.innerHTML = '<p class="muted">模型可以在对话输入框底部直接切换。</p>'; } });
})();

// Channel management is intentionally available only in the full assistant.
window.createAssistantChannelsPanel = ({root,call,getScope,getBoxName=()=>'当前盒子',ready,zhijun=false}) => {
  const labels={weixin:'微信',wecom:'企业微信',feishu:'飞书',dingtalk:'钉钉'};
  const hints={weixin:'连接个人微信，随时接着聊',wecom:'企业智能机器人，协作更顺手',feishu:'把对话带入日常工作',dingtalk:'在熟悉的工作台找到对话'};
  const schemas={wecom:[['bot_id','Bot ID'],['secret','Secret',true]],feishu:[['app_id','App ID'],['app_secret','App Secret',true],['encrypt_key','Encrypt Key（选填）',true],['verification_token','Verification Token（选填）',true]],dingtalk:[['client_id','Client ID'],['client_secret','Client Secret',true]]};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=kind=>`<img src="channel-icons/${kind}.svg" alt="" width="28" height="28"/>`;
  const message=e=>['DIALOGUE_ACCESS_DENIED','FORBIDDEN'].includes(e.code)?'当前账号没有通道管理权限，请联系管理员。':e.code==='ASSISTANT_CHANNEL_VERIFICATION_CHANGED'?'验证状态已变化，请重新检查；不会自动确认。':e.code==='ASSISTANT_CHANNEL_DISABLED'?'请先启用连接，再验证本人。':e.code==='ASSISTANT_CHANNEL_INCOMPLETE'?'请填写必填项，已有密钥留空即可保留。':e.code==='ASSISTANT_CHANNEL_EXPIRED'?'二维码已过期或已取消，请重新获取。':e.code==='DIALOGUE_CONTEXT_CHANGED'?'账号或盒子已变化，请重新打开通道设置。':'操作未完成，请检查盒子服务和平台配置后重试。';
  const button=root.querySelector('[data-assistant-channels]');
  const arrow='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
  const channelMark='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M14 6h1a3 3 0 0 1 3 3v2M10 18H9a3 3 0 0 1-3-3v-2"/></svg>';
  root.querySelector('.ai-dialogue').insertAdjacentHTML('beforeend',`<dialog class="ai-channels-dialog" aria-labelledby="ai-channels-title"><header><span class="ai-channels-mark">${channelMark}</span><div><h3 id="ai-channels-title" tabindex="-1" autofocus>${zhijun ? "在手机上用知君" : "通道设置"}</h3><p>${zhijun ? "选择常用的 IM，完成本人验证后，就能和知君私聊。" : "让对话出现在你熟悉的地方。"}</p></div><button type="button" data-channel-action="close" aria-label="关闭通道设置"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header><div class="ai-channels-body"></div><p class="ai-channels-note" role="status" aria-live="polite"></p></dialog>`);
  const dialog=root.querySelector('.ai-channels-dialog'), body=dialog.querySelector('.ai-channels-body'), note=dialog.querySelector('.ai-channels-note');
  let rows=[],kind=null,editing=null,busy=false,ticket=null,timer=null,epoch=0,sessionScope=null,interval=2000;
  const request=(method,input={})=>call(method,{...input,scope:sessionScope});
  const ownerStatus=v=>({active:'本人已验证',awaiting_message:'等待私聊消息',awaiting_confirmation:'待确认本人',expired:'验证已过期',invalid:'需要重新验证',revoked:'验证已撤销'})[v?.status]||'待验证本人';
  const status=row=>({connected:'已连接',disabled:'已停用',error:'连接异常',connecting:'正在连接'})[row.status]||'待连接';
  function verificationMarkup(v={}) {
    const state=v.status||'unverified',active=state==='active',received=state==='awaiting_confirmation',waiting=state==='awaiting_message';
    return `<div class="ai-channel-verification-heading"><div><small>本人通道验证</small><strong>${ownerStatus(v)}</strong></div><span class="ai-channel-verification-step">${active?'已完成':received?'3 / 3':waiting?'2 / 3':'1 / 3'}</span></div>${active?'<p>已确认接收消息的本人身份，可在这个通道继续对话。</p><button type="button" data-channel-action="verify-revoke">撤销本人验证</button>':received?`<p>已收到私聊，请核对后确认，系统不会自动确认。</p><div class="ai-channel-verification-received"><strong>${esc(v.name||'收到私聊')}</strong><span>${esc(v.preview||'请核对是否由本人发送')}</span></div><div class="ai-channel-verification-actions"><button type="button" class="ai-channel-primary" data-channel-action="verify-confirm">确认是本人</button><button type="button" data-channel-action="verify-revoke">不是本人，取消</button></div>`:waiting?`<p>请在 5 分钟内，用本人账号向机器人<strong>私聊随便发一条消息</strong>，例如「你好」。收到后，在这里确认是本人即可。</p><div class="ai-channel-verification-actions"><button type="button" data-channel-action="verify-check">我已发送，检查消息</button><button type="button" data-channel-action="verify-revoke">取消验证</button></div>`:`<p>平台连接已保存。再验证接收消息的本人身份，完成最后一步。</p><button type="button" class="ai-channel-primary" data-channel-action="verify-start">${['expired','invalid','revoked'].includes(state)?'重新验证本人':'开始验证本人'}</button>`}`;
  }
  function paintVerification(){const el=body.querySelector('[data-channel-verification]');if(el&&editing)el.innerHTML=verificationMarkup(editing.channel.verification);}
  async function updateVerification(action,version=epoch){
    if(!editing)return;
    const channelId=editing.channel.id;
    const result=await request(action,{id:channelId});
    if(version!==epoch||editing?.channel.id!==channelId)return;
    editing.channel.verification=result.verification;paintVerification();
    clearTimeout(timer);timer=null;
    if(result.verification.status==='awaiting_message'&&dialog.open)timer=setTimeout(()=>void pollVerification(version),2000);
  }
  async function pollVerification(version){try{await updateVerification('channels-verification',version);}catch(e){if(version===epoch){note.textContent=message(e);timer=null;}}}
  function paint() {
    dialog.dataset.channelView=kind?'detail':'catalog';
    if(kind){
      const name=editing?.channel.name||labels[kind], values=editing?.values||{}, configured=editing?.configured||[];
      body.innerHTML=`<button type="button" class="ai-channel-back" data-channel-action="back">${arrow} 全部通道</button><div class="ai-channel-intro" data-channel-kind="${kind}"><span class="ai-channel-logo">${icon(kind)}</span><div><strong>${labels[kind]}</strong><p>${editing?esc(name):hints[kind]}</p></div>${editing?`<span class="ai-channel-state ${editing.channel.status}">${status(editing.channel)}</span>`:'<span class="ai-channel-detail-label">新建连接</span>'}</div>${editing?'':`<section class="ai-channel-quick" data-channel-kind="${kind}"><div class="ai-channel-qr-frame" data-channel-qr><div class="ai-channel-qr-placeholder" aria-hidden="true"><svg viewBox="0 0 120 120" fill="none"><path d="M32 12H20a8 8 0 0 0-8 8v12m76-20h12a8 8 0 0 1 8 8v12m0 56v12a8 8 0 0 1-8 8H88m-56 0H20a8 8 0 0 1-8-8V88" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M28 28h20v20H28zm44 0h20v20H72zM28 72h20v20H28z" stroke="currentColor" stroke-width="2"/><path d="M62 68h10v10H62zm16 12h14v12H78zM60 90h8m20-30h4" stroke="currentColor" stroke-width="2.5"/></svg><span>点击生成二维码</span></div></div><div class="ai-channel-quick-copy"><strong>扫码连接${labels[kind]}</strong><p>${kind==='feishu'||kind==='dingtalk'?'授权创建应用机器人，手机确认后自动连接。':'用'+labels[kind]+'扫描二维码，确认后即可开始对话。'}</p><button type="button" class="ai-channel-primary" data-channel-action="start">生成连接二维码 ${arrow}</button><small>仅在你确认授权后连接</small></div></section>`}
      ${editing?'<section class="ai-channel-verification" data-channel-verification>'+verificationMarkup(editing.channel.verification)+'</section>':''}
      ${schemas[kind]?`<${editing?'section':'details'} class="ai-channel-manual">${editing?'<h4>连接配置</h4>':`<summary><span>已有机器人？<strong>使用手动配置</strong></span>${arrow}</summary>`}<form data-channel-form><label class="ai-channel-name-field">连接名称<input name="name" maxlength="100" value="${esc(name)}" required autocomplete="off"/></label>${schemas[kind].map(([key,label,secret],i)=>`<label>${label}${i<2?' <span class="ai-channel-required" aria-hidden="true">*</span>':''}<input name="${key}" type="${secret?'password':'text'}" maxlength="4096" value="${esc(values[key]||'')}" placeholder="${configured.includes(key)?'已设置，留空保留':i<2?'请输入 '+label:'选填'}" ${i<2&&!configured.includes(key)?'required':''} autocomplete="off" spellcheck="false"/></label>`).join('')}<div class="ai-channel-form-footer"><p class="ai-channel-help">${editing?'已保存的密钥不回显，留空保留原值。':'请先在对应平台启用应用机器人。'}</p><button type="submit" class="ai-channel-primary">${editing?'保存修改':'保存并连接'}</button></div></form></${editing?'section':'details'}>`:''}
      ${editing?`<div class="ai-channel-management"><button type="button" data-channel-action="test" data-id="${esc(editing.channel.id)}">检查连接</button><button type="button" data-channel-action="toggle" data-id="${esc(editing.channel.id)}">${editing.channel.enabled?'停用连接':'启用连接'}</button><button type="button" class="ai-channel-danger" data-channel-action="delete-ask">移除</button></div><div class="ai-channel-remove" hidden><p>移除后，该机器人将不再接收对话回复。已有对话会保留。</p><button type="button" data-channel-action="delete-cancel">取消</button><button type="button" class="ai-channel-danger" data-channel-action="delete" data-id="${esc(editing.channel.id)}">确认移除</button></div>`:''}`;
    }else{
      const connectedCount=rows.filter(row=>row.status==='connected').length;
      body.innerHTML=`<div class="ai-channels-overview"><span>选择你的常用通道</span><span class="ai-channels-count">${connectedCount?`<i aria-hidden="true"></i>${connectedCount} 个连接已就绪`:'4 种接入方式'}</span></div><div class="ai-channel-catalog">${Object.entries(labels).map(([key,label])=>{const matches=rows.filter(r=>r.kind===key);return `<section class="ai-channel-card" data-channel-kind="${key}"><div class="ai-channel-card-title"><span class="ai-channel-logo">${icon(key)}</span><div><strong>${label}</strong><small>${hints[key]}</small></div></div><div class="ai-channel-bindings">${matches.map(row=>`<button type="button" class="ai-channel-binding" data-channel-action="edit" data-id="${esc(row.id)}"><span class="ai-channel-binding-name">${esc(row.name)}<small>${ownerStatus(row.verification)}</small></span><span class="ai-channel-state ${row.status}">${status(row)}</span>${arrow}</button>`).join('')}</div><button type="button" class="ai-channel-connect" data-channel-action="connect" data-kind="${key}"><span>${matches.length?'添加连接':'连接'+label}</span><span aria-hidden="true">${matches.length?'＋':arrow}</span></button></section>`;}).join('')}</div><footer class="ai-channels-scope"><span class="ai-channels-scope-box">${channelMark}<span>当前账号 · ${esc(getBoxName())}</span></span><span title="网页对话所选的空间与知识库范围不会自动带入通道。">资料范围按对话独立设置</span></footer>`;
    }
  }
  function lock(value){busy=value;dialog.setAttribute('aria-busy',String(value));for(const el of body.querySelectorAll('button,input'))el.disabled=value;}
  async function stop(){clearTimeout(timer);timer=null;const handle=ticket;ticket=null;if(handle)await request('channels-cancel',{handle}).catch(()=>{});}
  function close(){epoch++;void stop();dialog.close();dialog.setAttribute('aria-busy','false');body.replaceChildren();note.textContent='';kind=null;editing=null;busy=false;}
  async function refresh(){const version=epoch;const result=await request('channels-list');if(version!==epoch)return;rows=result.items;paint();}
  async function open(){
    if(!ready()){note.textContent='连接盒子后即可管理通道。';body.replaceChildren();dialog.showModal();return;}
    epoch++;sessionScope=getScope();kind=null;editing=null;note.textContent='正在读取连接…';body.replaceChildren();dialog.showModal();
    try{await refresh();note.textContent='';}catch(e){note.textContent=message(e);body.innerHTML='<button type="button" data-channel-action="retry">重新加载</button>';}
  }
  async function check(version){
    if(version!==epoch||!ticket||!dialog.open)return;
    try{
      const result=await request('channels-poll',{handle:ticket});if(version!==epoch)return;
      if(result.qr)showQR(result.qr);
      if(result.status==='success'){await stop();editing=await request('channels-detail',{id:result.channel.id});if(version!==epoch)return;kind=editing.channel.kind;paint();note.textContent='平台已连接，请完成本人通道验证。';await updateVerification('channels-verify-start',version);return;}
      if(['failed','expired'].includes(result.status)){ticket=null;note.textContent=result.status==='expired'?'二维码已过期，请重新获取。':'平台授权未完成，请重新获取二维码，或使用手动配置。';return;}
      note.textContent='请在手机上扫码并确认授权。';timer=setTimeout(()=>void check(version),interval);
    }catch(e){if(version===epoch){note.textContent=message(e);if(['ASSISTANT_CHANNEL_EXPIRED','DIALOGUE_CONTEXT_CHANGED'].includes(e.code)){ticket=null;return;}timer=setTimeout(()=>void check(version),Math.max(interval,5000));}}
  }
  function showQR(data){const region=body.querySelector('[data-channel-qr]');if(!region)return;region.replaceChildren();const image=document.createElement('img');image.src=data;image.alt='用'+labels[kind]+'扫描二维码';image.width=200;image.height=200;region.append(image);region.classList.add('is-ready');const refresh=body.querySelector('[data-channel-action="start"]');if(refresh)refresh.innerHTML='刷新二维码 '+arrow;}
  button.addEventListener('click',()=>{if(!button.disabled)void open();});
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',async event=>{
    const target=event.target.closest('[data-channel-action]');if(!target)return;const action=target.dataset.channelAction;
    if(action==='close'){close();return;}if(busy)return;
    const version=epoch;
    try{
      if(action==='retry'){await refresh();note.textContent='';return;}
      if(action==='back'||action==='connect'){epoch++;await stop();kind=action==='connect'?target.dataset.kind:null;editing=null;note.textContent='';paint();return;}
      if(action==='delete-ask'){body.querySelector('.ai-channel-remove').hidden=false;return;}
      if(action==='delete-cancel'){body.querySelector('.ai-channel-remove').hidden=true;return;}
      lock(true);
      if(action==='edit'){
        const result=await request('channels-detail',{id:target.dataset.id});if(version!==epoch)return;editing=result;kind=result.channel.kind;note.textContent='';paint();if(result.channel.verification?.status==='awaiting_message')void pollVerification(version);
      }else if(action.startsWith('verify-')){
        await updateVerification(action==='verify-check'?'channels-verification':'channels-'+action,version);if(version===epoch)note.textContent=action==='verify-confirm'?'本人通道验证完成。':action==='verify-revoke'?'本人验证已撤销。':'';
      }else if(action==='start'){
        await stop();note.textContent='正在准备二维码…';const result=await request('channels-start',{kind});if(version!==epoch){if(result.handle)void request('channels-cancel',{handle:result.handle});return;}
        ticket=result.handle;interval=result.interval||2000;if(result.qr)showQR(result.qr);note.textContent=result.qr?'请在手机上扫码并确认授权。':'正在准备平台授权，请稍候…';timer=setTimeout(()=>void check(version),interval);
      }else if(action==='toggle'||action==='delete'){
        await request('channels-'+action,{id:target.dataset.id,...(action==='toggle'?{enabled:!editing.channel.enabled}:{})});if(version!==epoch)return;kind=null;editing=null;await refresh();note.textContent=action==='delete'?'连接已移除。':'连接状态已更新。';
      }else if(action==='test'){
        note.textContent='正在检查连接…';const result=await request('channels-test',{id:target.dataset.id});if(version!==epoch)return;note.textContent=result.valid?'连接配置有效。':'连接检查失败，请检查平台应用状态及凭据。';
      }
    }catch(e){if(version===epoch)note.textContent=message(e);}finally{if(version===epoch)lock(false);}
  });
  dialog.addEventListener('submit',async event=>{
    if(!event.target.matches('[data-channel-form]'))return;event.preventDefault();event.stopPropagation();if(busy)return;
    const version=epoch,form=event.target,data=new FormData(form),values={};for(const [key,value]of data)if(key!=='name')values[key]=value;
    lock(true);note.textContent='正在保存连接…';
    try{const saved=await request('channels-save',{kind,id:editing?.channel.id,name:data.get('name'),values});if(version!==epoch)return;form.reset();editing=await request('channels-detail',{id:saved.channel.id});if(version!==epoch)return;kind=editing.channel.kind;paint();note.textContent='连接已保存，请完成本人通道验证。';await updateVerification('channels-verify-start',version);}catch(e){if(version===epoch)note.textContent=message(e);}finally{if(version===epoch)lock(false);}
  });
  return {reset:close};
};
