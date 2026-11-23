import test from 'node:test';
import assert from 'node:assert/strict';
import {firstSourceEdge, readStarlinkSetup, saveStarlinkSetup, setupMaterial} from '../ui/starlink-setup.mjs';
import {identity} from './fixtures/onboarding-dialogue.mjs';

test('first-graph progress is explicit and isolated by box, account and warehouse', () => {
  const entries=new Map();
  const storage={setItem:(key,value)=>entries.set(key,value),getItem:key=>entries.get(key),removeItem:key=>entries.delete(key)};
  saveStarlinkSetup(storage, identity, 'new', {goal:'追溯结论'});
  assert.equal(readStarlinkSetup(storage, identity, 'new').goal, '追溯结论');
  for (const scope of [{...identity,accountId:'other'}, {...identity,boxId:'other'}, {...identity,dataScope:'team'}])
    assert.equal(readStarlinkSetup(storage, scope, 'new'), null);
  assert.equal(readStarlinkSetup(storage, identity, 'existing-empty'), null);
  saveStarlinkSetup(storage, identity, 'new', null);
  assert.equal(readStarlinkSetup(storage, identity, 'new'), null);
});

test('the first graph requires an effective publication and evidence on the matching document version', () => {
  const detail = {document_id:'doc',document_version_id:'version',outcome:{current_run_id:'run',
    publication:{status:'succeeded',run_status:'published',effective:false,run_id:'run'}}};
  const flow = {state:{detail}};
  assert.equal(setupMaterial(flow), null);
  detail.outcome.publication.effective = true;
  const eligible={id:'edge',evidence:[{document_id:'doc',document_version_id:'version',segment_id:'source'}]};
  const edges=[
    {id:'previous-version',evidence:[{...eligible.evidence[0],document_version_id:'older'}]},
    {id:'different-document',evidence:[{...eligible.evidence[0],document_id:'other'}]},
    {id:'no-location',evidence:[{...eligible.evidence[0],segment_id:null}]},
  ];
  const hasCitation=source=>!!source.segment_id;
  assert.equal(firstSourceEdge(edges,setupMaterial(flow),hasCitation),null);
  assert.equal(firstSourceEdge([...edges,eligible],setupMaterial(flow),hasCitation),eligible);
});
