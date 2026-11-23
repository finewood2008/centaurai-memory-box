// Only main-owned requests may omit the gateway's synthetic browser Origin.
// These are transport exceptions; Bridge still validates identity, scope/body.
const warehouse = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const id = '[A-Za-z0-9_-]{1,128}';
const prefix = '/api/semantica';
const modeling = [
  ['GET', '/modeling/(?:onboarding|warehouses)'],
  ['POST', '/modeling/onboarding'],
  ['POST', `/modeling/onboarding/${id}/warehouse`],
  ['GET', `/warehouses/${warehouse}/modeling/suggestion-context`],
  ['POST', `/warehouses/${warehouse}/modeling/(?:answer-confirmations|answer-suggestions|rule-previews|warehouse-scope/publish|assistant-intent)`],
  ['GET', `/warehouses/${warehouse}/modeling/answer-suggestions/${id}(?:/rules)?`],
  ['POST', `/warehouses/${warehouse}/modeling/rule-previews/${id}/publish`],
].map(([method, route]) => [method, new RegExp(`^${prefix}${route}$`)]);
const workbench = new RegExp(`^${prefix}/warehouses/${warehouse}/workbench/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$`);

export function isStarlinkNativeRequest(method, path) {
  const pathname = path.split('?')[0];
  return ['GET', 'POST', 'PUT', 'PATCH'].includes(method) && workbench.test(pathname) ||
    modeling.some(([verb, route]) => method === verb && route.test(pathname));
}
