import React from 'react';
import {errorMessage,formatTime,isWaiting,phaseLabel,progressReason,stateLabel,type Operation,type ProgressEvent} from './model';

export function OperationNotice({operation}:{operation:Operation}) {
  if(isWaiting(operation.state))return <p className="deployment-waiting" role="status">
    <strong>{phaseLabel(operation.phase)}：{stateLabel(operation.state)}</strong>
    <span>{progressReason(operation.errorCode)}</span>
    <span>任务尚未结束。可刷新查看同一任务的进展，无需重新提交部署。</span>
  </p>;
  return operation.errorCode?<p className="deployment-error" role="alert">{errorMessage(Error(operation.errorCode))}</p>:null;
}

export function DeploymentEvents({events,loading,error,hasMore,truncated,onLoad}:{events:ProgressEvent[];loading:boolean;error:string;hasMore:boolean;truncated:boolean;onLoad:()=>void}) {
  return <section className="deployment-events" aria-label="执行事件">
    <div className="deployment-card-heading"><h4>执行记录</h4>{loading&&<span className="deployment-muted">读取中…</span>}</div>
    {error&&<p className="deployment-error" role="alert">{error}</p>}
    {truncated&&<p className="deployment-muted">仅保留当前已读取的最近 1000 条事件。</p>}
    {!events.length&&!loading?<p className="deployment-muted">{error?'事件暂不可读。':'尚无执行事件。'}</p>:<ol>{events.map(event=><li key={event.sequence}>
      <span>{event.phase?phaseLabel(event.phase):event.type==='accepted'?'任务已受理':event.type==='completed'?'处理结束':'状态更新'}</span>
      <small>{event.state?stateLabel(event.state)+' · ':''}{formatTime(event.createdAt)}</small>
      {event.errorCode?<p className="deployment-event-reason">当时原因：{progressReason(event.errorCode)}</p>:event.state&&isWaiting(event.state)?<p className="deployment-event-reason">该历史记录未保存具体原因。</p>:null}
    </li>)}</ol>}
    {(hasMore||error)&&<button disabled={loading} onClick={onLoad}>{loading?'正在读取…':error?'重试读取事件':'读取更多事件'}</button>}
  </section>;
}
