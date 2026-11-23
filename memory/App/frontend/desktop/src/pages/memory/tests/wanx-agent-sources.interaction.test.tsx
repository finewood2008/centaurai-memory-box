// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../i18n/i18n-provider.js';
import { AgentSources } from '../wanx-agent-sources.js';
import type { MyAiRequest } from '../wanx-my-ai-model.js';

let host: HTMLDivElement, root: Root;
let finish: ((value: unknown) => void)[];
let request: MyAiRequest;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  host=document.createElement('div'); document.body.append(host); root=createRoot(host); finish=[];
  request=vi.fn(async (action,_signal,data) => {
    if(action==='agent-context/status')return {boxReady:true};
    if((data as {selection?:object})?.selection)return new Promise(resolve=>{finish.push(resolve);});
    return {selection:{memoryEnabled:false},resources:{}};
  }) as MyAiRequest;
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const memory=()=>host.querySelector<HTMLButtonElement>('[aria-label="智能体记忆"]')!;
async function selectMemory() {
  await act(async () => memory().click());
  const all = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "全部 Agent");
  await act(async () => all!.click());
}
async function render(refresh:number){
  await act(async()=>root.render(<I18nProvider language="zh-CN"><AgentSources request={request} agent="codex" name="Codex"
    refresh={refresh} sources={{memoryEnabled:false}} onSourcesChange={()=>{}} onReady={()=>{}} disabled={false}/></I18nProvider>));
}
it('refreshing an in-flight save releases its saving state and allows selecting again',async()=>{
  await render(0);
  await selectMemory();
  expect(memory().disabled).toBe(true);
  await render(1);
  await act(async()=>finish[0]({selection:{memoryEnabled:true}}));
  expect(memory().disabled).toBe(false);
  expect(host.textContent).not.toContain('正在保存范围');
});
it('a late save from the old lifecycle cannot release a newer save lock',async()=>{
  await render(0); await selectMemory();
  await render(1); await selectMemory();
  expect(finish).toHaveLength(2);
  await act(async()=>finish[0]({selection:{memoryEnabled:true}}));
  expect(memory().disabled).toBe(true);
  await act(async()=>finish[1]({selection:{memoryEnabled:true}}));
  expect(memory().disabled).toBe(false);
});

it('shows a missing box as a routine status and reloads the available sources', async () => {
  const connectedRequest = request;
  let connected = false;
  request = vi.fn(async (action, signal, data) => {
    if (!connected && action === 'agent-context/selection') throw new Error('请先选择当前账号的盒子。');
    return connectedRequest(action, signal, data);
  }) as MyAiRequest;
  await render(0);
  const status = host.querySelector('.my-ai-source-feedback [role="status"]');
  expect(status?.textContent).toBe('请先选择当前账号的盒子。');
  expect(status?.classList.contains('my-ai-help')).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(memory().disabled).toBe(true);

  connected = true;
  await act(async () => host.querySelector<HTMLButtonElement>('.my-ai-source-feedback button')?.click());
  expect(host.querySelector('.my-ai-source-feedback')).toBeNull();
  expect(memory().disabled).toBe(false);
});
