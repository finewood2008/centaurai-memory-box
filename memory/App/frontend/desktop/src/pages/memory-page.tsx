import {usePanelPrefetch} from "./memory/use-panel-prefetch.js";
import {PanelVisibilityContext} from "./memory/panel-visibility.js";
import type { TokenUsageDto } from "@memmy/local-api-contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildMemorySubPageViewEvent } from "../analytics/page-view.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { useApiClients } from "../app/providers.js";
import { isComputerHistorySupported } from "../app/computer-history-platform.js";
import { onComputerHistoryLaunchEnable } from "../app/computer-history-launch-intent.js";
import {
  PRODUCT_TOUR_MEMORY_LOGS_NAV_ANCHOR,
  PRODUCT_TOUR_MEMORY_OVERVIEW_NAV_ANCHOR,
  PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR
} from "../app/product-tour-layout.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { CentaurDesktopHeader } from "../components/centaur-desktop-header.js";
import { isWindowsDesktopPlatform } from "../utils/window-fullscreen.js";
import { AppContentTopbar } from "./app-content-topbar.js";
import { writeSettingsMemoryBudgetFocus, writeSettingsTabHash } from "./settings-nav.js";
import { MEMORY_SUB_PAGE_STORAGE_KEY, writeMemorySubPage, type MemorySubPageId } from "./memory-sub-page-storage.js";
import { SidebarResizeHandle, useCodexResizableSidebar } from "./sidebar-resize.js";
import { AnalyticsSubPage } from "./memory/analytics-sub-page.js";
import { readHistoryPermissionSetup } from "./memory/computer-history-permission-state.js";
import { readWeChatPermissionReturn } from "./memory/computer-history-wechat-permission-state.js";
import { isComputerHistoryQuotaExhausted, useComputerHistoryQuotaRefresh } from "./memory/computer-history-quota.js";
import { ComputerHistorySubPage } from "./memory/computer-history-sub-page.js";
import { openObservationHistorySource } from "./memory/observed-memory-detail.js";
import { LogsSubPage } from "./memory/logs-sub-page.js";
import {
  resolveMemoryReferencePage,
  type MemoryReferenceOpenRequest,
  type MemoryReferencePage,
  type OpenMemoryReference
} from "./memory/memory-reference-tags.js";
import { MemoriesSubPage } from "./memory/memories-sub-page.js";
import { OverviewSubPage } from "./memory/overview-sub-page.js";
import { PoliciesSubPage } from "./memory/policies-sub-page.js";
import { SkillsSubPage } from "./memory/skills-sub-page.js";
import { SourcesSubPage } from "./memory/sources-sub-page.js";
import { TasksSubPage } from "./memory/tasks-sub-page.js";
import { UserMemoriesSubPage } from "./memory/user-memories-sub-page.js";
import { WorldModelSubPage } from "./memory/world-model-sub-page.js";
import {
  BarChart3,
  BrainCircuit,
  Globe2,
  Layers,
  Link2,
  ListChecks,
  ScrollText,
  Sparkles,
  UserRound,
  Wand2
} from "./memory/memory-prototype-icons.js";

export { writeMemorySubPage } from "./memory-sub-page-storage.js";
export type { MemorySubPageId } from "./memory-sub-page-storage.js";

interface MemoryNavSection {
  titleKey: MessageKey;
  items: MemoryNavItem[];
}

interface MemoryNavItem {
  id: MemorySubPageId;
  labelKey: MessageKey;
  icon: ReactNode;
}

const memoryNavSections: MemoryNavSection[] = [
  {
    titleKey: "memory.nav.work",
    items: [
      { id: "overview", labelKey: "memory.nav.overview", icon: <Layers size={16} /> },
      { id: "memories", labelKey: "memory.nav.memory", icon: <BrainCircuit size={16} /> },
      { id: "tasks", labelKey: "memory.nav.tasks", icon: <ListChecks size={16} /> },
      { id: "policies", labelKey: "memory.nav.policies", icon: <Sparkles size={16} /> },
      { id: "world-model", labelKey: "memory.nav.worldModel", icon: <Globe2 size={16} /> },
      { id: "skills", labelKey: "memory.nav.skills", icon: <Wand2 size={16} /> },
      { id: "user-memories", labelKey: "memory.nav.userMemories", icon: <UserRound size={16} /> }
    ]
  },
  {
    titleKey: "memory.nav.insights",
    items: [
      { id: "analytics", labelKey: "memory.nav.analytics", icon: <BarChart3 size={16} /> },
      { id: "logs", labelKey: "memory.nav.logs", icon: <ScrollText size={16} /> }
    ]
  },
  {
    titleKey: "memory.nav.system",
    items: [
      { id: "computer-history", labelKey: "memory.nav.computerHistory", icon: <ScrollText size={16} /> },
      { id: "sources", labelKey: "memory.sourcesNav", icon: <Link2 size={16} /> }
    ]
  }
];

export interface MemoryPageProps {
  initialSubPage?: MemorySubPageId;
  hideSources?: boolean;
  onOpenSettings?: (section: "models" | "budget" | "sources") => void;
}

export function MemoryPage(props: MemoryPageProps) {
  const { t } = useTranslation();
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const { track, ready: analyticsReady } = useAnalytics();
  const prevSubPageRef = useRef<MemorySubPageId | null>(null);
  const referenceRequestIdRef = useRef(0);
  const [selectedPage, setActivePage] = useState<MemorySubPageId>(() => props.initialSubPage ?? (isComputerHistorySupported() && (readHistoryPermissionSetup() || readWeChatPermissionReturn()) ? "computer-history" : readInitialMemorySubPage()));
  // Stored selections, URL parameters and explicit navigation must all obey the
  // same platform gate before mounting a page with polling/permission effects.
  const activePage = supportedMemorySubPage(selectedPage, props.hideSources);
  const [referenceRequest, setReferenceRequest] = useState<(MemoryReferenceOpenRequest & { page: MemoryReferencePage }) | null>(null);
  const client = clients?.memoryRuntime ?? null;
  usePanelPrefetch(client,activePage);
  // Release the old scope before newly mounted children start passive loads.
  useLayoutEffect(()=>()=>client?.resetPanelView?.(),[client]);
  const historyQuotaExhausted = isComputerHistoryQuotaExhausted(state?.bootstrap);
  const onHistoryQuotaUpdate = useCallback((usage: TokenUsageDto) => {
    dispatch(appActions.tokenUsageUpdated(usage));
  }, [dispatch]);
  useComputerHistoryQuotaRefresh({
    enabled: activePage === "computer-history" && state?.bootstrap?.app.userMode === "account",
    client: clients?.config ?? null,
    onUpdate: onHistoryQuotaUpdate,
  });

  const handleSubPageChange = useCallback((page: MemorySubPageId) => {
    setReferenceRequest(null);
    setActivePage(page);
  }, []);

  useEffect(() => onComputerHistoryLaunchEnable(() => {
    setReferenceRequest(null);
    setActivePage("computer-history");
  }), []);

  const handleOpenMemoryReference = useCallback<OpenMemoryReference>((id, fallbackPage) => {
    const page = resolveMemoryReferencePage(id, fallbackPage);
    setReferenceRequest({ id, page, requestId: ++referenceRequestIdRef.current });
    setActivePage(page);
  }, []);

  useEffect(() => {
    if (!analyticsReady || props.onOpenSettings) {
      return;
    }

    const referrerSubPage = prevSubPageRef.current;
    prevSubPageRef.current = activePage;
    if (referrerSubPage === activePage) {
      return;
    }

    track(buildMemorySubPageViewEvent(activePage, referrerSubPage));
  }, [activePage, analyticsReady, props.onOpenSettings, track]);

  const childByPage = useMemo<Record<MemorySubPageId, ReactNode>>(
    () => ({
      overview: <OverviewSubPage client={client} onNavigate={handleSubPageChange} />,
      "computer-history": (
        <ComputerHistorySubPage
          client={clients?.memmyAgent ?? null}
          memoryClient={client}
          quotaExhausted={historyQuotaExhausted}
          onOpenSkill={(skillId) => handleOpenMemoryReference(skillId, "skills")}
          onOpenMemory={(memoryId) => handleOpenMemoryReference(memoryId, "memories")}
        />
      ),
      memories: (
        <MemoriesSubPage
          client={client}
          openRequest={referenceRequest?.page === "memories" ? referenceRequest : undefined}
          onOpenHistorySource={clients?.memmyAgent ? (historyId) => openObservationHistorySource(clients.memmyAgent, historyId, t("memory.memories.historySourceUnavailable")) : undefined}
          onOpenSettings={() => {
            if (props.onOpenSettings) return props.onOpenSettings("models");
            writeSettingsTabHash("model");
            dispatch(appActions.navigate("/settings"));
          }}
        />
      ),
      "user-memories": <UserMemoriesSubPage client={client} />,
      tasks: <TasksSubPage client={client} openRequest={referenceRequest?.page === "tasks" ? referenceRequest : undefined} />,
      policies: (
        <PoliciesSubPage
          client={client}
          openRequest={referenceRequest?.page === "policies" ? referenceRequest : undefined}
          onOpenMemoryReference={handleOpenMemoryReference}
        />
      ),
      "world-model": (
        <WorldModelSubPage
          client={client}
          openRequest={referenceRequest?.page === "world-model" ? referenceRequest : undefined}
          onOpenMemoryReference={handleOpenMemoryReference}
        />
      ),
      skills: (
        <SkillsSubPage
          client={client}
          openRequest={referenceRequest?.page === "skills" ? referenceRequest : undefined}
          onOpenMemoryReference={handleOpenMemoryReference}
        />
      ),
      analytics: <AnalyticsSubPage client={client} />,
      logs: <LogsSubPage client={client} />,
      sources: <SourcesSubPage onOpenSettings={props.onOpenSettings ? () => props.onOpenSettings?.("sources") : undefined} />
    }),
    [client, clients?.memmyAgent, dispatch, handleOpenMemoryReference, handleSubPageChange, referenceRequest, historyQuotaExhausted, props.onOpenSettings, t]
  );

  useEffect(() => {
    if (props.initialSubPage) {
      setReferenceRequest(null);
      setActivePage(props.initialSubPage);
      return;
    }
    const stored = typeof window === "undefined" ? null : readMemorySubPage(window.sessionStorage);
    if (stored) {
      setActivePage(stored);
    }
  }, [props.initialSubPage]);

  useEffect(() => {
    writeMemorySubPage(typeof window === "undefined" ? undefined : window.sessionStorage, activePage);
  }, [activePage]);

  return (
    <MemoryPageView
      embedded={Boolean(props.onOpenSettings)}
      hideSources={props.hideSources}
      activePage={activePage}
      onActivePageChange={handleSubPageChange}
      onNavigate={(path) => dispatch(appActions.navigate(path))}
      onOpenMemoryBudgetSettings={() => props.onOpenSettings ? props.onOpenSettings("budget") : dispatch(appActions.navigate("/settings"))}
      childByPage={childByPage}
    />
  );
}

function readInitialMemorySubPage(): MemorySubPageId {
  if (typeof window === "undefined") {
    return "overview";
  }

  const page = new URLSearchParams(window.location.search).get("memoryPage");
  return isMemorySubPageId(page) ? page : readMemorySubPage(window.sessionStorage) ?? "overview";
}

function isMemorySubPageId(value: string | null): value is MemorySubPageId {
  return Boolean(value && memoryNavSections.some((section) => section.items.some((item) => item.id === value)));
}

function supportedMemorySubPage(page: MemorySubPageId, hideSources?: boolean): MemorySubPageId {
  if (page === "sources" && hideSources) return "overview";
  if (page === "computer-history" && !isComputerHistorySupported()) return "overview";
  return page;
}

export function readMemorySubPage(storage: Storage | undefined): MemorySubPageId | null {
  const value = storage?.getItem(MEMORY_SUB_PAGE_STORAGE_KEY) ?? null;
  return isMemorySubPageId(value) ? value : null;
}

function resolveMemoryNavTourAnchor(page: MemorySubPageId): string | undefined {
  switch (page) {
    case "logs":
      return PRODUCT_TOUR_MEMORY_LOGS_NAV_ANCHOR;
    case "overview":
      return PRODUCT_TOUR_MEMORY_OVERVIEW_NAV_ANCHOR;
    case "sources":
      return PRODUCT_TOUR_MEMORY_SOURCES_NAV_ANCHOR;
    default:
      return undefined;
  }
}

export interface MemoryPageViewProps {
  embedded?: boolean;
  hideSources?: boolean;
  activePage: MemorySubPageId;
  onActivePageChange: (page: MemorySubPageId) => void;
  onNavigate?: React.ComponentProps<typeof CentaurDesktopHeader>["onNavigate"];
  onOpenMemoryBudgetSettings?: () => void;
  childByPage?: Record<MemorySubPageId, ReactNode>;
}

export function MemoryPageView(props: MemoryPageViewProps) {
  const { t } = useTranslation();
  const activePage = supportedMemorySubPage(props.activePage, props.hideSources);
  const navSections = memoryNavSections.map(section => ({
    ...section,
    items: section.items.filter(item => supportedMemorySubPage(item.id, props.hideSources) === item.id)
  })).filter(section => section.items.length > 0);
  const retainedPages=new Set<MemorySubPageId>(["memories","tasks","policies","world-model","skills","user-memories","overview","analytics"]);
  const [visited,setVisited]=useState<MemorySubPageId[]>(retainedPages.has(activePage)?[activePage]:[]);
  useEffect(()=>{if(retainedPages.has(activePage))setVisited(current=>current.includes(activePage)?current:[...current,activePage]);},[activePage]);
  const childByPage = props.childByPage ?? createPreviewChildByPage(t);
  const windowsChrome = isWindowsDesktopPlatform();
  const sidebarResize = useCodexResizableSidebar("memmy.memory.sidebarWidth.codex.v3");

  return (
    <div className={`centaur-desktop-shell sidebar-shell flex h-screen bg-canvas-oat/40${windowsChrome && !props.embedded ? " sidebar-shell--windows-titlebar" : ""}`}>
      {!props.embedded && <CentaurDesktopHeader active="/memory" onNavigate={props.onNavigate} sidebarHidden={false} />}
      <div className="sidebar-shell__body">
      <aside
        className="memory-page-sidebar pb-4 overflow-y-auto shrink-0"
        style={sidebarResize.sidebarStyle}
      >
        {navSections.map((section) => (
          <div key={section.titleKey} className="mb-4">
            <div className="memory-page-section-header">
              <span className="memory-page-section-label text-text-ink/45">{t(section.titleKey)}</span>
            </div>
            <nav className="space-y-1">
              {section.items.map((item) => {
                const active = activePage === item.id;
                return (
                  <div key={item.id}>
                    <button
                      type="button"
                      data-tour-anchor={resolveMemoryNavTourAnchor(item.id)}
                      onClick={() => props.onActivePageChange(item.id)}
                      className={`app-frame-nav-button relative flex items-center gap-2.5 px-3 py-2 transition-all cursor-pointer ${
                        active
                          ? "app-frame-nav-button--active"
                          : "text-text-ink/75 hover:bg-canvas-oat/60 hover:text-text-ink/85"
                      }`}
                    >
                      <span className="shrink-0">{item.icon}</span>
                      <span className="flex-1 text-left">{t(item.labelKey)}</span>
                    </button>
                  </div>
                );
              })}
            </nav>
          </div>
        ))}
      </aside>
      <SidebarResizeHandle
        label={t("memory.resizeSidebar")}
        width={sidebarResize.width}
        minWidth={sidebarResize.minWidth}
        maxWidth={sidebarResize.maxWidth}
        isResizing={sidebarResize.isResizing}
        onResizeStart={sidebarResize.beginResize}
        onResizeBy={sidebarResize.resizeBy}
      />
      <div
        className="memory-page-main min-w-0 flex-1 flex flex-col overflow-hidden bg-content-bg"
      >
        <AppContentTopbar
          onOpenMemoryBudgetSettings={() => {
            if (!props.embedded) writeSettingsMemoryBudgetFocus();
            props.onOpenMemoryBudgetSettings?.();
          }}
        />
        <div className="app-frame-page-content min-h-0 flex-1 overflow-y-auto py-6">{[...new Set([...visited,activePage])].map(page=><PanelVisibilityContext.Provider value={page===activePage} key={page}><div hidden={page!==activePage}>{childByPage[page]}</div></PanelVisibilityContext.Provider>)}</div>
      </div>
      </div>
    </div>
  );
}

/**
 * Creates lightweight sub-page nodes for tests and documentation previews.
 *
 * @param t The translation function.
 * @returns A map of sub-page preview nodes.
 */
function createPreviewChildByPage(t: (key: MessageKey) => string): Record<MemorySubPageId, ReactNode> {
  return {
    overview: <div>{t("memory.overview.total")}</div>,
    "computer-history": <div>{t("memory.nav.computerHistory")}</div>,
    memories: <div>{t("memory.memories.title")}</div>,
    "user-memories": <div>{t("memory.userMemories.title")}</div>,
    tasks: <div>{t("memory.tasks.title")}</div>,
    policies: <div>{t("memory.policies.title")}</div>,
    "world-model": <div>{t("memory.worldModel.title")}</div>,
    skills: <div>{t("memory.skills.title")}</div>,
    analytics: <div>{t("memory.analytics.title")}</div>,
    logs: <div>{t("memory.logs.title")}</div>,
    sources: <div>{t("memory.sourcesTitle")} {t("memory.scan")}</div>
  };
}
