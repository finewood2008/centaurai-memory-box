import React,{useEffect,useMemo,useSyncExternalStore} from 'react';
import {api,errorText,type Project} from '../api';
import {DirectoryDeploymentPanel} from './DirectoryDeploymentPanel';
import {createProjectExpertController} from './project-expert-controller';
import './deployment.css';
import './project-expert.css';

export function StudioExpertDeploymentPanel({project,scopeId}:{project:Project;scopeId:string}) {
 const adoptedHash=project.versioning?.adoptedHash||project.acceptance?.artifactHash||null,versionRevision=project.versioning?.revision||0;
 const controller=useMemo(()=>createProjectExpertController((path,method,body)=>api(path,method,body),{projectId:project.id,applicationId:project.appId,source:adoptedHash?{artifactHash:adoptedHash,versionRevision}:null}),[scopeId,project.id,project.appId,adoptedHash,versionRevision]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 useEffect(()=>{void controller.refresh();return()=>controller.dispose();},[controller]);
 const source=state.context?.source,ready=controller.exportReady();
 const unavailable=state.readError||(!state.context||state.loading?'正在核对已采用版本。':!state.context.available?'当前盒子尚未启用开物专家部署。':!adoptedHash?'请先正常构建并采用一个版本。':state.context.reason?errorText(new Error(state.context.reason)):!source?'当前成果没有冻结的专家合同，请选择后端、检查能力并生成新版本。':'');
 return <div className="studio-expert-deployment">
  <section className="deployment-panel" aria-label="开物采用版本交付">
   <header className="deployment-header"><div><span className="deployment-eyebrow">KAIWU EXPERT DELIVERY</span><h2>部署专家应用</h2><p>从当前项目已采用的成果生成交付目录，再部署专家后端与配套客户端。</p></div><button disabled={state.loading||state.exporting||state.saving} onClick={()=>void controller.refresh()}>刷新采用版本</button></header>
   <section className="deployment-card">
    <h3>冻结当前采用成果</h3><dl className="deployment-details"><div><dt>应用</dt><dd>{project.name}</dd></div><div><dt>已采用版本</dt><dd>{source?'v'+source.version:'尚未取得可交付成果'}</dd></div>{source&&<><div><dt>来源版本标识</dt><dd>{source.artifactHash}</dd></div><div><dt>制作记录</dt><dd>{source.taskId}</dd></div></>}</dl>
    <p className="deployment-muted">保留原版本标识与制作记录，包装既有客户端成果。生成目录不会重新编译，也不会启动部署。</p>
    {unavailable&&<p className="deployment-muted" role="status">{unavailable}</p>}
    {state.exportConfirmed&&!state.exportPending&&ready?<div className="deployment-confirm" role="group" aria-label="确认生成交付目录"><strong>将已采用 v{source?.version} 冻结为部署交付版本？</strong><p>使用该成果已确认的专家合同；生成后还需单独核对环境并确认部署。</p><button onClick={()=>controller.confirmExport(false)}>取消</button><button className="deployment-primary" onClick={()=>void controller.exportRelease()}>确认生成交付目录</button></div>:<button className="deployment-primary" disabled={!ready||state.exporting} onClick={()=>{if(state.exportPending)void controller.exportRelease();else controller.confirmExport(true);}}>{state.exporting?'正在生成…':state.exportPending?'核对同一次导出':state.delivery?'重新核对同一采用成果':'生成交付目录'}</button>}
    {state.exportError&&<p className="deployment-error" role="alert">{state.exportError}</p>}{state.notice&&<p className="deployment-notice" role="status">{state.notice}</p>}
    {state.exportPending&&<details><summary>结束本次核对</summary><p className="deployment-muted">这不会取消服务器可能已经保存的交付目录。请先核对源版本，再刷新后重新准备。</p><button disabled={state.exporting} onClick={()=>controller.abandonExport()}>结束核对并要求刷新</button></details>}
    {state.delivery&&<div className="deployment-static-field"><strong>已冻结 v{state.delivery.release.version}</strong><small>发布标识：{state.delivery.release.releaseId}</small><small>目录摘要：{state.delivery.release.directoryDigest}</small></div>}
   </section>
  </section>
  {state.delivery&&<DirectoryDeploymentPanel key={state.delivery.release.releaseId} scopeId={scopeId} lockedReleaseId={state.delivery.release.releaseId} disabled={Boolean(state.readError)||state.loading}/>}
 </div>;
}
