import test from 'node:test';
import assert from 'node:assert/strict';
import {stepForces,createGraphMotion} from '../ui/graph-motion.mjs';

const node=(id,x,y,z)=>({id,name:id,x,y,z,homeX:x,homeY:y,homeZ:z,r:20,labelWidth:80});

test('independent graph controllers only reset the zoom output of their own canvas',()=>{
  const first={textContent:'160%'},second={textContent:'240%'};
  const canvas=output=>({parentElement:{querySelector:()=>output}});
  const a=createGraphMotion({getSvg:()=>canvas(first)}),b=createGraphMotion({getSvg:()=>canvas(second)});
  a.reset();assert.equal(first.textContent,'100%');assert.equal(second.textContent,'240%');
  b.reset();assert.equal(second.textContent,'100%');
});

test('the live zoom readout resets when React has already removed an empty canvas',()=>{
  const output={textContent:'240%'};
  const motion=createGraphMotion({getSvg:()=>null,getZoomOutput:()=>output});
  motion.reset();assert.equal(output.textContent,'100%');
});

test('spatial motion holds the dragged node and preserves knowledge and evidence',()=>{
  const nodes=[node('a',0,0,-50),node('b',400,100,100)];
  const edges=[{id:'relation',s:'a',t:'b',label:'采用',evidence:[{document_id:'doc',excerpt:'原文依据'}]}];
  const before=structuredClone(edges),held=structuredClone(nodes[0]);
  for(let i=0;i<200;i++)stepForces(nodes,edges,'a',.5);
  assert.deepEqual(edges,before);
  for(const axis of ['x','y','z'])assert.equal(nodes[0][axis],held[axis]);
  assert.ok(nodes[1].x<400);
  assert.ok(nodes[1].z<100);
  assert.ok(nodes.every(n=>[n.x,n.y,n.z].every(Number.isFinite)));
  assert.deepEqual(nodes.map(n=>[n.id,n.name]),[['a','a'],['b','b']]);
});

test('overlapping, isolated and self-referencing spatial nodes remain finite',()=>{
  const nodes=[node('a',0,0,0),node('b',0,0,0),node('isolated',300,0,40)];
  const edges=[{s:'a',t:'b'},{s:'a',t:'a'},{s:'absent',t:'b'}];
  for(let i=0;i<180;i++)stepForces(nodes,edges);
  assert.ok(nodes.every(n=>[n.x,n.y,n.z,n.vx,n.vy,n.vz].every(Number.isFinite)));
  assert.notDeepEqual([nodes[0].x,nodes[0].y],[nodes[1].x,nodes[1].y]);
  assert.doesNotThrow(()=>stepForces([],edges));
});
