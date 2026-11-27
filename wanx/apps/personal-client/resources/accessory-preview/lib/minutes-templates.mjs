import { cleanText, HttpError } from './util.mjs';

export const DEFAULT_TEMPLATE_ID = 'general';
export const TEMPLATE_LIMITS = { name: 40, rules: 2000 };
export const BASE_HEADINGS = { decision: '决定', action: '行动项', pending: '待确认' };

export const BUILTIN_TEMPLATES = [
  {
    id: 'general', name: '智能总结', description: '根据录音内容自动组织',
    rules: '按这段录音的内容组织总结。先交代主要信息，再补充有用的细节。按实际主题分段，保留必要的上下文和明确提到的不确定性。去除口头重复。',
    headings: BASE_HEADINGS,
  },
  {
    id: 'project', name: '要点与跟进', description: '集中整理结论和后续事项',
    rules: '优先记录已经明确的结论、承诺和下一步。按实际主题分段，录音中有明确的负责人、时间或交付物就写出。对仍在讨论的内容写清不确定之处。',
    headings: { decision: '项目决定', action: '交付行动项', pending: '风险与阻塞' },
  },
  {
    id: 'client', name: '访谈与交流', description: '梳理观点、例子和上下文',
    rules: '按实际讨论的主题整理有价值的观点和例子。转述说话者的判断时保留其条件和语气。只有原文明确说出人物身份时才归属观点。',
    headings: { decision: '双方共识', action: '跟进事项', pending: '待确认需求' },
  },
  {
    id: 'standup', name: '站会', description: '快速整理进展、计划和阻塞',
    rules: [
      '按以下栏目整理原话中提到的内容。区分已经完成的工作与后续计划，只在原话明确时记录负责人和时间。',
      '## 昨日进展\n列出已完成事项和仍在进行的工作，保留重要结果。',
      '## 今日计划\n列出接下来准备完成的事项和交付物。',
      '## 阻塞与协助\n写明遇到的阻塞、需要的支持和原话提到的协助人。',
    ].join('\n\n'),
  },
  {
    id: 'retrospective', name: '回顾会议', description: '整理有效做法、问题和改进实验',
    rules: [
      '按以下栏目整理回顾。区分已经观察到的问题、对原因的猜测和已经同意的行动。',
      '## 做得好的地方\n保留有效做法及其具体例子。',
      '## 需要改进的地方\n说明问题与影响，保留有分歧或待验证的原因。',
      '## 下周期行动\n记录已同意的改进或实验；负责人、期限和检验方式仅在原话明确时填写。',
    ].join('\n\n'),
  },
  {
    id: 'customer-call', name: '客户电话', description: '整理客户目标、承诺和后续跟进',
    rules: [
      '按以下栏目整理通话。区分客户明确表达的需求、我方提议和双方已确认的承诺。只有原话明确身份时才归属给具体人员。',
      '## 客户目标与现状\n整理客户期望的结果、当前问题和关键约束。',
      '## 已确认需求\n列出明确的需求、优先级和验收条件。',
      '## 承诺与待确认\n区分已商定的承诺、风险和仍需确认的问题。',
      '## 后续跟进\n记录下一步、明确提到的负责人和时间。',
    ].join('\n\n'),
  },
  {
    id: 'field-notes', name: '现场走访', description: '把走访录音整理成可复查的观察笔记',
    rules: [
      '按以下栏目整理走访记录。区分现场观察、他人陈述和录音者自己的判断。地点、人名、数量仅采用原话明确提到的信息。',
      '## 走访背景\n记录明确提到的对象、目的和现场条件。',
      '## 现场发现\n按主题整理观察、反馈和具体例子。',
      '## 待核实与跟进\n列出证据不足的判断、未回答的问题和已约定的后续事项。',
    ].join('\n\n'),
  },
  {
    id: 'training', name: '课程与培训', description: '把长录音整理成便于复习的笔记',
    rules: [
      '按以下栏目整理课程。按讲解顺序归纳，不补入录音中未提到的知识、步骤或资料。',
      '## 主题与核心概念\n整理讲解主题及术语的含义。',
      '## 方法、步骤与例子\n保留讲解中给出的操作顺序、适用条件和例子。',
      '## 练习与复习要点\n列出明确布置的练习、推荐的资料和适合复查的关键内容。',
    ].join('\n\n'),
  },
].map((t) => ({ ...t, revision: 2, builtin: true }));

export function findTemplate(settings, id = settings.defaultTemplateId || DEFAULT_TEMPLATE_ID) {
  return BUILTIN_TEMPLATES.find((t) => t.id === id) || (settings.minutesTemplates || []).find((t) => t.id === id);
}

export function templateSnapshot({ id, name, rules, headings, revision }) {
  return { id, name, rules, headings, revision };
}

export function validateTemplate(body) {
  const check = (v, limit, label, multiline = false) => {
    const s = typeof v === 'string' ? cleanText(v, limit + 1, { multiline }) : '';
    if (!s || s.length > limit) throw new HttpError(400, `${label}需要填写，最多 ${limit} 字`);
    return s;
  };
  return {
    name: check(body.name, TEMPLATE_LIMITS.name, '模板名称'),
    rules: check(body.rules, TEMPLATE_LIMITS.rules, '生成规则', true),
  };
}

export function validateInstruction(value) {
  const text = typeof value === 'string' ? cleanText(value, TEMPLATE_LIMITS.rules + 1, { multiline: true }) : '';
  if (!text || text.length > TEMPLATE_LIMITS.rules) throw new HttpError(400, '请填写总结要求，最多 2000 字');
  return text;
}
