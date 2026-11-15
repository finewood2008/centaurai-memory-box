// Keep presentation classification aligned with the server's publication gate.
export function issueCategory(issue) {
  if (issue.severity === 'error') return 'error';
  if (issue.severity === 'info') return 'info';
  return issue.reviewed === true ? 'reviewed' : 'warning';
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
