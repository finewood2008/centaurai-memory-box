import React,{useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {api,type Project} from '../api';
import {createDeploymentController} from './controller';
import {TERMINAL,canResume,stateLabel,phaseLabel,kindLabel,componentLabel,commitLabel,formatTime,errorMessage,type DeploymentEnvironment,type ComponentResult,type Operation} from './model';
import './deployment.css';
import {DeploymentEvents,OperationNotice} from './DeploymentProgress';
import {StudioExpertDeploymentPanel} from './StudioExpertDeploymentPanel';

function Status({operation}:{operation:Operation}) {
  const tone=operation.state==='succeeded'?'good':TERMINAL.has(operation.state)?'attention':'working';
  return <span className={`deployment-status ${tone}`}>{stateLabel(operation.state)}</span>;
}
function Components({items}:{items:ComponentResult[]}) {
  if(!items.length)return <p className="deployment-muted">尚未收到组件执行结果。</p>;
  return <ul className="deployment-components">{items.map((component,index)=><li key={`${component.componentId}:${index}`}>
    <div><strong>{component.role==='backend'?'后端服务':component.role==='client'?'应用客户端':component.role==='channel'?'应用入口':'组件'}</strong><span>{component.required?'必需':'可选'}</span></div>
    <div><span>{componentLabel(component.status)}</span>{component.actualVersion&&<small>实际版本 {component.actualVersion}</small>}</div>
    {component.errorCode&&<p className="deployment-error">{errorMessage(new Error(component.errorCode))}</p>}
  </li>)}</ul>;
}

export function DeploymentPanel({project,scopeId}:{project:Project;scopeId:string}) {
  const hash=project.versioning?.adoptedHash||project.acceptance?.artifactHash;
  const adopted=project.artifacts.find(artifact=>artifact.hash===hash);
  return !project.workshop&&(typeof window==='undefined'||!window.wanxStudio?.workshop)&&(project.deploymentExpert||adopted?.manifest.capabilities.includes('foundation'))?<StudioExpertDeploymentPanel project={project} scopeId={scopeId}/>:<MiniappDeploymentPanel project={project} scopeId={scopeId}/>;
}
function MiniappDeploymentPanel({project,scopeId}:{project:Project;scopeId:string}) {
  const root=useRef<HTMLElement>(null);
  const [environment,setEnvironment]=useState<DeploymentEnvironment>('dev'),[confirming,setConfirming]=useState(false);
  const controller=useMemo(()=>createDeploymentController((path,method,body)=>api(path,method,body),project.appId,project.id),[scopeId,project.id,project.appId]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  useEffect(()=>{
    void controller.refresh();
    const poll=()=>{if(document.visibilityState==='visible'&&root.current?.getClientRects().length&&controller.shouldPoll())void controller.refresh()};
    const timer=window.setInterval(poll,4000);
    document.addEventListener('visibilitychange',poll);
    return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',poll);controller.dispose()};
  },[controller]);
  const adoptedHash=project.versioning?.adoptedHash||project.acceptance?.artifactHash;
  const adopted=project.artifacts.find(artifact=>artifact.hash===adoptedHash);
  const operation=state.operation,delivery=state.receipt;
  const available=state.capabilities?.available===true;
  const context=state.context,revision=project.versioning?.revision||0;
  const deployEnabled=Boolean(adopted&&controller.deployReady(adopted.hash,revision,environment));
  const target=context?.target;
  const environmentInfo=context?.environments.find(item=>item.id===environment);
  const actionUnavailable=Boolean(state.actionPending||state.deploying||state.detailLoading||state.loading||state.detailError||state.listError||state.capabilityError);
  const resumeEnabled=canResume(operation,state.capabilities)&&!actionUnavailable;
  const disabledReason=state.contextError||state.capabilityError||(!state.capabilities||state.loading?'正在读取部署准备信息。':!available?'当前盒子的部署执行能力尚未接通。':!adopted?'请先在版本历史中采用一个版本。':!context?.available?errorMessage(new Error(context?.reason||'DEPLOYMENT_CONTEXT_REQUIRED')):context.profile!=='wanx-miniapp-v1'?'当前工作台暂不支持这个应用的部署方式。':context.artifact?.hash!==adopted.hash?'已采纳版本已变化，请刷新工作台后重试。':!deployEnabled?'正在处理已有部署，或部署条件已变化，请刷新记录。':'');
  return <section className="deployment-panel" ref={root} aria-label="应用部署">
    <header className="deployment-header"><div><span className="deployment-eyebrow">APPLICATION DEPLOYMENT</span><h2>部署到盒子</h2><p>从当前项目查看部署准备情况，跟踪盒子与客户端的实际执行结果。</p></div><button onClick={()=>void controller.refresh()} disabled={state.loading}>{state.loading?'正在刷新…':'刷新状态'}</button></header>
    <div className="deployment-grid">
      <section className="deployment-card deployment-configuration" aria-labelledby="deployment-config-heading">
        <div className="deployment-card-heading"><h3 id="deployment-config-heading">部署配置</h3><span className="deployment-tag">单盒子部署</span></div>
        <label>待部署应用</label><div className="deployment-static-field"><strong>{project.name}</strong><small>{project.appId}</small></div>
        <label>已采纳版本</label><div className="deployment-static-field">{adopted?<><strong>v{adopted.version}</strong><small>由后台核对该成果并生成不可变发布包。</small></>:<><strong>尚无可用的已采纳版本</strong><small>请先采用一个构建成果，再准备部署。</small></>}</div>
        <div className="deployment-form-row"><div><label htmlFor="deployment-target">目标盒子</label><select id="deployment-target" disabled value={target?.boxId||''}><option value={target?.boxId||''}>{target?.boxId||'等待获取可部署目标'}</option></select></div><div><label htmlFor="deployment-environment">部署环境</label><select id="deployment-environment" disabled={!context?.available||state.deploying||state.deploymentPending} value={environment} onChange={event=>{setEnvironment(event.target.value as DeploymentEnvironment);setConfirming(false)}}><option value="dev" disabled={!context?.environments.some(item=>item.id==='dev')}>联调环境</option><option value="prod" disabled={!context?.environments.some(item=>item.id==='prod')}>正式环境</option></select></div></div>
        <div className="deployment-readiness" role="status"><strong>{state.contextError||state.capabilityError?'暂时无法读取部署条件':deployEnabled?'已取得当前版本的部署目标与配置':state.loading?'正在检查部署条件':'部署尚未就绪'}</strong><p>{deployEnabled?`将部署到${environment==='prod'?'正式':'联调'}环境。后台和客户端均验证后才显示完成；环境数据与普通安装分开保存。`:disabledReason}</p></div>
        {confirming&&deployEnabled?<div className="deployment-confirm" role="group" aria-label="确认部署"><strong>确认部署 v{adopted?.version} 到{environment==='prod'?'正式':'联调'}环境？</strong><p className="deployment-muted">目标盒子：{target?.boxId}。当前环境代次 {environmentInfo?.generation??'未知'}。提交后关闭工作台不会取消后台任务。</p><button onClick={()=>setConfirming(false)}>取消</button><button className="deployment-primary" onClick={()=>{setConfirming(false);if(adopted)void controller.deploy(adopted.hash,revision,environment)}}>确认开始部署</button></div>:<button className="deployment-primary" disabled={!deployEnabled} aria-describedby="deployment-disabled-reason" onClick={()=>{if(state.deploymentPending&&adopted)void controller.deploy(adopted.hash,revision,environment);else setConfirming(true)}}>{state.deploying?'正在提交…':state.deploymentPending?'重试同一次部署':'部署到盒子'}</button>}
        <p id="deployment-disabled-reason" className="deployment-muted">{disabledReason}</p>
        {state.deploymentError&&<div role="alert"><p className="deployment-error">{state.deploymentError}</p><details><summary>准备新请求</summary><p className="deployment-muted">请先刷新并核对已有记录。结束重试不会取消已经受理的后台部署。</p><button disabled={state.deploying} onClick={()=>controller.abandonAttempt()}>确认结束本次重试</button></details></div>}
        {state.deploymentNotice&&<p className="deployment-notice" role="status">{state.deploymentNotice}</p>}

      </section>
      <aside className="deployment-card deployment-summary" aria-label="部署范围说明">
        <h3>部署摘要</h3><dl><div><dt>应用</dt><dd>{project.name}</dd></div><div><dt>当前成果</dt><dd>{adopted?'v'+adopted.version:'尚未采纳'}</dd></div><div><dt>部署目标</dt><dd>{target?.boxId||'尚未取得可部署目标'}</dd></div><div><dt>部署环境</dt><dd>{context?.available?(environment==='prod'?'正式环境':'联调环境'):'尚未取得环境配置'}</dd></div></dl>
        <div className="deployment-summary-note"><strong>后端与客户端分别验证</strong><p>收到任务不代表部署完成。部署结果以后台记录及必需组件的实际状态为准。</p></div>
        <p className="deployment-muted">当前工作台的“采用并安装”沿用原有应用安装流程；部署到盒子的任务会单独记录在下方。</p>
      </aside>
    </div>
    <section className="deployment-card deployment-history" aria-labelledby="deployment-history-heading">
      <div className="deployment-card-heading"><div><h3 id="deployment-history-heading">本应用的近期部署</h3><p className="deployment-muted">从本账号最近 100 条部署操作中，筛选应用标识与当前项目一致的记录。</p></div><span className="deployment-count">{state.operations.length} 条</span></div>
      {state.listError&&<p className="deployment-error" role="alert">{state.listError}{state.operations.length?' 下方保留上次读取的记录，可能不是最新状态。':''}</p>}
      {!state.operations.length?<div className="deployment-empty">{state.loading?'正在读取部署记录…':state.listError?'未能读取部署记录，请刷新重试。':'最近读取的记录中，没有与本应用匹配的部署操作。'}</div>:<div className="deployment-history-layout">
        <div className="deployment-operation-list" role="list" aria-label="近期部署操作">{state.operations.map(item=><button type="button" className={item.id===state.selectedId?'selected':''} key={item.id} onClick={()=>void controller.select(item.id)} aria-pressed={item.id===state.selectedId}>
          <span className="deployment-operation-heading"><strong>{kindLabel(item.kind)} · {item.target.environment==='prod'?'正式环境':'联调环境'}</strong><Status operation={item}/></span><span className="deployment-target-name">盒子 {item.target.boxId}</span><span className="deployment-operation-meta">{formatTime(item.createdAt)}</span>
        </button>)}</div>
        <div className="deployment-operation-detail" aria-live="polite" aria-busy={state.detailLoading}>
          {state.detailError&&<p className="deployment-error" role="alert">{state.detailError}{operation?' 显示的是上次读取的详情。':''}</p>}
          {!operation?<p className="deployment-muted">{state.detailLoading?'正在读取任务详情…':'请选择一条部署记录。'}</p>:<>
            <header className="deployment-detail-heading"><div><h4>{kindLabel(operation.kind)}详情</h4><Status operation={operation}/></div><button disabled={!resumeEnabled} onClick={()=>void controller.resume()}>{state.actionPending==='resume'?'正在请求…':'继续处理任务'}</button></header>
            <p className="deployment-muted">{commitLabel(operation.commitStatus)} · 最近更新 {formatTime(operation.updatedAt)}</p>
            <dl className="deployment-details"><div><dt>目标盒子</dt><dd>{operation.target.boxId}</dd></div><div><dt>环境</dt><dd>{operation.target.environment==='prod'?'正式环境':'联调环境'}</dd></div><div><dt>当前阶段</dt><dd>{phaseLabel(operation.phase)}</dd></div><div><dt>发布版本</dt><dd>{operation.releaseRef?.releaseId||'沿用当前运行版本'}</dd></div></dl>
            <OperationNotice operation={operation}/>
            {state.notice&&<p className="deployment-notice" role="status">{state.notice}</p>}{state.actionError&&<p className="deployment-error" role="alert">{state.actionError}</p>}
            <h4>组件执行结果</h4><Components items={operation.components}/>
            <section className="deployment-receipt" aria-label="结果回执"><div className="deployment-card-heading"><h4>结果回执</h4>{delivery?.deliveryStatus==='pending'&&<button disabled={actionUnavailable||Boolean(state.receiptError)} onClick={()=>void controller.retryReceipt()}>{state.actionPending==='receipt'?'正在同步…':'重新同步回执'}</button>}</div>
              {state.receiptError?<p className="deployment-error" role="alert">{state.receiptError}</p>:!state.receiptLoaded?<p className="deployment-muted">正在读取结果回执…</p>:!delivery?<p className="deployment-muted">尚未生成最终结果回执。</p>:<><div className="deployment-receipt-status"><strong>{stateLabel(delivery.receipt.outcome)}</strong><span className={`deployment-status ${delivery.deliveryStatus==='delivered'?'good':'attention'}`}>{delivery.deliveryStatus==='delivered'?'回执已送达':'回执待同步'}</span></div><p className="deployment-muted">已尝试投递 {delivery.attempts} 次。回执同步与部署执行分开处理，重新同步不会重新部署。</p></>}
            </section>
            <DeploymentEvents events={state.events} loading={state.eventsLoading} error={state.eventsError} hasMore={state.hasMore} truncated={state.eventsTruncated} onLoad={()=>void controller.loadEvents()}/>
            <details className="deployment-identifiers"><summary>查看记录标识</summary><dl><div><dt>操作 ID</dt><dd>{operation.id}</dd></div><div><dt>组织</dt><dd>{operation.target.organizationId}</dd></div>{delivery&&<div><dt>回执 ID</dt><dd>{delivery.receipt.receiptId}</dd></div>}</dl></details>
          </>}
        </div>
      </div>}
    </section>
  </section>;
}
