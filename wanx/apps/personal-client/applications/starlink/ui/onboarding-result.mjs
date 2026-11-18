// Public candidate DTO only. Rendering these records never adopts or publishes them.
export function proposalView(proposal) {
  const valid = proposal?.status === 'succeeded' && proposal.valid === true;
  if (!valid) return {valid:false, empty:false, suggestions:[], summaries:[], rejected:0, outcome:null, questions:[], explanation:'', canAdopt:false};
  const result = proposal.result || {};
  const schema = result.proposed_schema || result.schema || result;
  const source = Array.isArray(result.suggestions) ? result.suggestions
    : Array.isArray(result.proposals) ? result.proposals
      : Array.isArray(schema.entity_types) ? schema.entity_types.map(item => ({kind:'entity', ...item})) : [];
  const text = value => typeof value === 'string' ? value : '';
  const suggestions = source.filter(item => item && ['entity','relation','property'].includes(item.kind)).map(item => ({
    kind:item.kind, name:text(item.name), label:text(item.label) || text(item.name),
    definition:text(item.definition), reason:text(item.reason), quote:text(item.evidence?.quote),
    owner_kind:text(item.owner_kind),owner_name:text(item.owner_name),
    source_types:(Array.isArray(item.source_types)?item.source_types:[]).filter(v=>typeof v==='string'),
    target_types:(Array.isArray(item.target_types)?item.target_types:[]).filter(v=>typeof v==='string'),
    properties:(Array.isArray(item.properties)?item.properties:[]).filter(p=>p&&typeof p.name==='string').map(p=>({name:p.name,label:text(p.label)||p.name})),
    reuseOnly:item.allow_new_type === false,
  }));
  const summaries = (Array.isArray(result.summary) ? result.summary : []).filter(item => item && typeof item.text === 'string')
    .map(item => ({text:item.text, quote:text(item.evidence?.quote) || text(item.quote)}));
  const questions=(Array.isArray(result.questions)?result.questions:[]).filter(q=>typeof q==='string'&&q.trim());
  const explanation=text(result.explanation).trim();
  // Missing outcome is an old receipt. Questions always take precedence over candidates.
  const outcome=result.outcome ?? (questions.length?'needs_clarification':suggestions.length?'ready':null);
  const consistent=outcome==='ready' ? suggestions.length>0&&!questions.length
    : outcome==='needs_clarification' ? questions.length>0
      : outcome==='no_changes' ? !!explanation&&!suggestions.length&&!questions.length : false;
  return {valid:consistent, empty:suggestions.length===0, suggestions, summaries, outcome, questions, explanation,
    // Eligibility for explicit human review, never automatic adoption/publication.
    canAdopt:consistent&&suggestions.length>0&&(!Object.hasOwn(proposal,'can_review')||proposal.can_review===true),
    rejected:Number.isSafeInteger(result.rejected_count) && result.rejected_count>=0 ? result.rejected_count : 0};
}
