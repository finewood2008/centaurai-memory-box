import { guideScreenTargets, isGuideBackgroundClick } from "../../../../../wanx/apps/starlink/shared/application-guide.mjs";
import { AppBootstrapResponseSchema } from "@memmy/local-api-contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createAppClients } from "./api/client-types.js";
import { requestJson } from "./api/http.js";
import { AppProviders, useApiClients } from "./app/providers.js";
import { I18nProvider } from "./i18n/i18n-provider.js";
import { useTranslation } from "./i18n/use-translation.js";
import { appActions } from "./state/app-actions.js";
import { useAppState } from "./state/app-state.js";
import { MemorySyncSummary } from "./pages/memory/wanx-memory-backup.js";
import "./styles.css";
import "./theme/centaur.css";
import "./wanx-memory.css";
import "./wanx-memory-workspace.css";
import "../../../../../wanx/apps/personal-client/resources/accessory-preview/public/box-connection.css";

const MemoryPage = lazy(() => import("./pages/memory-page.js").then(({ MemoryPage }) => ({ default: MemoryPage })));
const MemorySettings = lazy(() => import("./pages/memory/wanx-memory-settings.js"));
const MyAi = lazy(() => import("./pages/memory/wanx-my-ai.js"));
const token = new URLSearchParams(location.hash.slice(1)).get("session") ?? "";
const params = new URLSearchParams(location.search);
const section = params.get("section");
const requestedPage = params.get("memoryPage");
const requestedAgent = params.get("memoryAgent") ?? "";
const memoryAgent = requestedPage === "memories" && /^[a-z0-9_]{1,40}$/.test(requestedAgent) ? requestedAgent : undefined;
const initialMemoryPage = requestedPage === "backup" ? "backup" : requestedPage === "memories" ? "memories" : undefined;
document.addEventListener('click', event => {
  if (window.parent !== window && isGuideBackgroundClick(event)) window.parent.postMessage({type:'wanx-guide-background'}, '*');
});
// Only return fields from controls on the mounted page, including current selections.
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.type !== 'wanx-guide-page' || !event.ports[0]) return;
  if (typeof event.data.query==='string' && event.data.query.length<=120) {
    if(event.data.area==='selection'){
      const drawer=document.querySelector<HTMLElement>('.memory-drawer--entry');
      const row=document.querySelector<HTMLElement>('.memory-list [data-guide-record][aria-selected="true"]');
      const summary=Array.from(drawer?.querySelectorAll<HTMLElement>('.memory-detail-card .memory-detail-text') || []).find(el=>el.getClientRects().length);
      const key=row?.dataset.guideRecord;
      const available=!!(key && drawer?.getClientRects().length && summary);
      const result=event.data.key ? available && event.data.key===key : available ? [{key,title:row?.dataset.guideTitle,source:'当前记忆详情',excerpt:summary?.innerText.slice(0,600)}] : [];
      event.ports[0].postMessage(result);return;
    }
    const hits=guideScreenTargets(document,event.data.query);
    const result=typeof event.data.key==='string' ? !!hits.find(h=>h.key===event.data.key)?.open()
      : hits.map(({key,title,source})=>({key,title,source}));
    event.ports[0].postMessage(result);
    return;
  }
  const facts: Record<string, string | number | boolean | undefined> = {};
  const shown = (s:string) => Array.from(document.querySelectorAll<HTMLElement>(s)).filter(el=>el.getClientRects().length);
  const selected = shown('.my-ai-agent[aria-pressed=true]')[0];
  if (selected) facts.当前智能体 = selected.getAttribute('aria-label') ?? undefined;
  for (const el of shown('.my-ai-source-trigger')) {
    const label=el.getAttribute('aria-label');
    if (label) facts[label] = el.dataset.selected==='true' ? el.getAttribute('aria-description') || '已选择' : '未选择';
  }
  facts.子页面=shown('.memory-page-nav-group [aria-current=page]')[0]?.innerText.trim();
  const counts=shown('.memory-overview [data-overview-target]');
  if (counts.length) facts.概览数量=counts.map(card=>
    card.querySelector('.memory-overview__stat-label')?.textContent?.trim()+' '+card.querySelector('.memory-overview__stat-value')?.textContent?.trim()).join('，');
  const sources=shown('.memory-overview [data-source-distribution-row]');
  if (sources.length) facts.来源分布示例=sources.slice(0,5).map(row=>row.innerText.trim().replace(/\s+/g,' ')).join('，');
  const list=shown('.memory-panel--memories')[0]?.dataset;
  if (list) Object.assign(facts,{列表状态:list.guideState, 当前来源:list.guideSource,
    筛选结果数:list.guideTotal, 本页记录数:list.guideVisible});
  const backup=shown('#my-ai-backup')[0]?.dataset;
  if (backup) Object.assign(facts,{自动备份:backup.guideEnabled, 已选来源快照数:backup.guideSnapshots});
  event.ports[0].postMessage(facts);
});
window.addEventListener('keydown',e=>{
  if(!e.repeat && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase()==='k'){
    e.preventDefault();window.parent.postMessage({type:'wanx-guide-ask'},'*');
  }
});
// Notify the host when a memory or authorization editor is holding the user's place.
let previousLocation = '';
let modalOpen = false;
new MutationObserver(() => {
  const visible = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector)).find(el => el.getClientRects().length);
  const dialog = visible('dialog[open], [aria-modal="true"]');
  const open = Boolean(dialog);
  const nav = visible('.memory-page-nav-group [aria-current="page"]');
  const path = [
    nav?.closest('.memory-page-nav-group')?.querySelector('.memory-page-section-label')?.textContent,
    nav?.innerText,
    visible('.wanx-memory-settings-tabs [aria-current="page"]')?.innerText,
    visible('.my-ai-agent[aria-pressed="true"]')?.getAttribute('aria-label'),
    visible('#my-ai-connection-details')?.getAttribute('aria-label'),
    dialog?.matches('.memory-drawer--entry') ? '记忆详情' : dialog?.getAttribute('aria-label') ||
      document.getElementById(dialog?.getAttribute('aria-labelledby') || '')?.textContent,
  ].map(label => label?.trim()).filter(Boolean);
  const location = JSON.stringify(path);
  if (location !== previousLocation) {
    previousLocation = location;
    window.parent.postMessage({type:'wanx-guide-location', path}, '*');
  }
  if (open === modalOpen) return;
  modalOpen = open;
  window.parent.postMessage({type:'wanx-guide-modal',open}, '*');
}).observe(document.body, {subtree:true,childList:true,attributes:true,attributeFilter:['open','hidden','aria-modal','aria-current','aria-pressed']});
const isMyAi = section === "my-ai";
const healthIntervalMs = 5_000;
document.body.dataset.memorySurface = isMyAi ? "my-ai" : "memory";

function wanxMemoryWording(message: string) {
  return message.replace(/半人马AI\s*私人记忆盒子(?:\s+Platform)?|\bMemmy\b/gi, "半人马AI-记忆盒子");
}

function WanxMemorySurface() {
  const { language } = useTranslation();
  return <I18nProvider language={language} replacements={wanxMemoryWording}><MemorySurface /></I18nProvider>;
}

function MemorySurface() {
  const { clients, setClients } = useApiClients();
  const { dispatch } = useAppState();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reconnecting = useRef(false);

  function retryMemory() {
    if (reconnecting.current) return;
    reconnecting.current = true;
    setError(false);
    setAttempt(value => value + 1);
  }

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const runtimeConfig = { baseUrl: "wanx-memory://local", localToken: token };
    const connection = createAppClients({ runtimeConfig });
    let healthTimer: number | undefined;
    let checking = false;
    let failures = 0;

    function stopHealthChecks() {
      window.clearInterval(healthTimer);
      document.removeEventListener("visibilitychange", checkHealth);
    }

    async function checkHealth() {
      if (document.hidden || checking || signal.aborted) return;
      checking = true;
      try {
        const health = await connection.memoryRuntime.health(AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
        failures = health.storage.ready === true ? 0 : failures + 1;
      } catch {
        failures += 1;
      } finally {
        checking = false;
      }
      if (signal.aborted || failures < 2) return;
      stopHealthChecks();
      setClients(null);
      setError(true);
    }

    async function connect() {
      try {
        if (attempt > 0) {
          const reply = await fetch(new URL("/api/wanx-memory/reconnect", runtimeConfig.baseUrl), {
            method: "POST",
            headers: { "x-memmy-local-token": token },
            signal,
          });
          if (!reply.ok) throw new Error("Unable to start the local memory service");
        }
        const bootstrap = await requestJson({
          config: runtimeConfig,
          path: "/api/app/bootstrap",
          schema: AppBootstrapResponseSchema,
          init: { signal },
        });
        if (signal.aborted) return;
        dispatch(appActions.bootstrapLoaded(bootstrap, "/memory"));
        setClients(connection);
        healthTimer = window.setInterval(() => void checkHealth(), healthIntervalMs);
        document.addEventListener("visibilitychange", checkHealth);
      } catch {
        if (!signal.aborted) setError(true);
      } finally {
        if (!signal.aborted) reconnecting.current = false;
      }
    }

    void connect();
    return () => {
      controller.abort();
      stopHealthChecks();
    };
  }, [attempt, dispatch, setClients]);

  if (isMyAi) return <Suspense fallback={<p className="wanx-memory-status" role="status">正在加载我的 AI…</p>}>
    <MyAi sessionToken={token} memoryError={error} retryMemory={retryMemory} />
  </Suspense>;
  const connectionStatus = error ? <section className="wanx-memory-status" role="alert">
    <h2>记忆服务暂不可用</h2>
    <p>请确认本机记忆服务正在运行。</p>
    <button type="button" onClick={retryMemory}>重新连接记忆服务</button>
  </section> : !clients ? <p className="wanx-memory-status" role="status">正在连接记忆服务…</p> : null;
  const loading = <p className="wanx-memory-status" role="status">正在加载记忆…</p>;
  if (!clients && !error && attempt === 0) return connectionStatus;

  const backup = <div className="wanx-memory-backup-slot">
    <MemorySyncSummary sessionToken={token} onRestored={() => {
      clients?.memoryRuntime.resetPanelView?.();
      window.dispatchEvent(new Event("memmy-panel-invalidated"));
    }} />
  </div>;
  return <Suspense fallback={loading}>
    <MemoryPage hideSources backupContent={backup} initialSubPage={initialMemoryPage}
      initialSourceAgent={memoryAgent} libraryStatus={connectionStatus}
      renderSettings={(section, onSectionChange) => <Suspense fallback={loading}>
        <MemorySettings section={section} onSectionChange={onSectionChange}
          sessionToken={token} connectionStatus={connectionStatus} />
      </Suspense>} />
  </Suspense>;
}

createRoot(document.getElementById("root")!).render(<AppProviders><WanxMemorySurface /></AppProviders>);
