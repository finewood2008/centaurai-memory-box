const warehouseId='10000000-0000-4000-8000-000000000001';
const common={warehouseId,conversationId:'conversation'};
const intent={...common,intentId:'intent'};
const turn={...common,turnId:'turn'};
const op={operationId:'operation'};
const rev={...op,revision:1};
const editor={session:'s'.repeat(30),generation:'1'};
const digest='a'.repeat(64);
export const conversationCases=[
  ['job',{warehouseId,jobId:'job'}],['job-retry',{warehouseId,jobId:'job',...op}],
  ['change-discard',{warehouseId,documentId:'doc',draftId:'draft',...rev,editor,confirmed:true}],
  ['material-workflows',{warehouseId,offset:0,limit:50}],['material-workflow',{warehouseId,documentId:'doc'}],
  ['source-confirm',{warehouseId,documentId:'doc',documentVersionId:'version',...op,confirmed:true}],
  ['index-retry',{warehouseId,documentId:'doc',documentVersionId:'version',confirmationId:'confirmation',...op}],
  ['ontologies',{warehouseId}],['published-run',{warehouseId,runId:'run'}],
  ['list',{warehouseId,offset:0,limit:20}],['create',{warehouseId,...op}],['get',common],
  ['messages',{...common,afterSequence:0,limit:50}],['send',{...common,...rev,content:'整理患者材料'}],
  ['turns',{...common,offset:0,limit:20}],['turn',turn],['turn-cancel',{...turn,...rev}],['turn-retry',{...turn,...rev}],
  ['intents',{...common,offset:0,limit:20}],['intent-create',{...common,...rev,documentId:'doc'}],['intent',intent],
  ['analyze',{...intent,...op,documentVersionId:'version'}],
  ['goal',{...intent,...rev,conversationRevision:2,goal:'患者记录',instructions:'正文依据',confirmed:true}],
  ['plan',intent],['confirm',{...intent,...rev,conversationRevision:2,planDigest:digest,confirmed:true}],
  ['cancel',{...intent,...rev}],['retry',{...intent,...rev}],['candidates',{...intent,offset:0,limit:20}],
  ['review-plan',{...intent,...op,editor,offset:0,limit:20}],
  ['review',{...intent,...rev,editor,planDigest:digest,draftId:null,confirmed:true,deferredPolicy:'keep_existing'}],
  ['editor-session',{warehouseId,documentId:'doc',...op}],['editor-leases',{warehouseId,documentId:'doc',...op,editor}],
  ['editor-claim',{warehouseId,documentId:'doc',draftId:'draft',...rev,editor}],
  ['editor-release',{warehouseId,documentId:'doc',draftId:'draft',...rev,editor}],
  ['change-context',{...intent,...op}],
  ['change-context',{...intent,...op,draftId:'draft',selectedItemIds:['fact'],proposalOffset:10,editor}],
  ['change-generate',{...intent,...op,contextDigest:digest,instruction:'修改类型定义',ontologyDraftId:'rules',selectedItemIds:[]}],
  ['change-generate',{...intent,...op,contextDigest:digest,instruction:'修改选中事实名称',draftId:'draft',selectedItemIds:['fact'],editor}],
  ['change-read',{...intent,...op,proposalId:'proposal',editor}],
  ['change-apply',{...intent,...op,proposalId:'proposal',proposalDigest:digest,confirmed:true,editor}],
  ...['draft','publication','publish-retry'].map(k=>['change-'+k,{warehouseId,documentId:'doc',draftId:'draft',...op,editor}]),
  ['change-items',{warehouseId,documentId:'doc',draftId:'draft',...rev,editor,kind:'entity',offset:0,limit:20}],
  ['change-preview',{warehouseId,documentId:'doc',draftId:'draft',...rev,editor,offset:0,limit:50}],
  ['change-source',{warehouseId,documentId:'doc',draftId:'draft',...rev,editor,sourceId:'segment',start:0}],
  ['change-heartbeat',{warehouseId,documentId:'doc',draftId:'draft',...rev,editor}],
  ['change-publish',{warehouseId,documentId:'doc',draftId:'draft',...rev,editor,confirmed:true}],
  ['change-draft-create',{warehouseId,documentId:'doc',...op,editor}],
  ['change-rule-publish',{warehouseId,ontologyId:'rules',...op}],
].map(([name,input])=>['conversation-'+name,input]);
