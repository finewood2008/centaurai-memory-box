// Keep presentation classification aligned with the server's publication gate.
export function issueCategory(issue) {
  if (issue.severity === 'error') return 'error';
  if (issue.severity === 'info') return 'info';
  return issue.reviewed === true ? 'reviewed' : 'warning';
}

export function publicationIssueAdvice(issue){
  if(!['error','warning'].includes(issueCategory(issue)))return null;
  const message=String(issue.message||'');
  const propertyIssue=typeof issue.property_name==='string'&&issue.property_name.trim().length>0||/(?:^|_)PROPERTY(?:_|$)/.test(String(issue.code||''));
  if(propertyIssue)return '核对提示指向的属性，仅修正或移除没有依据的属性。材料未提及的值可以留空，不需要补造，也不必删除整条事实。保存到草稿后重新校验，不能用核对说明放行阻塞错误。';
  if(/计划|否定|疑问/.test(message))return '核对原文是否描述已成立的事实。若只是计划、否定或疑问，应排除这条关系；若原文确实支持保留，请引用原句并填写核对说明。';
  if(/方向|先后|依赖|影响依据/.test(message))return '核对原文明确指出的起点、终点和方向，不从出现顺序推断。没有明确方向依据时可排除关系；有依据时说明对应原句如何支持该方向。';
  if(/关系.*(?:缺少|缺乏|不足|没有|不支持).*(?:证据|依据|行为|属性)|关系.*(?:证据|依据).*(?:不足|不充分|不支持)/.test(message))return '查看关系和原文；如有依据，可在编辑器中调整来源引用并填写核对说明；如原文不支持，应排除关系。保存后重新校验，再确认发布。核对说明不能替代来源证据，也不能放行阻塞错误。';
  if(/端点|类型|约束/.test(message))return '对照原文检查实体类型及关系两端是否符合本体定义。只修正有依据的分类；规则不适用时另行调整规则，不能用核对说明放行阻塞错误。';
  return '先查看事实及其原文依据。有依据的内容可修正并说明；缺少依据的事实可排除。保存到草稿后重新校验，再确认发布。';
}

export function groupPublicationIssues(issues = []) {
  const categories = {error: [], warning: [], reviewed: [], info: []};
  for (const category of Object.keys(categories)) {
    const groups = new Map();
    for (const issue of issues) {
      if (issueCategory(issue) !== category) continue;
      const id = issue.item_id || '';
      if (!groups.has(id)) groups.set(id, {itemId: id, issues: [], count: 0});
      const group = groups.get(id);
      group.count++;
      if (!group.issues.some(i => i.code === issue.code && i.message === issue.message && i.property_name === issue.property_name)) group.issues.push(issue);
    }
    categories[category] = [...groups.values()];
  }
  return categories;
}
