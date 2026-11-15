import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNotificationCenter } from '../shell/notification-center.mjs';
import { collectStarlinkNotifications } from '../shell/starlink-notifications.mjs';

const wid = '11111111-1111-1111-1111-111111111111';
const response = value => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });
function fixture() {
  const paths = [];
  let state = { phase: 'ready', account: { phase: 'authenticated', accountId: 'a', clientId: 'c' }, connection: { deviceId: 'box', name: 'Box', gatewayURL: 'https://box.test' } };
  let change;
  const client = {
    snapshot: () => state,
    subscribe: fn => { change = fn; return () => {}; },
    applicationStream: async () => Object.assign(new EventEmitter(), { terminate() {}, readyState: 1, send() {} }),
    async applicationRequest(input) {
      paths.push(input);
      if (input.path === '/api/loops') return { status: 404 };
      if (input.path.endsWith('/warehouses')) return response({ items: [{ id: wid, state: 'active' }] });
      if (input.path.includes('/processing?')) return response({ effective: { mode: 'auto', signature: 'same-config', blocked_reason: 'MODEL_DEFAULT_UNAVAILABLE', extraction: { available: false } } });
      return response({feed_id:'fixture', items: input.path.includes('after=0') ? [{sequence:1, job_id:'failed-job',kind:'sensitive_scan',failed_at:new Date().toISOString()}] : [], next_cursor:1,has_more:false});
    },
  };
  return { client, paths, logout() { state = { phase: 'idle' }; change(); } };
}

test('model and job failures reach the existing notification center and deduplicate across polling', async () => {
  const f = fixture();
  const center = await createNotificationCenter({ client: f.client, serviceURL: 'https://account.test', store: { load: async () => null, save: async () => {} } });
  try {
    await center.refresh();
    const first = center.snapshot();
    assert.equal(first.items.length, 2);
    assert(first.items.some(i => i.title === '星图默认模型不可用'));
    assert(first.items.every(i => i.applicationId === 'centaurai.wanx.semantica'));
    assert(!JSON.stringify(first).includes('private document'));
    await center.markRead({ all: true });
    await center.refresh();
    assert.equal(center.snapshot().items.length, 2);
    assert.equal(center.snapshot().unreadCount, 0);
    assert(f.paths.filter(p => p.path.startsWith('/api/semantica')).every(p => p.headers['x-wanx-data-context'] === 'personal'));
    f.logout();
    assert.equal(center.snapshot().items.length, 0);
  } finally { await center.close(); }
});

test('a late response after account or box switch cannot create a notification', async () => {
  let current = true;
  const notices = [];
  await collectStarlinkNotifications({ dataScope: 'team', isCurrent: () => current, collect: i => notices.push(i), deviceId: 'box', deviceName: 'Box',
    request: async input => {
      assert.equal(input.headers['x-wanx-data-context'], 'team');
      current = false;
      return response({ items: [{ id: wid, state: 'active' }] });
    } });
  assert.deepEqual(notices, []);
});

test('healthy models and cancelled jobs do not create failure notifications', async () => {
  const notices = [];
  await collectStarlinkNotifications({ dataScope: 'personal', isCurrent: () => true, collect: i => notices.push(i), deviceId: 'box', deviceName: 'Box',
    request: async ({ path }) => path.endsWith('/warehouses') ? response({ items: [{ id: wid, state: 'active' }] })
      : path.includes('/processing?') ? response({ effective: { extraction: { available: true }, sensitive: { available: true } } })
      : response({feed_id:'fixture',items:[],next_cursor:0,has_more:false}),
  });
  assert.deepEqual(notices, []);
});


test('durable backlog resumes after restart, includes ontology, deduplicates job retries', async () => {
  let disk = null;
  const events = Array.from({length:650},(_,n)=>({sequence:n+1,job_id:'job-'+n,kind:n===620?'ontology_suggest':'knowledge_extract',failed_at:new Date().toISOString()}));
  const f=fixture();
  f.client.applicationRequest=async input=>{
    if(input.path==='/api/loops')return {status:404};
    if(input.path.endsWith('/warehouses'))return response({items:[{id:wid,state:'active'}]});
    if(input.path.includes('/processing?'))return response({effective:{extraction:{available:true},sensitive:{available:true}}});
    const after=Number(new URL(input.path,'http://fixture').searchParams.get('after'));
    const page=events.filter(e=>e.sequence>after).slice(0,100);
    return response({feed_id:'fixture',items:page,next_cursor:page.at(-1)?.sequence||after,has_more:after+page.length<events.length});
  };
  const options={client:f.client,serviceURL:'https://account.test',store:{load:async()=>structuredClone(disk),save:async v=>{disk=structuredClone(v);}}};
  let center=await createNotificationCenter(options);
  await center.refresh(); await center.close();
  const key=Object.keys(disk.accounts)[0];
  assert.equal(Object.values(disk.accounts[key].starlink)[0].warehouses[wid].cursor,500);
  center=await createNotificationCenter(options);
  await center.refresh();
  assert.equal(Object.values(disk.accounts[key].starlink)[0].warehouses[wid].cursor,650);
  assert(center.snapshot().items.some(x=>x.title==='星图本体建议失败'));
  assert.equal(center.snapshot().items.length,500); // existing notification-center display retention
  await center.markRead({all:true});
  events.push({...events[649],sequence:651});
  await center.refresh(); assert.equal(center.snapshot().unreadCount,0);
  await center.close();
});

test('outage persists once, recovery permits another incident, no raw error leaks', async()=>{
  let state={},broken=true,notices=[];
  const options={dataScope:'team',deviceId:'box',deviceName:'Box',isCurrent:()=>true,collect:v=>notices.push(v),save:async v=>{state=structuredClone(v)},
    request:async()=>{if(broken)throw new Error('private-key material');return response({items:[]});}};
  await collectStarlinkNotifications({...options,state}); await collectStarlinkNotifications({...options,state});
  assert.equal(notices.length,1); assert(!JSON.stringify(notices).includes('private-key'));
  broken=false; await collectStarlinkNotifications({...options,state});
  broken=true; await collectStarlinkNotifications({...options,state}); assert.equal(notices.length,2);
});

test('permission denial never reports a service failure or advances a cursor',async()=>{
  let saved=false;const notices=[];
  await collectStarlinkNotifications({dataScope:'personal',deviceId:'box',isCurrent:()=>true,collect:x=>notices.push(x),save:async()=>{saved=true},request:async()=>({status:403})});
  assert.equal(saved,false);assert.deepEqual(notices,[]);
});

test('replaced failure feed restarts replay instead of losing events below the old cursor',async()=>{
  let state={warehouses:{[wid]:{feedId:'old',cursor:999}}};const cursors=[],notices=[];
  await collectStarlinkNotifications({state,dataScope:'team',deviceId:'box',isCurrent:()=>true,collect:x=>notices.push(x),save:async x=>{state=x},
    request:async({path})=>{
      if(path.endsWith('/warehouses'))return response({items:[{id:wid,state:'active'}]});
      if(path.includes('/processing?'))return response({effective:{extraction:{available:true},sensitive:{available:true}}});
      const after=Number(new URL(path,'http://fixture').searchParams.get('after'));cursors.push(after);
      return response({feed_id:'new',items:after?[]:[{sequence:1,job_id:'new-job',kind:'ontology_suggest',failed_at:new Date().toISOString()}],next_cursor:1,has_more:false});
    }});
  assert.deepEqual(cursors,[999,0]);assert.equal(notices.length,1);assert.equal(state.warehouses[wid].cursor,1);
});


test('repeated request failures are bounded per warehouse and hour',async()=>{
  const f=fixture();const stamp=new Date().toISOString();
  f.client.applicationRequest=async({path})=>path==='/api/loops'?{status:404}:path.endsWith('/warehouses')?response({items:[{id:wid,state:'active'}]}):path.includes('/processing?')?response({effective:{extraction:{available:true}}}):response({feed_id:'requests',items:[1,2].map(n=>({sequence:n,job_id:'request-'+n,kind:'search_request',failed_at:stamp})),next_cursor:2,has_more:false});
  const center=await createNotificationCenter({client:f.client,serviceURL:'https://test',store:{load:async()=>null,save:async()=>{}}});
  try{await center.refresh();assert.equal(center.snapshot().items.length,1);assert.equal(center.snapshot().items[0].title,'星图检索暂时不可用');}finally{await center.close();}
});
