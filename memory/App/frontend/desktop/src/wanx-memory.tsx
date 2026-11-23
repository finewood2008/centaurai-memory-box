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

const MemoryPage = lazy(() => import("./pages/memory-page.js").then(({ MemoryPage }) => ({ default: MemoryPage })));
const MemorySettings = lazy(() => import("./pages/memory/wanx-memory-settings.js"));
const MyAi = lazy(() => import("./pages/memory/wanx-my-ai.js"));
const token = new URLSearchParams(location.hash.slice(1)).get("session") ?? "";
const params = new URLSearchParams(location.search);
const section = params.get("section");
const requestedPage = params.get("memoryPage");
const requestedAgent = params.get("memoryAgent") ?? "";
const memoryAgent = requestedPage === "memories" && /^[a-z0-9_]{1,40}$/.test(requestedAgent) ? requestedAgent : undefined;
const initialMemoryPage = requestedPage === "backup" ? "backup" : memoryAgent ? "memories" : undefined;
const isMyAi = section === "my-ai";
const healthIntervalMs = 5_000;
document.body.dataset.memorySurface = isMyAi ? "my-ai" : "memory";

function wanxMemoryWording(message: string) {
  return message.replace(/半人马AI\s*私人记忆盒子(?:\s+Platform)?|\bMemmy\b/gi, "半人马AI记忆盒子");
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
