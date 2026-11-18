import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {startVisiblePolling} from '../src/polling.ts';
import {readDocumentLibrary} from '../src/documentLibrary.ts';

const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const end = source.indexOf('  const loadDetail = useCallback(');
const start = source.lastIndexOf('  const report = useCallback(', end);
assert(start >= 0 && end > start);
const effectSource = stripTypeScriptTypes(source.slice(start, end));
const ownerExpression = source.match(/const nativeOwner = ([^;]+);/)[1];
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

function harness({jobs=Promise.resolve(),status=Promise.resolve({})}={}) {
  const state = {error:null,pollError:null,errorWrites:0,pollWrites:0};
  const effects=[],scheduled=new Map(),cleanups=[];
  let next=0,readJobs=()=>jobs;
  const context = vm.createContext({Error, Promise, effects,
    useCallback:fn=>fn,useEffect:fn=>effects.push(fn),
    setError:value=>{state.error=value;state.errorWrites++;},
    setPollError:value=>{state.pollError=value;state.pollWrites++;},
    setMessage() {},setStatus() {},setDocuments() {},setSelectedId() {},setDetail() {},
    jobPage:1,jobPageSize:10,jobActivityRef:{current:null},workspaceId:'default',
    documentListRequest:{current:0},materialSelection:{current:{id:null}},
    materialLeaveState:{current:{dirty:false,busy:false}},detailRequest:{current:0},
    readDocumentLibrary,
    requestJson:url=>url==='/api/settings/status'?status:Promise.resolve({items:[],total:0}),
    refreshJobs:()=>readJobs(),taskPollDelay:()=>15000,
    startVisiblePolling:options=>startVisiblePolling({...options,
      visibility:{hidden:false,addEventListener(){},removeEventListener(){}},
      timers:{setTimeout:fn=>{scheduled.set(++next,fn);return next;},clearTimeout:id=>scheduled.delete(id)},
    }),
  });
  const api = vm.runInContext(`${effectSource}\n({report})`,context);
  for(const effect of effects)cleanups.push(effect());
  return {state,report:api.report,
    recover(){readJobs=()=>Promise.resolve();},
    async tick(){assert(scheduled.size>0);const [id,fn]=scheduled.entries().next().value;scheduled.delete(id);fn();await settle();},
    stop(){for(const cleanup of cleanups)if(typeof cleanup==='function')cleanup();},
  };
}

test('a recovered startup jobs read clears its polling error instead of leaving a global operation error',async()=>{
  const first=deferred();const h=harness({jobs:first.promise});
  first.reject(new Error('synthetic jobs outage'));await settle();
  h.recover();await h.tick();
  assert.equal(h.state.pollError,null);
  assert.equal(h.state.error,null);
  h.stop();
});

test('a permanently failing jobs read stays visible after repeated polls',async()=>{
  const first=deferred();const h=harness({jobs:first.promise});
  first.reject(new Error('synthetic jobs outage'));await settle();await h.tick();
  assert.equal(h.state.pollError,'synthetic jobs outage');
  h.stop();
});

test('successful jobs polling cannot clear a separate status error',async()=>{
  const status=deferred();const h=harness({status:status.promise});
  status.reject(new Error('synthetic status failure'));await settle();await h.tick();
  assert.equal(h.state.error,'synthetic status failure');
  h.stop();
});

test('successful jobs polling cannot clear an unconfirmed ontology mutation error',async()=>{
  const h=harness();await settle();h.report('synthetic mutation result requires review',true);
  await h.tick();assert.equal(h.state.error,'synthetic mutation result requires review');
  h.stop();
});

test('unmounted startup reads do not publish a late error into a replacement view',async()=>{
  const old=deferred();const before=harness({jobs:old.promise});await settle();before.stop();
  const after=harness();await settle();after.report('new warehouse mutation needs review',true);
  const errorWrites=before.state.errorWrites,pollWrites=before.state.pollWrites;
  old.reject(new Error('old warehouse jobs failure'));await settle();
  assert.equal(before.state.errorWrites,errorWrites);
  assert.equal(before.state.pollWrites,pollWrites);
  assert.equal(after.state.error,'new warehouse mutation needs review');
  after.stop();
});

test('explicit narrow-mode false suppresses legacy owner features while missing fields retain compatibility',()=>{
  const evaluate=status=>vm.runInNewContext(ownerExpression,{status});
  assert.equal(evaluate({native_owner_management:false,integration_mode:'standalone',local_data_gate_mode:'legacy'}),false);
  assert.equal(evaluate({integration_mode:'standalone',local_data_gate_mode:'legacy'}),true);
  assert.equal(evaluate({native_owner_management:true,integration_mode:'managed',local_data_gate_mode:'required'}),true);
  assert.equal(evaluate({integration_mode:'managed',local_data_gate_mode:'required'}),false);
});
