const fail = code => Object.assign(new Error(code), { code });
const resourceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}

export async function installInitialOntology({ record, save, request, readWarehouse }) {
  const { warehouse, ontology } = record;
  const target = JSON.stringify(normalize(ontology.schema));
  const matches = row => row?.name === ontology.name && JSON.stringify(normalize(row.schema)) === target;
  const versions = async () => {
    const reply = await request('/api/ontologies');
    if (!Array.isArray(reply?.items)) throw fail('SEMANTICA_INVALID_RESPONSE');
    return reply.items;
  };
  let rows = await versions();
  const current = rows.find(row => row?.status === 'published');
  if (matches(current) || (record.ontologyDraftId && rows.some(row => row?.id === record.ontologyDraftId &&
      row.status === 'superseded' && matches(row)))) return;

  const { id, state, document_count } = await readWarehouse();
  if (id !== warehouse.id || state !== 'active' || document_count !== 0)
    throw fail('WAREHOUSE_INITIAL_ONTOLOGY_CHANGED');
  if (!Object.hasOwn(record, 'baseOntologyId')) {
    if (warehouse.current_ontology?.id && warehouse.current_ontology.id !== current?.id)
      throw fail('WAREHOUSE_INITIAL_ONTOLOGY_CHANGED');
    if (rows.length > 1 || (rows.length === 1 &&
        (!resourceId(current?.id) || current.version_number !== 1)))
      throw fail('WAREHOUSE_INITIAL_ONTOLOGY_CHANGED');
    record.baseOntologyId = current?.id ?? null;
    save();
  }
  const expectedBase = record.baseOntologyId;
  const assertBase = (items, draftId) => {
    const active = items.find(row => row?.status === 'published');
    if ((active?.id ?? null) !== expectedBase ||
        items.some(row => row?.id !== expectedBase && row?.id !== draftId))
      throw fail('WAREHOUSE_INITIAL_ONTOLOGY_CHANGED');
  };
  let draft = rows.find(row => row?.id === record.ontologyDraftId);
  const op = record.input.operationId;
  if (!draft) {
    // The server replays the immutable operation receipt after a lost response.
    const possibleDraft = rows.find(row => row?.status === 'draft' && matches(row));
    assertBase(rows, possibleDraft?.id);
    draft = await request('/api/ontologies', 'POST', { name: ontology.name, schema: ontology.schema }, op + '-rules');
    if (!resourceId(draft?.id) || draft.status !== 'draft' || !matches(draft) ||
        (possibleDraft && draft.id !== possibleDraft.id))
      throw fail('SEMANTICA_INVALID_RESPONSE');
    record.ontologyDraftId = draft.id;
    save();
  }
  if (draft.status !== 'draft' || !matches(draft)) throw fail('WAREHOUSE_INITIAL_ONTOLOGY_CHANGED');
  rows = await versions();
  if (rows.some(row => row?.id === draft.id && ['published', 'superseded'].includes(row.status) && matches(row)))
    return;
  assertBase(rows, draft.id);
  if (!rows.some(row => row?.id === draft.id && row.status === 'draft' && matches(row)))
    throw fail('WAREHOUSE_INITIAL_ONTOLOGY_CHANGED');
  const published = await request('/api/ontologies/' + draft.id + '/publish', 'POST', {}, op + '-publish');
  if (published?.id !== draft.id || published.status !== 'published' || !matches(published))
    throw fail('SEMANTICA_INVALID_RESPONSE');
}
