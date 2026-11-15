import React,{useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {api,type Project} from '../api';
import {createProjectExpertController,type ExpertVerification} from './project-expert-controller';
import './project-expert.css';

const DEFAULT_INPUT='请只回复 WANX_EXPERT_READY',DEFAULT_EXPECTED='WANX_EXPERT_READY';
export function ExpertContractPicker({project,scopeId,busy,onUpdate,onRun}:{project:Project;scopeId:string;busy:boolean;onUpdate:(project:Project)=>void;onRun:(task:()=>Promise<void>)=>Promise<void>}) {
 const adoptedHash=project.versioning?.adoptedHash||project.acceptance?.artifactHash||null,versionRevision=project.versioning?.revision||0;
 const controller=useMemo(()=>createProjectExpertController((path,method,body)=>api(path,method,body),{projectId:project.id,applicationId:project.appId,source:adoptedHash?{artifactHash:adoptedHash,versionRevision}:null}),[scopeId,project.id,project.appId,adoptedHash,versionRevision]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),active=useRef(controller),alive=useRef(true);
 active.current=controller;
 const fieldId=useId();
 const [selected,setSelected]=useState(''),[input,setInput]=useState(DEFAULT_INPUT),[expected,setExpected]=useState(DEFAULT_EXPECTED);
 useEffect(()=>{alive.current=true;void controller.refresh();return()=>{alive.current=false;controller.dispose();};},[controller]);
 const context=state.context,contract=context?.configuration.contract;
 useEffect(()=>{setSelected(contract?.template.digest||'');setInput(contract?.verification.checks[0].input.text||DEFAULT_INPUT);setExpected(contract?.verification.checks[0].expected.contains||DEFAULT_EXPECTED);},[controller,context?.configuration.revision]);
 if(!context?.available&&!state.readError)return null;
 const disabled=busy||state.loading||state.saving||state.configurationPending||!context?.available||!context.configuration.editable||Boolean(state.readError);
 const chosen=context?.templates.find(template=>template.digest===selected);
 async function save() {
  const current=controller;
  await onRun(async()=>{
   const check:ExpertVerification|null=selected?{schemaVersion:1,checks:[{id:'text-roundtrip',input:{text:input},expected:{contains:expected}}]}:null;
   if(!await current.saveContract(chosen||null,check))return;
   const updated=await api<Project>(`/projects/${project.id}`);
   if(alive.current&&active.current===current&&updated.id===project.id)onUpdate(updated);
  });
 }
 return <section className="expert-contract-picker" aria-label="专家后端合同">
  <h3>应用后端</h3><p>选择盒子上的文本专家作为后端，配套客户端通过部署后的专家入口使用它。</p>
  {state.readError&&<p role="alert">{state.readError}</p>}
  <label htmlFor={fieldId+'-template'}>后端方式</label>
  <select id={fieldId+'-template'} value={selected} disabled={disabled} onChange={event=>setSelected(event.target.value)}>
   <option value="">普通应用，使用已确认的现有能力</option>
   {contract&&!context?.templates.some(template=>template.digest===contract.template.digest)&&<option value={contract.template.digest} disabled>原专家版本已变化，请重新选择</option>}
   {context?.templates.map(template=><option key={template.digest} value={template.digest}>{template.name||template.resourceId}</option>)}
  </select>
  {selected&&<>
   <p>首版使用盒端默认模型，仅支持文本问答。部署时会真实执行下面的合成验证。</p>
   <label htmlFor={fieldId+'-input'}>合成验证输入</label><textarea id={fieldId+'-input'} rows={2} maxLength={4000} value={input} disabled={disabled} onChange={event=>setInput(event.target.value)}/>
   <label htmlFor={fieldId+'-expected'}>回复应包含</label><input id={fieldId+'-expected'} maxLength={512} value={expected} disabled={disabled} onChange={event=>setExpected(event.target.value)}/>
   <small>请使用不含业务资料、不会产生外部操作的测试内容。</small>
  </>}
  <div className="preparation-actions"><button disabled={busy||state.loading||state.saving} onClick={()=>void controller.refresh()}>刷新配置</button><button disabled={state.saving||busy||Boolean(state.readError)||!context?.available||!context.configuration.editable||state.loading||(!state.configurationPending&&Boolean(selected&&(!chosen||!input.trim()||!expected.trim())))} onClick={()=>void save()}>{state.saving?'正在保存…':state.configurationPending?'核对同一次保存':'保存后端选择'}</button></div>
  {!context?.configuration.editable&&<small>请先完成或停止正在进行的开发和访谈，再修改后端合同。</small>}
  <p><small>修改后需要重新检查能力并生成、采用新版本；已采用的成果仍保留自己的冻结合同。</small></p>
  {state.configurationError&&<p role="alert">{state.configurationError}</p>}{state.notice&&<p role="status">{state.notice}</p>}
 </section>;
}
