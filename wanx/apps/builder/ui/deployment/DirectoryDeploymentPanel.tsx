import React,{useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import {api} from '../api';
import {createDirectoryDeploymentController} from './directory-controller';
import {TERMINAL,stateLabel,phaseLabel,componentLabel,commitLabel,formatTime,errorMessage,type DeploymentEnvironment} from './model';
import './deployment.css';

export function DirectoryDeploymentPanel({scopeId,initialReleaseId='',lockedReleaseId='',disabled=false}:{scopeId:string;initialReleaseId?:string;lockedReleaseId?:string;disabled?:boolean}) {
  const root=useRef<HTMLElement>(null);
  const controller=useMemo(()=>createDirectoryDeploymentController((path,method,body)=>api(path,method,body),lockedReleaseId||initialReleaseId),[scopeId,initialReleaseId,lockedReleaseId]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  useEffect(()=>{
    let live=true;void controller.loadReleases().then(()=>{if(live&&lockedReleaseId)void controller.ingest();});
    const poll=()=>{if(document.visibilityState==='visible'&&root.current?.getClientRects().length&&controller.shouldPoll())void controller.refresh();};
    const timer=window.setInterval(poll,4000);document.addEventListener('visibilitychange',poll);
    return()=>{live=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',poll);controller.dispose();};
  },[controller,lockedReleaseId]);
  useEffect(()=>{if(disabled)controller.confirm(false);},[controller,disabled]);
  const selected=state.selected,context=state.context,operation=state.operation,delivery=state.receipt;
  const busy=disabled||state.submitting||state.ingesting||state.pending;
  const ready=!disabled&&controller.deployReady();
  return <section className="deployment-panel" ref={root} aria-label="开物交付部署">
    <header className="deployment-header"><div><span className="deployment-eyebrow">APPLICATION DELIVERY</span><h2>部署开物交付版本</h2><p>读取开物投递的确定版本，将应用后端与配套客户端部署到当前盒子。</p></div><button disabled={state.listing||state.refreshing||state.submitting} onClick={()=>{void controller.loadReleases();if(selected)void controller.refresh();}}>刷新状态</button></header>
    <div className="deployment-grid">
      <section className="deployment-card deployment-configuration" aria-labelledby="directory-deployment-heading">
        <div className="deployment-card-heading"><h3 id="directory-deployment-heading">读取交付版本</h3><span className="deployment-tag">单盒子部署</span></div>
        <label htmlFor="directory-release-id">交付版本标识</label>
        <input id="directory-release-id" list="directory-release-options" value={state.releaseId} disabled={busy||Boolean(lockedReleaseId)} readOnly={Boolean(lockedReleaseId)} maxLength={128} autoComplete="off" placeholder="填写开物提供的 releaseId" style={{width:'100%',font:'inherit',fontSize:13,padding:'11px 13px',border:'1px solid var(--line, #dce3e8)',borderRadius:8,background:'var(--surface, #f7f9fb)',color:'inherit'}} onChange={event=>{if(!lockedReleaseId)controller.setReleaseId(event.target.value);}}/>
        <datalist id="directory-release-options">{state.releases.map(item=><option key={item.releaseId} value={item.releaseId}>{item.name} · v{item.version}</option>)}</datalist>
        <p className="deployment-muted">{lockedReleaseId?'已锁定本项目采用成果生成的交付版本，无需另填发布标识。':'填写发布标识即可，无需输入盒子路径或启动命令。'}</p>
        <button disabled={busy||state.available!==true||Boolean(state.listError)||!state.releaseId} onClick={()=>void controller.ingest()}>{state.ingesting?'正在读取…':'读取交付版本'}</button>
        {state.listError&&<p className="deployment-error" role="alert">{state.listError}</p>}
        {state.available===false&&!state.listError&&<p className="deployment-muted">当前盒子尚未开通此类交付部署，请确认部署配置与配套版本。</p>}
        {state.importError&&<p className="deployment-error" role="alert">{state.importError}</p>}
        {selected&&<>
          <label>当前交付应用</label><div className="deployment-static-field"><strong>{selected.name} · v{selected.version}</strong><small>{selected.applicationId}</small></div>
          <div className="deployment-form-row"><div><label htmlFor="directory-target">目标盒子</label><select id="directory-target" disabled value={context?.target?.boxId||''}><option value={context?.target?.boxId||''}>{context?.target?.boxId||'尚未取得可部署目标'}</option></select></div><div><label htmlFor="directory-environment">部署环境</label><select id="directory-environment" value={state.environment} disabled={busy||!context?.available} onChange={event=>controller.setEnvironment(event.target.value as DeploymentEnvironment)}><option value="dev">联调环境</option><option value="prod">正式环境</option></select></div></div>
          <div className="deployment-readiness" role="status"><strong>{ready?'已取得当前版本的部署配置':state.refreshing?'正在刷新部署配置':'部署尚未就绪'}</strong><p>{ready?'后端与客户端均验证后才显示完成。关闭工作台不会取消已经受理的任务。':context?.available===false?'当前交付版本的运行条件尚未满足，请检查盒子资源和运行能力。':state.readError||'请刷新配置，或等待现有操作处理完成。'}</p></div>
          <label className="deployment-confirm"><input type="checkbox" checked={state.confirmed} disabled={!ready||state.pending} onChange={event=>controller.confirm(event.target.checked)}/> 确认部署 v{selected.version} 到{state.environment==='prod'?'正式':'联调'}环境</label>
          <button className="deployment-primary" disabled={!ready||!state.confirmed} onClick={()=>void controller.deploy()}>{state.submitting?'正在提交…':state.pending?'重试同一次部署':'确认开始部署'}</button>
          {state.readError&&<p className="deployment-error" role="alert">{state.readError}</p>}
          {state.deploymentError&&<p className="deployment-error" role="alert">{state.deploymentError}</p>}
          {state.notice&&<p className="deployment-notice" role="status">{state.notice}</p>}
        </>}
      </section>
      <aside className="deployment-card deployment-summary"><h3>部署摘要</h3><dl><div><dt>交付版本</dt><dd>{selected?.releaseId||'尚未读取'}</dd></div><div><dt>应用版本</dt><dd>{selected?'v'+selected.version:'尚未读取'}</dd></div><div><dt>部署目标</dt><dd>{context?.target?.boxId||'尚未取得'}</dd></div><div><dt>部署环境</dt><dd>{state.environment==='prod'?'正式环境':'联调环境'}</dd></div></dl><div className="deployment-summary-note"><strong>使用盒子上的应用服务</strong><p>后端由盒子准备与运行，配套客户端由万象安装或加载。请求已受理不代表部署成功。</p></div></aside>
    </div>
    {operation&&<section className="deployment-card deployment-history" aria-label="交付部署结果">
      <div className="deployment-card-heading"><h3>部署结果</h3><span className={`deployment-status ${operation.state==='succeeded'?'good':TERMINAL.has(operation.state)?'attention':'working'}`}>{stateLabel(operation.state)}</span></div>
      <p className="deployment-muted">{commitLabel(operation.commitStatus)} · 最近更新 {formatTime(operation.updatedAt)}</p>
      {operation.errorCode&&<p className="deployment-error" role="alert">{errorMessage(Error(operation.errorCode))}</p>}
      <dl className="deployment-details"><div><dt>目标盒子</dt><dd>{operation.target.boxId}</dd></div><div><dt>环境</dt><dd>{operation.target.environment==='prod'?'正式':'联调'}</dd></div><div><dt>当前阶段</dt><dd>{phaseLabel(operation.phase)}</dd></div><div><dt>实际发布引用</dt><dd>{operation.releaseRef?.releaseId||'待核对'}</dd></div></dl>
      <h4>组件执行结果</h4>{operation.components.length?<ul className="deployment-components">{operation.components.map((component,index)=><li key={`${component.componentId}:${index}`}><div><strong>{component.role==='backend'?'应用后端':component.role==='client'?'配套客户端':'组件'}</strong><span>{component.required?'必需':'可选'}</span></div><div><span>{componentLabel(component.status)}</span>{component.actualVersion&&<small>实际版本 {component.actualVersion}</small>}</div></li>)}</ul>:<p className="deployment-muted">尚未收到组件执行结果。</p>}
      <section className="deployment-receipt" aria-label="结果回执"><h4>结果回执</h4>{state.receiptError?<p className="deployment-error" role="alert">{state.receiptError}</p>:!state.receiptLoaded?<p className="deployment-muted">正在读取结果回执…</p>:delivery?<><strong>{stateLabel(delivery.receipt.outcome)}</strong><p className="deployment-muted">{delivery.deliveryStatus==='delivered'?'回执已送达。':'回执正在同步。'} 同步结果不会重新执行部署。</p></>:<p className="deployment-muted">尚未生成最终回执。</p>}</section>
      <details className="deployment-identifiers"><summary>查看记录标识</summary><dl><div><dt>操作 ID</dt><dd>{operation.id}</dd></div>{selected&&<div><dt>目录摘要</dt><dd>{selected.directoryDigest}</dd></div>}</dl></details>
    </section>}
  </section>;
}
