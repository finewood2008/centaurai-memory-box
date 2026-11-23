// The existing message endpoint has no stage field. Carry the current task
// context with the message; keep the user's original words in chat bubbles.
const prefix='【材料目标澄清】\n当前处于抽取前的目标澄清阶段。用户可能补充整理目的、关注点、排除范围，也可能提问；请按实际语义回答。普通目标说明不要误判为修改实体或本体。只有明确要求修改已有实体、类型规则或重抽已处理材料时，才按修改请求处理。目标明确时，请用 goal_summary 汇总完整目标与关注、排除范围，仍待用户确认。如果用户说“下一步”，先根据已有对话整理待确认目标；信息不足时只追问缺失内容，不要求用户重新填写表单。不执行抽取或发布。\n用户本轮输入：\n';
export const goalDialogueContent=text=>prefix+text;
export const goalDialogueText=text=>typeof text==='string'&&text.startsWith(prefix)?text.slice(prefix.length):text;
