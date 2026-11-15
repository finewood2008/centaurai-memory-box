export function createGraphComposition(getContext) {
  let input=null,context=null;
  const current=()=>Boolean(input?.isConnected && context===getContext());
  return {
    start(target) {
      const form=target?.closest?.('[data-data-form]');
      if (!['search','graph-search'].includes(form?.dataset.dataForm) || form.dataset.dataContext!==getContext()) return;
      input=target;context=getContext();
    },
    active:current,
    end(target) {
      if(target!==input)return null;
      const result=current()?{name:input.name,value:input.value}:null;
      input=null;context=null;return result;
    },
  };
}

// Keep the actual editing node across shell updates, but never across data scopes.
export function retainGraphInput(root, document) {
  const input = document.activeElement;
  const form = input?.closest?.('[data-data-form]');
  const kind = form?.dataset.dataForm;
  const name = kind === 'search' ? 'query' : kind === 'graph-search' ? 'graphQuery' : null;
  const context = form?.dataset.dataContext;
  if (!name || input.name !== name || !context || !root?.contains?.(input)) return () => {};
  const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection;
  return () => {
    const next = root.querySelector(`[data-data-form="${kind}"] input[name="${name}"]`);
    if (!next || next.closest('[data-data-form]')?.dataset.dataContext !== context) return;
    next.replaceWith(input);
    input.focus({preventScroll:true});
    if (start !== null && end !== null) input.setSelectionRange(start,end,direction);
  };
}
