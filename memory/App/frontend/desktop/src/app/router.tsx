/** Router module. */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  PetGuideModal,
  readCloseMainWindowAction,
  readPetGuideCompleted,
  resolveCompletedMainWindowAction,
  resolvePetGuideChoice,
  shouldShowPetGuideForMainWindowAction,
  type MainWindowActionRoute,
  type MainWindowActionRequest,
  type MainWindowActionResolution,
  type PetGuideChoice
} from "./pet-guide.js";
import {
  ProductTourGuide,
  productTourIncludesLogs,
  productTourMemorySubPage,
  productTourStartMemorySubPage,
  productTourStartRoute,
  productTourTabRoute,
  type ProductTourDismissResult,
  type ProductTourStepInfo,
  type ProductTourTab
} from "./product-tour.js";
import { GlobalUpdateDialog } from "./update-coordinator.js";
import {
  clearDeferredGuidanceStep,
  clearProductTourStep,
  readCurrentRoute,
  readLaunchModeOverride,
  writeCurrentRoute,
  writeDeferredGuidanceStep,
  writeGuidanceCompleted,
  type AppRoutePath,
  type DeferredGuidanceStep
} from "./routes.js";
import { persistNickname } from "./nickname.js";
import { isWorkspacePromptSessionReady, isWorkspacePromptSurfaceReady } from "./workspace-prompt-readiness.js";
import { useGuidanceProgress } from "./use-guidance-progress.js";
import { useOptionalApiClients } from "./providers.js";
import { useAppState } from "../state/app-state.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import {
  buildOnboardingCompletedEvent,
  buildOnboardingStepCompletedEvent,
  buildProductTourStepEvent
} from "../analytics/onboarding-analytics.js";
import { buildRoutePageViewEvent, shouldDeferRoutePageView } from "../analytics/page-view.js";
import { appActions } from "../state/app-actions.js";
import { NicknameModal } from "../components/nickname-modal.js";
import { randomNickname } from "../lib/nickname.js";
import { useTranslation } from "../i18n/use-translation.js";
import {
  resolveWindowDragExclusionSelector,
  WindowDragRegion
} from "./window-drag-region.js";
import { HomePage } from "../pages/home-page.js";
import { hasMountedBrowserPanel, MEMMY_BROWSER_MOUNTED_EVENT, requestBrowserNewTab } from "../pages/browser-panel.js";
import { writeMemorySubPage } from "../pages/memory-sub-page-storage.js";
import { PetPage } from "../pages/pet-page.js";
import { PetStartupScreen } from "../pages/pet-startup-screen.js";
import { StartupScreen } from "../pages/startup-screen.js";
import { WanxPage, WanxSurface } from "../pages/wanx-page.js";

// These pages are not needed to show the startup, sign-in, or chat screens.
const MemoryPage = lazy(() => import("../pages/memory-page.js").then(({ MemoryPage }) => ({ default: MemoryPage })));
const SettingsPage = lazy(() => import("../pages/settings-page.js").then(({ SettingsPage }) => ({ default: SettingsPage })));

export function useWanxiangAccount(bridge: Window["centaurWorkspace"]) {
  const [account, setAccount] = useState<{ phase: "loading" | "signed_out" | "authenticated"; revision: number } | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const receive = (next: typeof account) => {
      if (active && next) setAccount(current => !current || current.revision <= next.revision ? next : current);
    };
    const unsubscribe = bridge.onWanxAccountChanged(receive);
    void bridge.getWanxAccount().then(receive, () => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return account;
}

function readWorkspaceGuidanceOverlay(step: DeferredGuidanceStep | null): Extract<DeferredGuidanceStep, "product_tour" | "nickname"> | null {
  return step === "product_tour" || step === "nickname" ? step : null;
}

/** Handles app router. */
export function AppRouter(props: { onRetry: () => void; wanxAccount?: ReturnType<typeof useWanxiangAccount> }) {
  const { state, dispatch } = useAppState();
  const wanxiang = typeof window === "undefined" ? undefined : window.centaurWorkspace;
  const wanxAccount = props.wanxAccount;
  const signedIn = wanxAccount?.phase === "authenticated";
  const previousWanxAccount = useRef<typeof wanxAccount>(null);
  useEffect(() => {
    if (!wanxAccount) return;
    const previous = previousWanxAccount.current;
    previousWanxAccount.current = wanxAccount;
    if (signedIn && previous && previous.phase !== "authenticated") dispatch(appActions.navigate("/main"));
  }, [wanxAccount, signedIn, dispatch]);
  const { clients } = useOptionalApiClients();
  const { track, ready: analyticsReady } = useAnalytics();
  const { language } = useTranslation();
  const prevPathRef = useRef<AppRoutePath | null>(null);
  const { deferredGuidanceStep } = useGuidanceProgress();
  const guidanceWorkspaceReady = !wanxiang && state.navigation.windowVisible !== false && isWorkspacePromptSurfaceReady({
    startupStatus: state.startup.status,
    currentPath: state.navigation.currentPath,
  }) && isWorkspacePromptSessionReady({
    userMode: state.bootstrap?.app.userMode,
    accountUserId: state.account.userId,
    byokConfigured: Boolean(state.modelConfig?.catalog?.modelAssignments.byok.agent.candidates.length),
    guidanceDone: true,
  });
  const workspaceGuidanceStep = guidanceWorkspaceReady ? readWorkspaceGuidanceOverlay(deferredGuidanceStep) : null;
  const [deferredNickname, setDeferredNickname] = useState("");
  const [petGuideRequest, setPetGuideRequest] = useState<MainWindowActionRequest | null>(null);
  const [preserveHomeBrowser, setPreserveHomeBrowser] = useState(false);
  const isPetWindowContext = isPetWindow(state.navigation.currentPath);
  const windowDragRegion = !isPetWindowContext ? (
    <WindowDragRegion
      dynamicExclusionSelector={resolveWindowDragExclusionSelector(state.navigation.currentPath)}
    />
  ) : null;

  const completeMainWindowAction = useCallback(
    (request: MainWindowActionRequest, resolution: MainWindowActionResolution) => {
      void window.memmy?.completeMainWindowAction?.({ id: request.id, resolution }).catch((error: unknown) => {
        console.warn("complete main window action failed", error);
      });
    },
    []
  );

  const handlePetGuideChoice = useCallback(
    (choice: PetGuideChoice) => {
      if (!petGuideRequest) {
        return;
      }

      const storage = typeof window === "undefined" ? undefined : window.localStorage;
      const { resolution } = resolvePetGuideChoice(
        storage,
        choice,
        petGuideRequest.action,
        resolveMainWindowActionRoute(state.navigation.currentPath)
      );
      setPetGuideRequest(null);
      completeMainWindowAction(petGuideRequest, resolution);
    },
    [completeMainWindowAction, petGuideRequest, state.navigation.currentPath]
  );

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.onMainWindowActionRequest || !bridge.completeMainWindowAction) {
      return;
    }

    return bridge.onMainWindowActionRequest((request) => {
      const storage = window.localStorage;
      const route = resolveMainWindowActionRoute(state.navigation.currentPath);
      if (shouldShowPetGuideForMainWindowAction(route, request.action, readPetGuideCompleted(storage))) {
        setPetGuideRequest(request);
        return;
      }

      completeMainWindowAction(
        request,
        resolveCompletedMainWindowAction(
          readCloseMainWindowAction(storage),
          request.action,
          route
        )
      );
    });
  }, [completeMainWindowAction, state.navigation.currentPath]);

  useEffect(() => {
    if (state.startup.status !== "ready") {
      return;
    }

    writeCurrentRoute(typeof window === "undefined" ? undefined : window.sessionStorage, state.navigation.currentPath);
  }, [state.navigation.currentPath, state.startup.status]);

  const currentPath = state.navigation.currentPath;
  useEffect(() => {
    const preserve = () => setPreserveHomeBrowser(true);
    window.addEventListener(MEMMY_BROWSER_MOUNTED_EVENT, preserve);
    if (hasMountedBrowserPanel()) preserve();
    return () => window.removeEventListener(MEMMY_BROWSER_MOUNTED_EVENT, preserve);
  }, []);
  useEffect(() => window.memmy?.onEmbeddedBrowserOpen?.((url, owner) => {
    requestBrowserNewTab(url, owner);
    setPreserveHomeBrowser(true);
  }), []);
  useEffect(() => {
    if (resolveMainWindowActionRoute(currentPath) === "auth") setPreserveHomeBrowser(false);
  }, [currentPath]);
  useEffect(() => {
    if (workspaceGuidanceStep === "nickname") {
      setDeferredNickname((current) => current || randomNickname(language));
    }
  }, [workspaceGuidanceStep, language]);

  useEffect(() => {
    if (!guidanceWorkspaceReady || deferredGuidanceStep !== "improvement") return;
    if (state.bootstrap?.app.userMode !== "byok" && state.bootstrap?.onboarding.improvementProgram === "unset") {
      // Memory has its own frame; the consent choice lives in the main workspace frame.
      if (currentPath !== "/main") dispatch(appActions.navigate("/main"));
      return;
    }
    // A resumed guide may belong to a previous mode or already have a consent decision.
    const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
    const includeLogs = productTourIncludesLogs(state.bootstrap?.onboarding.scanPermission);
    clearProductTourStep(storage);
    writeMemorySubPage(storage, productTourStartMemorySubPage(includeLogs));
    writeDeferredGuidanceStep(storage, "product_tour");
    dispatch(appActions.navigate(productTourStartRoute(includeLogs)));
  }, [currentPath, deferredGuidanceStep, dispatch, guidanceWorkspaceReady, state.bootstrap?.app.userMode,
    state.bootstrap?.onboarding.improvementProgram, state.bootstrap?.onboarding.scanPermission]);

  useEffect(() => {
    if (!analyticsReady) return;
    if (currentPath === prevPathRef.current) return;
    const referrer = prevPathRef.current;
    prevPathRef.current = currentPath;
    if (shouldDeferRoutePageView(currentPath)) {
      return;
    }

    track(buildRoutePageViewEvent(currentPath, referrer));
  }, [currentPath, track, analyticsReady]);

  function dismissProductTour(result: ProductTourDismissResult, info: ProductTourStepInfo) {
    const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
    const scanPermission = state.bootstrap?.onboarding.scanPermission;
    // Intermediate steps only emit viewed. Skip adds one skipped on the current step;
    // finishing the last CTA does not emit completed (nickname / onboarding_completed mark done).
    if (result === "skipped") {
      const tourEvent = buildProductTourStepEvent({
        tab: info.tourTab,
        choice: "skipped",
        scanPermission
      });
      if (tourEvent) {
        track(tourEvent);
      }
    }
    clearProductTourStep(storage);
    // Persist nickname step before navigating so the path-change effect does not
    // re-read stale `product_tour` and remount the tour on /tools.
    writeDeferredGuidanceStep(storage, "nickname");
    setDeferredNickname(randomNickname(language));
    dispatch(appActions.navigate("/main"));
  }

  function submitDeferredNickname() {
    void persistNickname({
      rawNickname: deferredNickname,
      language,
      isByok: state.bootstrap?.app.userMode === "byok",
      storage: typeof window === "undefined" ? undefined : window.localStorage,
      current: state.account,
      updateProfile: (nickname) => clients?.account.updateProfile({ nickname }) ?? Promise.resolve(null)
    }).then((update) => dispatch(appActions.accountUpdated(update)));
    const scanPermission = state.bootstrap?.onboarding.scanPermission;
    track(buildOnboardingStepCompletedEvent({
      step: "nickname",
      scanPermission
    }));
    // Full product guidance finished (permission → report? → tour → nickname).
    track(buildOnboardingCompletedEvent(scanPermission));
    writeGuidanceCompleted(typeof window === "undefined" ? undefined : window.localStorage);
    clearDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage);
  }

  if (state.startup.status === "loading" || state.startup.status === "idle") {
    if (isPetWindowContext) return <PetStartupScreen />;
    return (
      <>
        <StartupScreen quiet={hasReloadRestoreRoute()} />
        {windowDragRegion}
      </>
    );
  }

  if (state.startup.status === "error") {
    if (isPetWindowContext) return <PetStartupScreen message={state.startup.message} onRetry={props.onRetry} />;
    return (
      <>
        <StartupScreen message={state.startup.message} onRetry={props.onRetry} />
        {windowDragRegion}
      </>
    );
  }

  if (wanxiang && !signedIn) {
    return <><WanxSurface page="login" title="nav.login" />{windowDragRegion}</>;
  }

  const hasLegacyRecording = !wanxiang && (state.navigation.recordingRequestId > 0 || state.navigation.recordingStatus !== "idle");
  const keepHomeMounted = currentPath === "/main"
    || ((preserveHomeBrowser || hasLegacyRecording) && resolveMainWindowActionRoute(currentPath) === "workspace");
  return (
    <>
      {keepHomeMounted && (
        <div style={currentPath === "/main" ? { display: "contents" } : {
          position: "fixed", left: -10_000, top: 0, width: 800, height: 600,
          opacity: 0, pointerEvents: "none",
        }}
          aria-hidden={currentPath !== "/main"}>
          <HomePage />
        </div>
      )}
      {currentPath === "/main" ? null : (
        <Suspense fallback={<StartupScreen />}>
          {renderRoute(currentPath)}
        </Suspense>
      )}
      {windowDragRegion}
      {workspaceGuidanceStep === "product_tour" && (
        <ProductTourGuide
          includeLogs={productTourIncludesLogs(state.bootstrap?.onboarding.scanPermission)}
          onDismiss={dismissProductTour}
          onStepViewed={(info) => {
            const tourEvent = buildProductTourStepEvent({
              tab: info.tourTab,
              choice: "viewed",
              scanPermission: state.bootstrap?.onboarding.scanPermission
            });
            if (tourEvent) {
              track(tourEvent);
            }
          }}
          onTabChange={(tab: ProductTourTab) => {
            const memorySubPage = productTourMemorySubPage(tab);
            if (memorySubPage) {
              writeMemorySubPage(typeof window === "undefined" ? undefined : window.sessionStorage, memorySubPage);
            }
            dispatch(appActions.navigate(productTourTabRoute(tab)));
          }}
        />
      )}
      {workspaceGuidanceStep === "nickname" && (
        <NicknameModal
          open
          nickname={deferredNickname}
          onNicknameChange={setDeferredNickname}
          onShuffle={() => setDeferredNickname(randomNickname(language))}
          onSubmit={submitDeferredNickname}
        />
      )}
      {petGuideRequest && <PetGuideModal onChoice={handlePetGuideChoice} />}
      <GlobalUpdateDialog
        suspended={
          isPetWindowContext
          || Boolean(petGuideRequest)
          || workspaceGuidanceStep === "product_tour"
          || workspaceGuidanceStep === "nickname"
        }
      />
    </>
  );
}

/** Checks is pet window. */
function isPetWindow(path: AppRoutePath): boolean {
  const launchModeOverride = readLaunchModeOverride(typeof window === "undefined" ? undefined : window.location.search);
  return launchModeOverride === "pet" || path === "/pet";
}

export function resolveMainWindowActionRoute(path: AppRoutePath): MainWindowActionRoute {
  switch (path) {
    case "/welcome":
    case "/login":
      return "login";
    case "/token-detail":
    case "/api-key":
    case "/api-key-models":
    case "/api-key-optional":
    case "/onboarding":
      return "auth";
    default:
      return "workspace";
  }
}

function hasReloadRestoreRoute(): boolean {
  return Boolean(readCurrentRoute(typeof window === "undefined" ? undefined : window.sessionStorage));
}

/** Renders render route. */
function renderRoute(path: AppRoutePath) {
  switch (path) {
    case "/star-map":
    case "/space":
    case "/boxes":
      return <WanxPage route={path} />;
    case "/wanx-account":
      return <SettingsPage initialTab="account" />;
    case "/memory":
      return <MemoryPage />;
    case "/memory-sources":
      return <MemoryPage initialSubPage="sources" />;
    case "/settings":
      return <SettingsPage />;
    case "/pet":
      return <PetPage />;
    case "/main":
    default:
      return <HomePage />;
  }
}

/** Handles resolve product tour path. */
export function resolveProductTourPath(tab: ProductTourTab): AppRoutePath {
  return productTourTabRoute(tab);
}
