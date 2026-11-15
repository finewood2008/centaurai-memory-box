import { type AgentSourceScanStatusResponse, type ScanResult } from "@memmy/local-api-contracts";
import { useComputerHistoryModelSync } from "./app/computer-history-model-sync.js";
import { isComputerHistorySupported } from "./app/computer-history-platform.js";
/** App module. */
import { SseEventSchema, type SseEvent } from "@memmy/local-api-contracts";
import { rememberPublishedMemoryBudget } from "./components/memory-token-budget-banner.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setAnalyticsUserId, setAnalyticsUserMode } from "./analytics/analytics-context.js";
import { useScanCompletions } from "./app/use-scan-completions.js";
import {
  AgentRuntimeBridge,
  createAgentTaskStateCoordinator,
  type AgentTaskStateCoordinator
} from "./app/agent-runtime-bridge.js";
import { AppProviders, useApiClients } from "./app/providers.js";
import { usePluginUi } from "./app/plugin-ui-context.js";
import { AgentSourceScanReconciler } from "./app/agent-source-scan-reconciler.js";
import { AppRouter, useWanxiangAccount } from "./app/router.js";
import { UpdateCoordinatorProvider } from "./app/update-coordinator.js";
import { HistoryLaunchPromptHost } from "./components/history-launch-prompt-host.js";
import { NotificationCenterProvider } from "./components/notification-center.js";
import {
  FOCUSED_AGENT_CHAT_STORAGE_KEY,
  readLaunchModeOverride,
  readLaunchRouteOverride,
  readCurrentRoute,
  resolveMainWindowRouteTarget,
  resolvePreferredLaunchMode,
  resolveLaunchInitialView,
  type MainWindowRouteTarget
} from "./app/routes.js";
import { createAppClients } from "./api/client-types.js";
import { createEventsConnection } from "./api/events.js";
import { MemmyAgentRequestError, type MemmyAgentClient } from "./api/memmy-agent-client.js";
import { getRuntimeConfig } from "./api/runtime-config.js";
import { readHistoryPermissionSetup } from "./pages/memory/computer-history-permission-state.js";
import { shouldReturnToWeChatSettings } from "./pages/memory/computer-history-wechat-permission-state.js";
import { readLocalNickname } from "./app/nickname.js";
import { useTranslation } from "./i18n/use-translation.js";
import {
  agentActions,
  appActions,
  createAgentOperationError,
  type AppAction
} from "./state/app-actions.js";
import type { AgentState } from "./state/agent-chat-slice.js";
import { useAppState } from "./state/app-state.js";
import { useComputerHistoryTrayIndicator } from "./app/computer-history-tray-indicator.js";

/** Handles app. */
export function App() {
  return (
    <AppProviders>
      <RuntimeApp />
    </AppProviders>
  );
}

/** Runs runtime app. */
function RuntimeApp() {
  const { state, dispatch } = useAppState();
  const wanxiang = typeof window === "undefined" ? undefined : window.centaurWorkspace;
  const wanxAccount = useWanxiangAccount(wanxiang);
  const scanStateRef = useRef(state.agentSources);
  scanStateRef.current = state.agentSources;
  const { clients, setClients } = useApiClients();
  const { receive: receivePluginEvent, reconcilePendingCalls } = usePluginUi();
  useComputerHistoryTrayIndicator(clients?.memmyAgent ?? null);
  useComputerHistoryModelSync({
    client: clients?.memmyAgent ?? null,
    enabled: Boolean(state.bootstrap && state.modelConfig),
    revision: JSON.stringify([state.bootstrap?.app.userMode, state.account.userId, state.modelConfig?.configRevision]),
  });
  const { t } = useTranslation();
  const translationRef = useRef(t);
  const agentStateRef = useRef(state.agent);
  const isScanningRef = useRef(false);
  const scanUnavailableRef = useRef(false);
  const rendererReadyReportedRef = useRef(false);
  const [bootKey, setBootKey] = useState(0);
  translationRef.current = t;
  agentStateRef.current = state.agent;
  isScanningRef.current = state.agentSources.isScanning;
  scanUnavailableRef.current = Boolean(state.agentSources.scanUnavailable);
  const taskStateCoordinator = useMemo(() => (
    clients?.memmyAgent
      ? createAgentTaskStateCoordinator(
          clients.memmyAgent,
          dispatch,
          () => agentStateRef.current
        )
      : null
  ), [clients?.memmyAgent, dispatch]);

  const retry = useCallback(() => setBootKey((value) => value + 1), []);

  useScanCompletions(clients?.agentSources ?? null, state.agentSources, dispatch, t);

  useEffect(() => {
    setAnalyticsUserMode(state.bootstrap?.app.userMode ?? "unset");
  }, [state.bootstrap?.app.userMode]);

  useEffect(() => {
    setAnalyticsUserId(state.account.userId);
  }, [state.account.userId]);

  useEffect(() => {
    if (
      rendererReadyReportedRef.current
      || !clients
      || !state.bootstrap
      || typeof window === "undefined"
      || !window.memmy?.notifyRendererReady
    ) return;
    rendererReadyReportedRef.current = true;
    window.memmy.notifyRendererReady();
  }, [clients, state.bootstrap]);

  useEffect(() => () => taskStateCoordinator?.dispose(), [taskStateCoordinator]);

  useEffect(() => {
    if (!clients?.byokTokenUsage) {
      return undefined;
    }
    let cancelled = false;
    const refresh = () => {
      void clients.byokTokenUsage.getMemoryBudget().then((budget) => {
        if (!cancelled) {
          rememberPublishedMemoryBudget(budget);
          window.dispatchEvent(new CustomEvent("memmy:memory-token-budget-updated", { detail: budget }));
        }
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("memmy:memory-token-budget-refresh", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("memmy:memory-token-budget-refresh", refresh);
    };
  }, [clients]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.memmy?.onRouteTargetRequest) {
      return undefined;
    }

    return window.memmy.onRouteTargetRequest((target) => {
      applyMainWindowRouteTarget(
        target,
        dispatch,
        clients?.memmyAgent ?? null,
        agentStateRef.current,
        taskStateCoordinator ?? undefined
      );
    });
  }, [clients?.memmyAgent, dispatch, taskStateCoordinator]);

  useEffect(() => {
    let events: EventSource | undefined;
    let isActive = true;
    function handleScanCompletion(
      completion: NonNullable<AgentSourceScanStatusResponse["completion"]>,
      _client: ReturnType<typeof createAppClients>["agentSources"],
      scanResults?: ScanResult[]
    ) {
      if (isActive) dispatch(appActions.agentSourceScanCompleted({ ...completion, results: scanResults }));
    }

    async function reconcileAgentSourceScanStatus(agentSourceClient: ReturnType<typeof createAppClients>["agentSources"]) {
      const requestGeneration = scanStateRef.current.scanRequestGeneration ?? 0;
      try {
        const status = await agentSourceClient.getScanStatus();
        if (!isActive) return;
        dispatch(appActions.agentSourceScanAvailability(status.unavailable ?? null));
        if (status.unavailable) return;
        dispatch(appActions.agentSourceScanStatusReceived(status, requestGeneration));
      } catch {
        // The next scanning heartbeat or reconnect will reconcile again.
      }
    }

    /** Handles boot. */
    async function boot() {
      dispatch(appActions.startupLoading());

      try {
        const runtimeConfig = await getRuntimeConfig();
        const clients = createAppClients({ runtimeConfig });
        const bootstrap = await clients.bootstrap.getBootstrap();
        const wanxiang = typeof window !== "undefined" && Boolean(window.centaurWorkspace);
        const currentRoute = readCurrentRoute(typeof window === "undefined" ? undefined : window.sessionStorage);
        const launchModeOverride = readLaunchModeOverride(typeof window === "undefined" ? undefined : window.location.search);
        const launchRouteOverride = readLaunchRouteOverride(typeof window === "undefined" ? undefined : window.location.search);
        const [sources, modelConfig, scanStatus] = await Promise.all([
          clients.agentSources.listSources(),
          clients.config.getModelConfig().catch(error => {
            console.warn("Unable to read workspace model configuration:", error);
            return null;
          }),
          clients.agentSources.getScanStatus()
        ]);
        const persistedPreferredMode = resolvePreferredLaunchMode({
          defaultLaunchMode: bootstrap.app.defaultLaunchMode,
          lastLaunchMode: bootstrap.app.lastLaunchMode
        });
        const defaultInitialPath = !wanxiang && (launchModeOverride ?? persistedPreferredMode) === "pet" ? "/pet" : "/main";
        const returnToWeChatSettings = isComputerHistorySupported() && await shouldReturnToWeChatSettings();
        const initialPath = resolveLaunchInitialView({
          defaultPath: defaultInitialPath,
          currentRoute,
          launchRouteOverride: launchRouteOverride ?? (isComputerHistorySupported() && (readHistoryPermissionSetup() || returnToWeChatSettings) && launchModeOverride !== "pet" ? "/memory" : null),
          launchModeOverride
        });

        if (!isActive) {
          return;
        }

        setClients(clients);
        setAnalyticsUserMode(bootstrap.app.userMode);
        dispatch(appActions.bootstrapLoaded(bootstrap, initialPath));
        dispatch(appActions.agentSourcesLoaded(sources));
        dispatch(appActions.agentSourceScanAvailability(scanStatus.unavailable ?? null));
        if (scanStatus.progress) {
          dispatch(appActions.agentSourceScanProgressReceived(scanStatus.progress));
        } else if (scanStatus.completion) {
          handleScanCompletion(scanStatus.completion, clients.agentSources);
        } else {
          dispatch(appActions.agentSourceScanStatusReceived(scanStatus));
        }
        const localNickname = readLocalNickname(typeof window === "undefined" ? undefined : window.localStorage);
        if (localNickname) dispatch(appActions.accountUpdated({ nickname: localNickname }));
        if (modelConfig) dispatch(appActions.modelConfigUpdated(modelConfig));
        dispatch(appActions.preferredModeUpdated(persistedPreferredMode));
        dispatch(appActions.eventStatusChanged("connecting"));

        events = createEventsConnection(runtimeConfig);
        events.addEventListener("app.connected", () => {
          dispatch(appActions.eventStatusChanged("connected"));
          void reconcileAgentSourceScanStatus(clients.agentSources);
        });
        events.addEventListener("app.heartbeat", () => {
          dispatch(appActions.eventStatusChanged("heartbeat"));
          if (isScanningRef.current || scanUnavailableRef.current || scanStateRef.current.scanProgress || scanStateRef.current.scanControl) {
            void reconcileAgentSourceScanStatus(clients.agentSources);
          }
        });
        events.addEventListener("agent_source.scan_progress", (event) => {
          const parsed = parseSseEvent(event);
          if (parsed?.type === "agent_source.scan_progress") {
            dispatch(appActions.agentSourceScanProgressReceived(parsed.payload));
          }
        });
        events.addEventListener("agent_source.scan_completed", (event) => {
          const parsed = parseSseEvent(event);
          if (parsed?.type !== "agent_source.scan_completed") {
            return;
          }
          const { results: scanResults, ...completion } = parsed.payload;
          const succeeded = completion.succeeded ?? scanResults.every((result) => (result.errorCount ?? result.errors.length) === 0 && result.errors.length === 0);
          handleScanCompletion({ ...completion, succeeded, completedAt: parsed.timestamp }, clients.agentSources, scanResults);
        });
        events.addEventListener("plugin.capability_event", (event) => {
          const parsed = parseSseEvent(event);
          if (parsed?.type === "plugin.capability_event") receivePluginEvent(parsed.payload);
        });
        events.addEventListener("plugin.capability_snapshot", (event) => {
          const parsed = parseSseEvent(event);
          if (parsed?.type === "plugin.capability_snapshot") reconcilePendingCalls(parsed.payload.calls);
        });
        events.onerror = () => dispatch(appActions.eventStatusChanged("reconnecting"));
      } catch (error) {
        if (!isActive) {
          return;
        }

        dispatch(appActions.startupFailed(error instanceof Error ? error.message : String(error)));
      }
    }

    void boot();

    return () => {
      isActive = false;
      events?.close();
    };
  }, [bootKey, dispatch, receivePluginEvent, reconcilePendingCalls, setClients]);

  return (
    <UpdateCoordinatorProvider>
      <AgentRuntimeBridge taskStateCoordinator={taskStateCoordinator ?? undefined}
        workspaceAuthorized={!wanxiang || wanxAccount?.phase === "authenticated"}>
        <NotificationCenterProvider>
        <AgentSourceScanReconciler />
          <AppRouter onRetry={retry} wanxAccount={wanxAccount} />
          <HistoryLaunchPromptHost />
        </NotificationCenterProvider>
      </AgentRuntimeBridge>
    </UpdateCoordinatorProvider>
  );
}

export function applyMainWindowRouteTarget(
  rawTarget: MainWindowRouteTarget,
  dispatch: (action: AppAction) => void,
  agentClient: Pick<MemmyAgentClient, "chatIdToSessionKey" | "readWebuiThread" | "getSessionSnapshot" | "readSidebarState"> | null = null,
  agentState?: Pick<AgentState, "sidebarStateVersion" | "runStatusVersionByChatId">,
  taskStateCoordinator?: Pick<AgentTaskStateCoordinator, "focusTask">
): void {
  const target = resolveMainWindowRouteTarget(rawTarget);
  if (target.route === "/main") {
    if (target.agentChatId && agentClient) {
      rememberFocusedAgentChat(null);
      if (taskStateCoordinator) {
        taskStateCoordinator.focusTask(target.agentChatId);
      } else {
        focusMainWindowAgentChat(target.agentChatId, agentClient, dispatch, agentState);
      }
    } else {
      rememberFocusedAgentChat(target.agentChatId);
    }
  }
  replaceRouteTargetHash(target.hash);

  if (target.route) {
    dispatch(appActions.navigate(target.route));
  }
}

let mainWindowRouteAgentRequestCounter = 0;

function focusMainWindowAgentChat(
  chatId: string,
  client: Pick<MemmyAgentClient, "chatIdToSessionKey" | "readWebuiThread" | "getSessionSnapshot" | "readSidebarState">,
  dispatch: (action: AppAction) => void,
  agentState?: Pick<AgentState, "sidebarStateVersion" | "runStatusVersionByChatId">
): void {
  mainWindowRouteAgentRequestCounter += 1;
  const sessionKey = client.chatIdToSessionKey(chatId);
  const historyRequestId = `main-route-${chatId}-${mainWindowRouteAgentRequestCounter}`;
  const sessionsRequestId = `main-route-sessions-${mainWindowRouteAgentRequestCounter}`;
  dispatch(agentActions.historyLoading(sessionKey, chatId, historyRequestId));
  dispatch(agentActions.taskStateLoading({
    requestId: sessionsRequestId,
    sidebarStateVersionAtStart: agentState?.sidebarStateVersion ?? 0,
    runStatusVersionAtStartByChatId: { ...(agentState?.runStatusVersionByChatId ?? {}) },
    recoveryGeneration: null
  }));

  void client
    .readWebuiThread(sessionKey)
    .then((thread) => {
      dispatch(agentActions.historyLoaded(thread, historyRequestId));
    })
    .catch((error: unknown) => {
      if (error instanceof MemmyAgentRequestError && error.status === 404) {
        dispatch(agentActions.historyLoaded({ schemaVersion: 1, sessionKey, messages: [] }, historyRequestId));
        return;
      }

      console.warn("focus main window agent chat history failed", error);
      dispatch(agentActions.historyOpenFailed(chatId, historyRequestId, createAgentOperationError({
        source: "history",
        message: error instanceof Error ? error.message : String(error),
        chatId
      })));
    });

  void Promise.allSettled([
    client.getSessionSnapshot({ timeoutMs: 10_000 }),
    client.readSidebarState()
  ])
    .then(([sessionsResult, sidebarResult]) => {
      const failures = [sessionsResult, sidebarResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      dispatch(agentActions.taskStateSettled({
        requestId: sessionsRequestId,
        recoveryGeneration: null,
        ...(sessionsResult.status === "fulfilled" ? { snapshot: sessionsResult.value } : {}),
        ...(sidebarResult.status === "fulfilled" ? { sidebarState: sidebarResult.value } : {}),
        ...(failures.length > 0 ? {
          error: createAgentOperationError({ source: "sessions", message: failures.join("; ") })
        } : {})
      }));
    });
}

function rememberFocusedAgentChat(agentChatId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (agentChatId) {
      window.sessionStorage.setItem(FOCUSED_AGENT_CHAT_STORAGE_KEY, agentChatId);
    } else {
      window.sessionStorage.removeItem(FOCUSED_AGENT_CHAT_STORAGE_KEY);
    }
  } catch {
    // Losing a focus hint is non-fatal; route navigation should continue.
  }
}

function replaceRouteTargetHash(hash: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const url = new URL(window.location.href);
    url.hash = hash ?? "";
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL cleanup should not block state-route navigation.
  }
}

/**
 * Parses the backend SSE event payload.
 *
 * @param event The EventSource callback event.
 * @returns An event that passes shared-contract validation; returns null for non-JSON or structural mismatches.
 */
function parseSseEvent(event: Event): SseEvent | null {
  if (!("data" in event) || typeof event.data !== "string") {
    return null;
  }

  try {
    return SseEventSchema.parse(JSON.parse(event.data));
  } catch {
    return null;
  }
}
