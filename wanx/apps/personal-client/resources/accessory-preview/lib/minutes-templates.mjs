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
