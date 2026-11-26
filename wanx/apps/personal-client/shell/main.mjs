import {createPersonalWorkshop} from './personal-workshop.mjs';
import {createLocalEncryption} from "../account/local-encryption.mjs";
import {createPersonalDataService} from "./personal-data-service.mjs";
import {createStarlinkPanelService} from "./starlink-panel-service.mjs";
import { mainWindowBounds } from "./window-layout.mjs";
import { readAvatar } from "./avatar.mjs";
import { createCreditsReader } from "../account/credits.mjs";
import { createCreditWallet } from "../account/credit-wallet.mjs";
import { createRemoteSupport } from "../account/support.mjs";
import { createApplicationBackend } from "../applications/backend.mjs";
import { createApplicationReleaseAccess } from "../applications/release-access.mjs";
import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  safeStorage as osSafeStorage,
  clipboard,
  powerMonitor,
  session,
  shell,
  Menu,
  Tray,
  nativeImage,
  net,
  protocol,
  dialog,
  screen,
} from "electron";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createClient } from "../client.mjs";
import { createNetwork } from "../network/index.mjs";
import { createSidecar } from "../network/sidecar.mjs";
import { nativeBinaryPaths } from "./native-binaries.mjs";
import { registerControlActions, openConnectedDashboard } from "./control.mjs";
import { createDashboardWindows } from "./dashboard.mjs";
import { APP_ICON, DESKTOP_NAME, createDesktopIntegration } from "./desktop.mjs";
import { claimSingleInstance } from "./instance.mjs";
import { createQuitRequest, registerShutdown } from "./shutdown.mjs";
import { createFaqCache } from "../account/faq-cache.mjs";
import { createAccount, DEFAULT_CONSUMER_URL } from "../account/index.mjs";
import { createSetupRuntime } from "./setup.mjs";
import { createSecureAccountStore } from "../account/store.mjs";
import { createLocalBoxes } from "../octop/local-boxes.mjs";
import { createPlatformClient } from "../platform.mjs";
import { createApplicationManager } from "../applications/manager.mjs";
import { createApplicationMarket } from "../applications/market.mjs";
import { createDefaultApplicationDelivery } from "../applications/delivery.mjs";
import { createDefaultApplicationScheduler } from "../applications/delivery-scheduler.mjs";
import { runManagedApplication } from "../applications/runtime.mjs";
import { createMarketSessionGuard } from "./market-session.mjs";
import { monitorNetworkChanges } from "./network-monitor.mjs";
import { createTimingRecorder } from "./timings.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";
import { createStaticAssetCache } from "../octop/static-cache.mjs";
import { createUIState } from "./ui-state.mjs";
import { createUIBroadcast, sendToLiveFrame } from "./ui-broadcast.mjs";
import { createNotificationCenter } from "./notification-center.mjs";
import { createAIDialogue } from "./ai-dialogue.mjs";
import { createZhijunMemmyRead } from "./zhijun-memmy.mjs";
import { createZhijunSourceReader, openZhijunSource } from "./zhijun-sources.mjs";
import { dataInteractionKey, dataOwnerKey } from "../device-trust/data-context.mjs";
import { createStartupSettings } from "./startup.mjs";
import { createSpaceLinkBridge } from "./space-links.mjs";
import {createSuperClipboard} from "./super-clipboard.mjs";
import {createSystemClipboard} from "./system-clipboard.mjs";
import { createPersonalSpace } from "./personal-space.mjs";
import { createAdvertisementNames } from "./discovery-names.mjs";
import { protectPrivateDirectory, protectPrivateFile } from "./private-storage.mjs";
import { readClientIdentity, installationIdentity } from "../updates/identity.mjs";
import { createUpdateStore } from "../updates/store.mjs";
import { createClientUpdates } from "../updates/client-service.mjs";
import { createUpdateChecks } from "./update-checks.mjs";
import { createBoxUpdates } from "../updates/box-service.mjs";
import { createElectronUpdateAdapter } from "../updates/electron.mjs";
import { createDeviceTrustCoordinator } from "../device-trust/coordinator.mjs";
import { createIdentityVault } from "../device-trust/identity-vault.mjs";
import { createLocalDataAccess } from "../device-trust/data-session.mjs";
import { createRecoveryFiles } from "./recovery-files.mjs";
import { createBackupFiles } from "./backup-files.mjs";
import { createDeviceTrustWindow } from "./device-trust-window.mjs";
import { createOfflineWifiTransport } from "./offline-wifi-transport.mjs";
import { registerDeviceTrustLifecycle } from "./device-trust-lifecycle.mjs";
import { createMemoryWorkspace, MEMORY_SCHEME, resolveMemoryRuntimeFile } from "./memory-workspace.mjs";
import { createMemoryRuntimeSupervisor, resolveManagedMemorySource } from "./local-memory-runtime.mjs";
import { readBackupSourceBinding } from "./memory-backup-identity.mjs";
import { memoryLibraryRuntime, readMemoryLibrary } from "./memory-source-profile.mjs";
import { createCodexModelConfig } from "./my-ai-codex-model-config.mjs";
import { createBoxCloudTransport, createMyAiCloudRoutes } from "./my-ai-cloud-route.mjs";
import { createMyAiTask } from "./my-ai-task.mjs";
import { createMyAiCollaboration } from "./my-ai-collaboration.mjs";
import { createCollaborationSources } from "./my-ai-collaboration-sources.mjs";
import { createCollaborationModels } from "./my-ai-collaboration-models.mjs";
import { createMyAiLauncher } from "./my-ai-launch.mjs";
import { createMyAiInstallations } from "./my-ai-install.mjs";
import { createMyAiMemoryTransfer } from "./my-ai-memory-transfer.mjs";
import { createClaudeChatHistoryImport } from "./claude-chat-history-import.mjs";
import { createCodexContext } from "./codex-context.mjs";
import { createCodexContextConfig, findCodexCli } from "./codex-context-config.mjs";
import { detectWindowsCodex, openWindowsCodex } from "./windows-codex.mjs";
import { createCodexContextSources } from "./codex-context-sources.mjs";
import { spaceVolumeRequest } from "./accessory-nas.mjs";
import { ACCESSORY_SCHEME, createAccessoriesPreview } from "./accessories-preview.mjs";
import { createSemanticaMcpClient } from "./semantica-mcp-client.mjs";
import { createMyAiAccess, createMyAiMemoryAccess } from "./my-ai-access.mjs";
import { configurableAgents, createMyAiMcpConfig } from "./my-ai-mcp-config.mjs";
import { createAnnotationModelClient } from "./annotation-model-client.mjs";

import { testPackageIdentity, TEST_APP_ID, TEST_PRODUCT_NAME } from "../updates/test-build.mjs";
import { createTestUpdateRuntime } from "../updates/test-runtime.mjs";

const packagedManifest = app.isPackaged ? JSON.parse(readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")) : null;
const testBuild = packagedManifest ? testPackageIdentity(packagedManifest) : null;
const cloudPilot = packagedManifest?.wanxCloudCliPilot === true;
if (cloudPilot) {
  const pilotData = path.join(app.getPath("appData"), "MemoBox Cloud CLI Pilot");
  mkdirSync(pilotData, { recursive: true, mode: 0o700 });
  app.setPath("userData", pilotData);
}
const windowName = cloudPilot ? "记忆盒子 · 云模型验收版" : testBuild ? TEST_PRODUCT_NAME : DESKTOP_NAME;
const collaborationModels = process.env.MEMOBOX_COLLAB_PILOT === "1" ? createCollaborationModels() : null;
if (collaborationModels) {
  for (const provider of collaborationModels.recipients)
    delete process.env["MEMOBOX_COLLAB_" + provider.id.toUpperCase() + "_KEY"];
}
const controlURL = new URL("../local-ui/renderer/index.html", import.meta.url).href;
protocol.registerSchemesAsPrivileged([MEMORY_SCHEME, ACCESSORY_SCHEME].map(scheme => ({ scheme, privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} })));
if (!testBuild && process.env.WANX_SMOKE_USER_DATA) {
  const isolated = path.resolve(process.env.WANX_SMOKE_USER_DATA);
  mkdirSync(isolated, { recursive: true });
  app.setPath("userData", isolated);
}
let control;
let uiState;
let broadcast;
let notifications;
let aiDialogue, personalDataService, personalWorkshop, starlinkPanel;
let client;
let unsubscribe;
let setupRuntime;
let applications;
let personalSpace;
let annotationModels;
let superClipboard;
let spaceLinks;
let marketSession;
let dashboards;
let desktop;
let stopNetworkMonitor;
let timings;
let terminalConsoleRequested = process.argv.includes("--wanx-console");
function openTerminalConsole() {
  if (!terminalConsoleRequested || !client || !dashboards || client.snapshot().phase !== "ready") return;
  terminalConsoleRequested = false;
  void Promise.resolve().then(() => openConnectedDashboard(client, dashboards)).catch(reportError);
}
function terminalCommand(argv) {
  if (!Array.isArray(argv) || !argv.includes("--wanx-console")) return false;
  terminalConsoleRequested = true;
  openTerminalConsole();
  return true;
}
let updates;
let shutdown;

// Local diagnostics contain fixed steps and allowlisted codes; console output is opt-in.
async function timed(step, operation) {
  return timings ? timings.run(step, operation) : operation();
}

function reportError(error) {
  console.error("[wanx-client]", error.message);
}

async function marketTrustedKeys() {
  const trust = JSON.parse(await readFile(new URL("../applications/market-trust.json", import.meta.url), "utf8"));
  return trust.keys;
}

// Do not await readiness at ESM top level: Electron waits for the entry module
// to finish evaluating before emitting ready.
// Keep Electron's existing name/data/keychain identity; branding lives in the
// bundle, About panel and menus. Match the installer identity on Windows.
if (process.platform === "win32") app.setAppUserModelId(testBuild ? TEST_APP_ID : "ai.centuarai.wanx.client");
if (process.argv.includes("--wanx-managed-app")) {
  marketTrustedKeys().then(trustedKeys => runManagedApplication({
    applicationRoot: process.env.WANX_HOST_APPLICATION_ROOT || path.join(app.getPath("userData"), "applications"), trustedKeys, app,
  })).catch(error => {
    reportError(error);
    process.send?.({ type: "wanx:application-failed", launchId: process.env.WANX_HOST_LAUNCH_ID }, () => {});
    app.exit(1);
  });
} else if (claimSingleInstance(app, () => desktop ? {
  isDestroyed: () => false, isMinimized: () => false,
  show: () => desktop.showManagement(), focus() {},
} : control, terminalCommand))
  app
    .whenReady()
    .then(async () => {
      const nativePaths = nativeBinaryPaths({ appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath, packaged: app.isPackaged });
      const userData = app.getPath("userData");
      const safeStorage = process.platform === "darwin" ? createLocalEncryption({directory:userData,legacyStorage:osSafeStorage}) : osSafeStorage;
      await protectPrivateDirectory(userData, { packaged: app.isPackaged });
      if (process.argv.includes("--wanx-smoke-safe-storage")) {
        const smokeFile = path.join(userData, "smoke-account.enc");
        const smokeStore = createSecureAccountStore({ filePath: smokeFile, safeStorage });
        const marker = { smoke: "wanx-dpapi-roundtrip" };
        try {
          await smokeStore.save(marker);
          if (JSON.stringify(await smokeStore.load()) !== JSON.stringify(marker))
            throw new Error("WANX_SMOKE_STORAGE_MISMATCH");
          await writeFile(path.join(userData, "smoke-storage-ready.marker"), "ready");
        } finally {
          await smokeStore.clear();
          app.quit();
        }
        return;
      }
      timings = createTimingRecorder({
        filePath: path.join(userData, "logs", "connection-timings.jsonl"),
        consoleOutput: process.env.WANX_CONNECTION_TIMINGS === "1",
      });
      const staticCache = createStaticAssetCache({
        directory: path.join(userData, "static-assets"),
      });
      const binaryPath = nativePaths.engine;
      let updateIdentity = null, updateChecks = null;
      const account = createAccount({
        getClientUpdateContext: () => updateIdentity,
        onClientUpdateRequired: () => { void updateChecks?.checkNow(); },
        measure: timed,
        onGrantTiming: details => timings.grantResponse(details),
        ...(process.env.WANX_CONSUMER_URL
          ? { baseURL: process.env.WANX_CONSUMER_URL }
          : {}),
        store: createSecureAccountStore({
          filePath: path.join(userData, "account.enc"),
          safeStorage,
        }),
        deviceModel: os.hostname(),
      });
      let creditsServiceURL = process.env.WANX_CREDITS_URL || "";
      if (!creditsServiceURL) {
        try {
          const file = path.join(userData, "credits-service.json");
          const info = await lstat(file);
          if (!info.isFile() || info.size > 4096 || (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077))))
            throw new Error("CREDITS_INVALID_CONFIG");
          const config = JSON.parse(await readFile(file, "utf8"));
          if (config.version !== 1 || typeof config.serviceURL !== "string") throw new Error("CREDITS_INVALID_CONFIG");
          creditsServiceURL = config.serviceURL;
        } catch (error) { if (error.code !== "ENOENT") reportError(new Error("CREDITS_INVALID_CONFIG")); }
      }
      const requestAccount = account.request;
      account.request = (input) => {
        const step =
          {
            "/app-api/network/boxes": "boxes.read",
            "/app-api/network/boxes/prepare": "boxes.prepare",
            "/app-api/network/restore": "network.restore",
            "/app-api/network/enrollments": "network.enroll",
            "/app-api/network/devices": "network.devices",
          }[input.path] ||
          (/^\/app-api\/network\/enrollments\/[\w-]+$/.test(input.path)
            ? "network.confirm"
            : /\/wanx\/sso-grants$/.test(input.path)
            ? "box.grant"
            : null);
        return step
          ? timed(step, () => requestAccount(input))
          : requestAccount(input);
      };
      const localVault = createIdentityVault({
        directory: path.join(userData, "local-device-identity"),
        protectDirectory: directory => protectPrivateDirectory(directory, { packaged: app.isPackaged }),
      });
      const recoveryFiles = createRecoveryFiles({ dialog, parentWindow: () => control, packaged: app.isPackaged });
      const backupFiles = createBackupFiles({ dialog, parentWindow: () => control, packaged: app.isPackaged });
      const localDataAccess = createLocalDataAccess({
        vault: localVault,
        stagingDirectory: path.join(userData, "local-data-staging"),
        protectDirectory: directory => protectPrivateDirectory(directory, { packaged: app.isPackaged }),
      });
      const offlineWifiTransport = createOfflineWifiTransport({ ipcMain });
      const deviceTrust = await createDeviceTrustCoordinator({
        vault: localVault, files: recoveryFiles, backupFiles,
        wifiTransportFactory: offlineWifiTransport,
        ensureBackupNamespace: input => localDataAccess.ensureBackupNamespace(input),
      });
      const faqCache = createFaqCache({
        directory: path.join(userData, "faq-cache"), edition: "personal",
        baseURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        fetch: input => account.faq(input),
        changed: () => sendToLiveFrame(control, "wanx-client:faq-updated"),
      });
      const resumeFaq = () => { void faqCache.checkDue(); };
      powerMonitor.on("resume", resumeFaq);
      faqCache.start();
      client = createPlatformClient({
        faqCache,
        account,
        localDataAccess,
        consumerURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        managementURL: process.env.WANX_NETWORK_MANAGEMENT_URL || undefined,
        localBoxes: createLocalBoxes(),
        creditsServiceURL,
        measure: timed,
        resumeStore: createSecureAccountStore({
          filePath: path.join(userData, "network-resume.enc"),
          safeStorage,
        }),
        createTransport(identity, { managementURL } = {}) {
          const scope = createHash("sha256")
            .update(JSON.stringify(identity ? { ...identity, managementURL } : "direct"))
            .digest("hex");
          const network = createNetwork({
            binaryPath,
            managementURL,
            createSidecar(options) {
              const sidecar = createSidecar(options);
              return {
                ...sidecar,
                request(method, ...args) {
                  return ["start", "recover"].includes(method)
                    ? timed(`engine.${method}`, () =>
                        sidecar.request(method, ...args),
                      )
                    : sidecar.request(method, ...args);
                },
              };
            },
            configDir: path.join(userData, "network", scope),
            deviceName: `wanx-${os.hostname()}`,
          });
          if (identity) network.subscribe(state => timings.state("network", state));
          return {
            network,
            client: createClient({
              network,
              measure: timed,
              createGateway: (options) =>
                createDashboardGateway({
                  ...options,
                  staticCache: options.businessService ? undefined : staticCache,
                  cacheScope: identity && !options.businessService
                    ? { accountId: identity.accountId, boxId: options.deviceId }
                    : undefined,
                }),
            }),
          };
        },
      });
      const trustedKeys = await marketTrustedKeys();
      const releaseAccess = createApplicationReleaseAccess({ account });
      const authorizeRelease = (descriptor, options) => releaseAccess.authorize(descriptor, options);
      const { getCompatibilityContext, prepareApplication } = createApplicationBackend({ client, account, clientVersion: app.getVersion() });
      applications = await createApplicationManager({
        openWorkshop: async applicationId => { if(!personalWorkshop)throw Object.assign(Error('WORKSHOP_UPDATE_REQUIRED'),{code:'WORKSHOP_UPDATE_REQUIRED',status:409});await personalWorkshop.action('sources');control.show();sendToLiveFrame(control,'wanx-client:workshop-source',applicationId); },
        applicationRoot: path.join(userData, "applications"),
        runtimeArgs: process.defaultApp ? [app.getAppPath()] : [],
        applicationId: "wanx-host",
        context: () => client.applicationContext(),
        getRecordingBoxState: () => client.snapshot(),
        request: (input) => client.applicationRequest(input),
        stream: (input) => client.applicationStream(input),
        createConnection: (applicationId, options) => client.applicationConnection(applicationId, options),
        getDataIdentity: () => client.snapshot().dataIdentity,
        trustedKeys,
        assertClientUsable: () => updates?.client.assertUsable(),
        getCompatibilityContext,
        prepareApplication,
        authorizeRelease,
        launcherArgs: [
          ...(app.isPackaged ? [] : [app.getAppPath()]),
          "--wanx-managed-app",
          `--user-data-dir=${userData}`,
          ...(app.commandLine.hasSwitch("use-mock-keychain") ? ["--use-mock-keychain"] : []),
        ],
      });
      marketSession = createMarketSessionGuard(account);
      const support = createRemoteSupport({ account });
      const market = createApplicationMarket({
        request: (input) => account.request(input),
        catalogStore: createSecureAccountStore({ filePath: path.join(userData, "market-catalog.enc"), safeStorage }),
        getCatalogScope: () => JSON.stringify([process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL, account.getIdentity()?.accountId]),
        applications,
        wanxVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        trustedKeys,
        captureSession: () => marketSession.captureSession(),
        getCompatibilityContext,
        authorizeRelease,
      });
      const deliveryScope = () => {
        if (updates?.client.snapshot().requirement?.required) return null;
        const state = client.snapshot();
        const accountId = account.snapshot().phase === "authenticated" ? account.getIdentity()?.accountId : null;
        return accountId && state.phase === "ready" && state.connection?.deviceId
          ? { accountId, deviceId: state.connection.deviceId } : null;
      };
      const defaultApplications = createDefaultApplicationDelivery({
        market, applications, getScope: deliveryScope,
        captureSession: () => marketSession.captureSession(),
        onChanged: () => { void broadcast?.publish(); },
      });
      const deliveryScheduler = createDefaultApplicationScheduler({ delivery: defaultApplications, getScope: deliveryScope });
      const identity = await readClientIdentity({ app });
      updateIdentity = identity;
      const testRuntime = await createTestUpdateRuntime({ identity, app, session });
      let updateTrust = JSON.parse(await readFile(new URL("../updates/trust.json", import.meta.url), "utf8"));
      if (app.isPackaged) {
        try { updateTrust = JSON.parse(await readFile(path.join(process.resourcesPath, "wanx-update-trust.json"), "utf8")); }
        catch (error) { if (error.code !== "ENOENT") updateTrust = { keys: {}, windowsPublisherNames: [] }; }
      }
      if (updateTrust?.schemaVersion !== 1 || !updateTrust.keys || typeof updateTrust.keys !== "object" || Array.isArray(updateTrust.keys))
        updateTrust = { keys: {}, windowsPublisherNames: [] };
      const clientUpdates = await createClientUpdates({
        current: identity, keys: updateTrust.keys, applications,
        request: testRuntime ? input => testRuntime.request(input) : input => account.request(input),
        captureSession: testRuntime ? testRuntime.captureSession : () => marketSession.captureSession(),
        installationId: await installationIdentity(app),
        store: createUpdateStore(path.join(userData, "updates", "client-state.json")),
        createAdapter: () => createElectronUpdateAdapter({ platform: process.platform,
          configurationPath: path.join(userData, "updates", "electron-config.yml"),
          ...(testRuntime ? { cacheDirectoryName: `wanx-client-updater-test-${identity.testRunId}` } : {}),
          installationDirectory: path.dirname(app.getPath("exe")),
          windowsPublisherNames: updateTrust.windowsPublisherNames }),
        requestInstall: finalize => shutdown.requestInstall(finalize).catch(error => {
          dialog.showErrorBox("客户端更新未完成", "安装未完成。请重新启动记忆盒子查看更新诊断，必要时使用正式修复安装包；账号和应用数据会保留。");
          throw error;
        }),
      });
      const boxUpdates = await createBoxUpdates({
        request: input => account.request(input), keys: updateTrust.keys,
        captureSession: () => marketSession.captureSession(),
        store: createUpdateStore(path.join(userData, "updates", "box-state.json")),
        getScope: () => ({ accountId: account.snapshot().phase === "authenticated" ? account.getIdentity()?.accountId : null,
          deviceId: client.snapshot().connection?.deviceId || null }),
      });
      updates = { client: clientUpdates, box: boxUpdates };
      updateChecks = createUpdateChecks({ updates: clientUpdates, getAccount: () => account.snapshot(), enabled: !testRuntime && !cloudPilot });
      const updateListeners = [clientUpdates.subscribe(() => { notifications?.update(clientUpdates.snapshot()); deliveryScheduler.sync(); void broadcast?.publish(); }),
        boxUpdates.subscribe(() => { desktop?.sync(client.snapshot()); void broadcast?.publish(); })];
      let updateAccount = JSON.stringify(account.getIdentity());
      const unsubscribeUpdateAccount = account.subscribe(state => {
        const next = JSON.stringify(account.getIdentity());
        if (state.phase !== "authenticated" || next !== updateAccount) {
          clientUpdates.invalidate(); boxUpdates.invalidate();
        }
        updateAccount = next;
        updateChecks.sync();
        deliveryScheduler.sync();
      });
      const startup = createStartupSettings({ app, testBuild: Boolean(testBuild) });
      try { startup.initializeDefault(); } catch (error) { reportError(error); }
      notifications = await createNotificationCenter({
        client, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        store: createSecureAccountStore({ filePath: path.join(userData, "notification-center.enc"), safeStorage }),
        onChanged: () => { void broadcast?.publish(); },
      });
      uiState = await createUIState({
        client, account, applications,
        assertClientUsable: () => clientUpdates.assertUsable(),
        preferenceFile: path.join(userData, "ui-preferences.json"),
        serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        onChanged: () => { void broadcast?.publish(); },
        onOperation: event => notifications.operation(event),
        onOpened: ({ applicationId }) => {
          desktop?.hidePanel();
          applications.activate(applicationId);
        },
      });
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      control = new BrowserWindow({
        ...mainWindowBounds(area),
        show: false,
        acceptFirstMouse: true,
        title: windowName,
        icon: APP_ICON,
        backgroundColor: "#faf8f4",
        webPreferences: {
          preload: fileURLToPath(
            new URL("../local-ui/remote-preload.cjs", import.meta.url),
          ),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          plugins: true,
          backgroundThrottling: false,
        },
      });
      control.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      control.webContents.on("will-navigate", event => event.preventDefault());
      control.webContents.on("will-attach-webview", event => event.preventDefault());
      const accessoriesPreview = createAccessoriesPreview({
        app, window: control, BrowserWindow, client, account, dialog, safeStorage: osSafeStorage,
        navigate: page => sendToLiveFrame(control, "wanx-client:navigate", page),
        memoryFile: () => memoryRuntimeFile, ensureMemory: () => memoryRuntime.ensure(),
        resourceDirectory: app.isPackaged ? path.join(process.resourcesPath, "accessory-preview")
          : path.join(app.getAppPath(), "resources", "accessory-preview"),
        dataDirectory: path.join(userData, "accessories-unconnected"),
        onError: reportError,
      });
      const deviceTrustWindow = createDeviceTrustWindow({
        BrowserWindow, ipcMain, service: deviceTrust, parentWindow: control,
        wifiTransport: offlineWifiTransport,
        onError: () => reportError(new Error("LOCAL_TRUST_WINDOW_UNAVAILABLE")),
      });
      const stopDeviceTrustLifecycle = registerDeviceTrustLifecycle({ app, powerMonitor, service: {
        lock: reason => { void deviceTrustWindow.invalidate(reason).catch(() => reportError(new Error("LOCAL_TRUST_LOCK_FAILED"))); },
      } });
      broadcast = createUIBroadcast({
        client, applications, uiState, startup, updates, defaultApplications, notifications, windows: () => [control], onError: reportError,
      });
      const requestQuit = createQuitRequest({ app, control, dialog, onError: reportError });

      dashboards = createDashboardWindows({
        BrowserWindow,
        session,
        openExternal: (url) => shell.openExternal(url),
        onError: reportError,
      });
      desktop = createDesktopIntegration({
        app, Menu, Tray, nativeImage, control, client, requestQuit,
        versionInfo: identity,
        checkUpdates: () => clientUpdates.check(),
        onPanelHidden: () => uiState.dismissPanel(),
        openManagement(page) {
          if (control.isDestroyed()) return;
          if (control.isMinimized()) control.restore();
          sendToLiveFrame(control, "wanx-client:navigate", page);
          control.show();
          control.focus();
        },
      });
      personalSpace = await createPersonalSpace({
        driveCatalog: () => { if(!spaceLinks)throw Object.assign(new Error("BOX_CONNECTION_REQUIRED"),{code:"BOX_CONNECTION_REQUIRED"});return spaceLinks.manage("mcp-drives"); },
        onEvent: event => timings.transfer(event),
        client, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        store: createSecureAccountStore({ filePath: path.join(userData, "space-transfers.enc"), safeStorage }),
        annotationStore: createSecureAccountStore({ filePath: path.join(userData, "space-annotations.enc"), safeStorage }),
        workbenchStore: createSecureAccountStore({ filePath: path.join(userData, "space-annotation-workbench.enc"), safeStorage }),
        redactionStore: createSecureAccountStore({ filePath: path.join(userData, "space-redaction-rules.enc"), safeStorage }),
        enableTextEditing: true,
        annotationAI: {
          models: options => annotationModels ? annotationModels.models(options) : Promise.resolve({ available: false, presets: [], reason: "SPACE_ANNOTATION_MODEL_UNAVAILABLE" }),
          suggest: (input, options) => { if (!annotationModels) throw Object.assign(new Error("SPACE_ANNOTATION_MODEL_UNAVAILABLE"), { code: "SPACE_ANNOTATION_MODEL_UNAVAILABLE" }); return annotationModels.suggest(input, options); },
        },
        chooseUploads: async ({ folders = false } = {}) => {
          const result = await dialog.showOpenDialog(control, { title: "上传到盒子空间", message: "支持文件和文件夹，自动分批上传并保留目录结构；单文件最大 200 MB，问题文件单独提示。", properties: [folders ? "openDirectory" : "openFile", "multiSelections"] });
          return result.canceled ? [] : result.filePaths;
        },
        chooseDownloadDirectory: async () => {
          const result = await dialog.showOpenDialog(control, { title: "选择批量下载保存位置", properties: ["openDirectory", "createDirectory"] });
          return result.canceled ? null : result.filePaths[0];
        },
        chooseDownload: async name => {
          const result = await dialog.showSaveDialog(control, { title: "保存文件", defaultPath: name });
          return result.canceled ? null : result.filePath;
        },
        onChanged: state => sendToLiveFrame(control, "wanx-client:space-state", state),
      });
      const clipboardDirectory = path.join(userData, "super-clipboard");
      try {
      superClipboard = await createSuperClipboard({
        client, personalSpace, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        store: createSecureAccountStore({filePath:path.join(userData,"super-clipboard.enc"),safeStorage}),
        directory: clipboardDirectory, deviceName: os.hostname(),
        systemClipboard: createSystemClipboard({clipboard,nativeImage,app,directory:path.join(clipboardDirectory,"native")}),
        chooseFiles: async (input={}) => { const result=await dialog.showOpenDialog(control,{title:"插入图片到便签",message:"每次最多20张图片，单张最大20 MB",filters:[{name:"图片",extensions:["png","jpg","jpeg","gif","webp"]}],properties:["openFile","multiSelections"]});return result.canceled?[]:result.filePaths; },
        chooseDownload: async (name,input={}) => {const result=await dialog.showSaveDialog(control,{title:"下载便签内容",defaultPath:name});return result.canceled?null:result.filePath;},
        onChanged: state => sendToLiveFrame(control, "wanx-client:clipboard-state", state),
      });
      } catch (error) {
        const code = error.code || "CLIPBOARD_CACHE_DAMAGED";
        superClipboard = {snapshot:()=>({scope:null,items:[],tasks:[],error:code}),operation:async method=>{if(method==="snapshot")return {scope:null,items:[],tasks:[],error:code};throw Object.assign(new Error(code),{code});},close:async()=>{}};
      }
      try {
        spaceLinks = await createSpaceLinkBridge({
          client, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
          store: createSecureAccountStore({ filePath: path.join(userData, "space-links.enc"), safeStorage }),
          agentHubOptions: {team: false},
          copyText: text => clipboard.writeText(text),
          chooseStorageDirectory: async () => {
            const result = await dialog.showOpenDialog(control, {
              title: "选择空间存储文件夹", buttonLabel: "选择此文件夹",
              properties: ["openDirectory", "createDirectory"],
            });
            return result.canceled ? null : result.filePaths[0];
          },
          onChanged: () => sendToLiveFrame(control, "wanx-client:space-content-changed"),
        });
      } catch (error) {
        const code = error.code || "SPACE_LINK_START_FAILED";
        spaceLinks = { manage: async () => { throw new Error(code); }, close: async () => {} };
      }
      personalWorkshop = createPersonalWorkshop({client,applications,nativeFoundation:{root:path.join(app.getPath('userData'),'workshop-foundation'),dialog,openWorkshop:async applicationId=>{control.show();sendToLiveFrame(control,'wanx-client:workshop-source',applicationId);return {opened:true};}},getCatalog:()=>market.list(),assets:path.join(app.getAppPath(),'workshop'),BrowserWindow,WebContentsView,ipcMain,control,onChanged:()=>{sendToLiveFrame(control,'wanx-client:workshop-changed');void broadcast?.publish()},onNavigate:()=>{sendToLiveFrame(control,'wanx-client:workshop-changed');sendToLiveFrame(control,'wanx-client:navigate','applications');control.show();}});
      personalDataService = createPersonalDataService({client,applications,personalSpace,getMcpDetails:()=>spaceLinks.mcpDetails("starlink"),writeClipboard:text=>clipboard.writeText(text),starlinkPackageDir:path.join(app.getAppPath(),"applications/starlink"),selectFiles:async()=>{const result=await dialog.showOpenDialog(control,{title:"导入个人知识材料",properties:["openFile","multiSelections"]});return result.canceled?[]:result.filePaths;}});
      starlinkPanel = createStarlinkPanelService({client,personalSpace,
        starxiaotuModelStore: createSecureAccountStore({filePath: path.join(userData, "starxiaotu-model.enc"), safeStorage}),
        selectFiles:async({multiple=true}={})=>{const result=await dialog.showOpenDialog(control,{title:"导入知识材料",properties:multiple?["openFile","multiSelections"]:["openFile"]});return result.canceled?[]:result.filePaths;},
        selectSave:async filename=>{const result=await dialog.showSaveDialog(control,{title:"保存材料原件",defaultPath:filename});return result.canceled?null:result.filePath;},
        emit: event => sendToLiveFrame(control, 'wanx-client:starlink-event', event),
        openModels: () => sendToLiveFrame(control, 'wanx-client:navigate', 'dialogue-models'),
      });
      const memoryLibrary = await readMemoryLibrary(userData);
      const memoryRuntimeLayout = memoryLibraryRuntime(memoryLibrary, userData, cloudPilot
        ? { ...process.env, MEMMY_HOME: path.join(userData, "memory") } : process.env);
      if (cloudPilot) memoryRuntimeLayout.root = userData;
      const memoryEnv = memoryRuntimeLayout?.env ?? process.env;
      delete process.env.MEMMY_ISOLATED_CODEX_PROFILE;
      const memorySource = testRuntime || memoryEnv.MEMMY_RUNTIME_CONFIG_PATH?.trim() ? null : await resolveManagedMemorySource({
        appPath: app.getAppPath(), packaged: app.isPackaged, resourcesPath: process.resourcesPath,
        env: memoryEnv,
      });
      const memoryRuntimeFile = resolveMemoryRuntimeFile(memoryEnv, os.homedir(), Boolean(memorySource) || Boolean(memoryRuntimeLayout));
      const memoryRuntime = createMemoryRuntimeSupervisor({
        runtimeFile: memoryRuntimeFile, source: memorySource, appPath: app.getAppPath(),
        appData: memoryRuntimeLayout?.root ?? app.getPath("appData"), env: memoryEnv,
      });
      const serviceURL = process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL;
      const boxScope = () => dataInteractionKey(client.snapshot(), serviceURL);
      const starlink = (action, input) => personalDataService.action(action, input);
      const starlinkMcp = createSemanticaMcpClient({
        client, scope: boxScope, starlink, issueKey: id => personalDataService.createMcpKey(id),
      });
      const sources = createCodexContextSources({
        space: personalSpace, nativeImage, starlink, starlinkMcp,
      });
      const myAiMemory = createMyAiMemoryAccess({ runtimeFile: memoryRuntimeFile });
      const readZhijunSources = createZhijunSourceReader({
        sources, interaction: boxScope,
        async memory(query, check, agent) {
          await memoryRuntime.ensure();
          check();
          if (agent) return myAiMemory.searchSource(query, agent, check);
          return myAiMemory.call("memory_search", { query }, check);
        },
      });
      aiDialogue = createAIDialogue({ client, assistantPersona: "zhijun", readZhijunSources,
        async listZhijunSources(kind, parent, check) {
          if (kind !== "memory") return sources.catalog(parent, check, kind);
          await memoryRuntime.ensure();
          return { agents: await myAiMemory.sourceCatalog(check) };
        },
        openZhijunSource: (reference, check) => openZhijunSource(sources, reference, check),
        readMemmy: createZhijunMemmyRead({ runtimeFile: memoryRuntimeFile, async confirm(source) {
          const answer = await dialog.showMessageBox(control, {
            type: "question", buttons: ["取消", "允许本次查询"], defaultId: 0, cancelId: 0,
            message: `允许知君查询这台电脑上 ${source} 的记忆？`,
            detail: "仅本次读取。在侧栏显示匹配的节选和出处。",
          });
          return answer.response === 1;
        } }),
        selectFiles: async () => {
          const result = await dialog.showOpenDialog(control, { title: "添加助理附件", properties: ["openFile", "multiSelections"] });
          return result.canceled ? [] : result.filePaths;
        },
        saveFile: async name => {
          const result = await dialog.showSaveDialog(control, { title: "保存助理产物", defaultPath: name });
          return result.canceled ? null : result.filePath;
        },
        preferenceStore: createSecureAccountStore({ filePath: path.join(userData, "ai-dialogue-models.enc"), safeStorage }), onEvent: event => {
        sendToLiveFrame(control, "wanx-client:ai-dialogue", event);
      } });
      annotationModels = createAnnotationModelClient({ runtimeFile: memoryRuntimeFile, ensureReady: () => memoryRuntime.ensure(),
        getScope: () => dataInteractionKey(client.snapshot(), process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL),
      });
      const agentInstallations = createMyAiInstallations({ directory: path.join(userData, "my-ai-programs") });
      const cloudRoutes = process.platform === "darwin" ? createMyAiCloudRoutes({
        desktopConfig: createCodexModelConfig({
          file: path.join(process.env.CODEX_HOME || path.join(app.getPath("home"), ".codex"), "config.toml"),
          journal: path.join(userData,"codex-gateways","model-switch-recovery.json"),
        }),
        desktopGatewayDir: path.join(userData, "codex-gateways"),
        context: () => {
          const state = client.snapshot();
          return { owner: dataOwnerKey(state, serviceURL), box: state.connection?.deviceId, scope: boxScope() };
        },
        transport: createBoxCloudTransport(client),
        store: createSecureAccountStore({ filePath: path.join(userData, "my-ai-cloud-models.enc"), safeStorage }),
      }) : null;
      const unsubscribeCloud = cloudRoutes && client.subscribe(() => cloudRoutes.sync());
      const agentLauncher = createMyAiLauncher({
        directory: path.join(memoryRuntimeLayout?.root ?? userData, "my-ai-launch"),
        openFile: file => shell.openPath(file),
        getScope: () => boxScope() || dataOwnerKey(client.snapshot(), serviceURL),
      });
      const memoryTransfer = createMyAiMemoryTransfer({
        runtimeFile: memoryRuntimeFile,
        directory: path.join(memoryRuntimeLayout?.root ?? userData, "my-ai-import-recovery"),
        scope: () => boxScope() || dataOwnerKey(client.snapshot(), serviceURL),
        identity: () => {
          const owner = dataOwnerKey(client.snapshot(), serviceURL);
          return owner ? JSON.stringify([owner, client.snapshot().connection?.deviceId ?? "local"]) : null;
        },
        async chooseImportFile() {
          const chosen = await dialog.showOpenDialog(control, { title: "选择 MemoBox 记忆包", properties: ["openFile", "dontAddToRecent"], filters: [{ name: "MemoBox JSON", extensions: ["json"] }] });
          return chosen.canceled ? null : chosen.filePaths[0];
        },
        async saveExportFile() {
          const chosen = await dialog.showSaveDialog(control, { title: "导出 MemoBox 记忆包", defaultPath: "memobox-memory.json", filters: [{ name: "MemoBox JSON", extensions: ["json"] }] });
          return chosen.canceled ? null : chosen.filePath;
        },
      });
      const agentAccess = createMyAiAccess({
        agents: ["codex", ...configurableAgents],
        sources, memory: myAiMemory, spaceLinks,
        store: createSecureAccountStore({ filePath: path.join(userData, "my-ai-access.enc"), safeStorage }),
        owner: () => dataOwnerKey(client.snapshot(), serviceURL),
        box: () => client.snapshot().connection?.deviceId,
        scope: boxScope,
        makeContext(agent, direct) {
          const descriptor = agent === "codex" ? path.join(userData, "codex-context", "endpoint.json")
            : path.join(userData, "my-ai-access", agent, "endpoint.json");
          const paths = { stdioPath: fileURLToPath(new URL("./codex-context-stdio.mjs", import.meta.url)), descriptorPath: descriptor,
            stableLauncher: app.isPackaged && !testBuild };
          const configure = agent === "codex" ? createCodexContextConfig({ ...paths,
            discover: async options => (await agentInstallations.inspect("codex_cli"))?.executable ?? findCodexCli(options),
            confirmReplace: async ({ previous, next }) => (await dialog.showMessageBox(control, {
              type: "warning", title: "更新 Codex 资料连接", message: "检测到旧版记忆盒子的资料连接",
              detail: `更新后，Codex 将使用当前客户端中选择的资料范围。\n\n原客户端：${previous.command}\n原连接：${previous.args[1]}\n\n当前客户端：${next.command}\n当前连接：${next.args[1]}`,
              buttons: ["取消", "更新连接"], defaultId: 0, cancelId: 0, noLink: true,
            })).response === 1,
          }) : createMyAiMcpConfig(agent, { ...paths, stableLauncher: app.isPackaged && !testBuild });
          return createCodexContext({
            sources, scope: boxScope, configure, descriptor, direct,
            protectFile: file => protectPrivateFile(file, { packaged: app.isPackaged }),
          });
        },
      });
      if (!testRuntime) void agentAccess.restore(reportError).catch(reportError);
      const memoryWorkspace = createMemoryWorkspace({
        assets: path.join(app.getAppPath(), "local-ui", "memory"),
        runtimeFile: memoryRuntimeFile, runtime: memoryRuntime,
        onPipelineBlockers: event => notifications.memoryPipeline(event),
        backup: {
          space: personalSpace,
          library: memoryLibrary,
          sourceBinding: () => readBackupSourceBinding(userData),
          store: createSecureAccountStore({ filePath: path.join(userData, "memory-backup.enc"), safeStorage }),
          stagingRoot: path.join(userData, "memory-backup-staging"),
          protect: directory => protectPrivateDirectory(directory, { packaged: app.isPackaged, rootOnly: true }),
        },
        agentVisibilityStore: createSecureAccountStore({
          filePath: path.join(memoryRuntimeLayout?.root ?? userData, "my-ai-visibility.enc"), safeStorage,
        }),
        getState: () => client.snapshot(),
        agentAccess,
        myAiCollaboration: collaborationModels ? createMyAiCollaboration({
          identity: () => {
            const state = client.snapshot();
            return { owner: dataOwnerKey(state, serviceURL), box: state.connection?.deviceId, scope: dataInteractionKey(state, serviceURL),
              account: state.dataIdentity?.profileId ? ["local", state.dataIdentity.profileId] : ["account", serviceURL, state.account?.accountId] };
          },
          sources: createCollaborationSources({ sources, memory: myAiMemory, starlink }),
          models: collaborationModels,
          store: createSecureAccountStore({ filePath: path.join(userData, "my-ai-collaboration.enc"), safeStorage }),
          async saveReport(markdown, check) {
            const result = await dialog.showSaveDialog(control, {
              title: "导出研究方案", defaultPath: "研究方案.md", filters: [{ name: "Markdown", extensions: ["md"] }],
            });
            if (result.canceled || !result.filePath) return false;
            await check();
            await writeFile(result.filePath, markdown, { encoding: "utf8", mode: 0o600 });
            return true;
          },
        }) : undefined,
        memoryTransfer,
        claudeChatImport: createClaudeChatHistoryImport({
          runtimeFile: memoryRuntimeFile,
          identity: () => dataOwnerKey(client.snapshot(), serviceURL),
          async chooseFile() {
            const selected = await dialog.showOpenDialog(control, { title: "选择 Claude Chat 导出文件",
              properties: ["openFile", "dontAddToRecent"], filters: [{ name: "Claude 导出文件", extensions: ["zip", "json"] }] });
            return selected.canceled ? null : selected.filePaths[0];
          },
        }),
        fetchAsset: url => net.fetch(url),
        client, serviceURL: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        preferenceFile: path.join(userData, "memory-model-source"),
        myAiTask: createMyAiTask({
          launcher: agentLauncher, cloudRoutes, installations: agentInstallations,
          protocolRegistered: url => Boolean(app.getApplicationNameForProtocol(url).trim()),
          applicationForProtocol: url => app.getApplicationInfoForProtocol(url),
          openExternal: url => shell.openExternal(url),
          windowsCodex: process.platform === "win32" ? { detect: detectWindowsCodex, open: openWindowsCodex } : undefined,
          openApplication: file => shell.openPath(file),
          revealApplication: file => shell.showItemInFolder(file),
          copyText: text => clipboard.writeText(text),
          boxScope,
          codexContext: agentAccess.codex,
          agentAccess,
          starlink: (action, input) => personalDataService.action(action, input),
          assertClientUsable: () => clientUpdates.assertUsable(),
          polish: (text, signal, assertSource) => aiDialogue.polishTask(text, signal, assertSource),
        }),
        protectFile: file => protectPrivateFile(file, { packaged: app.isPackaged }),
        localStorage: {
          defaultDirectory: path.join(memoryRuntimeLayout?.root ?? userData, "空间", "本机", "万象记忆库"),
          protectDirectory: directory => protectPrivateDirectory(directory, { packaged: app.isPackaged, rootOnly: true }),
          async chooseDirectory(defaultPath) {
            const chosen = await dialog.showOpenDialog(control, {
              title: "选择本机记忆库的保存位置", defaultPath,
              properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
            });
            return chosen.canceled ? null : chosen.filePaths[0];
          },
          async openDirectory(directory) {
            if (await shell.openPath(directory)) throw new Error("无法打开此文件夹。");
          },
        },
      });
      if (memorySource) void memoryRuntime.ensure().catch(reportError);
      memoryWorkspace.sync();
      control.webContents.session.protocol.handle(ACCESSORY_SCHEME, accessoriesPreview.handleCatalog);
      control.webContents.session.protocol.handle(MEMORY_SCHEME, memoryWorkspace.handle);
      registerControlActions({
        accessoriesPreview: accessoriesPreview.show,
        spaceVolumes: input => spaceVolumeRequest({app,client}, input),
        personalDataService, personalWorkshop, starlinkPanel,
        openMemoryWorkspace: memoryWorkspace.open,
        localMemoryStorage: memoryWorkspace.storage,
        memoryBackup: memoryWorkspace.backup,
        aiDialogue,
        timings,
        notifications,
        spaceLinks,
        personalSpace,
        superClipboard,
        confirmSpacePurge: async () => (await dialog.showMessageBox(control, {
          type: "warning", message: "彻底删除这个文件或文件夹？", detail: "删除后无法恢复。文件夹中的内容也会一并删除。",
          buttons: ["取消", "彻底删除"], defaultId: 0, cancelId: 0,
        })).response === 1,

        accountProfile: {
          save: input => account.saveProfile(input),
          removeAvatar: () => account.saveProfile({ avatarDataUrl: null }),
          chooseAvatar: () => account.chooseAvatar(async () => {
            const result = await dialog.showOpenDialog(control, {
              title: "上传头像", buttonLabel: "使用头像",
              filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg"] }], properties: ["openFile"],
            });
            return result.canceled || !result.filePaths.length ? null : readAvatar(result.filePaths[0], nativeImage);
          }),
        },
        creditWallet: createCreditWallet({ request: input => account.request(input) }),
        credits: createCreditsReader({ client, authorityDeviceId: process.env.WANX_CREDITS_DEVICE_ID || "",
          accountRequest: creditsServiceURL ? input => account.creditsRequest({ ...input, serviceURL: creditsServiceURL }) : null }),
        ipcMain,
        control,
        controlURL,
        uiState,
        desktop,
        getState: broadcast.getState,
        publishState: broadcast.publish,
        getDesktopStartup: startup.get,
        setDesktopStartup: startup.set,
        showAbout: () => { desktop.hidePanel({ preserveIntent: true }); app.showAboutPanel(); },
        openDeviceTrust: () => deviceTrustWindow.open({ view: "overview" }),
        quit: requestQuit,
        client,
        applications,
        dashboards,
        market,
        updates,
        support,
        allowDevelopmentInstall: !app.isPackaged && process.env.WANX_ALLOW_DEVELOPMENT_INSTALL === "1",
        confirmLocalApplicationArchive: async archivePath => {
          const result = await dialog.showMessageBox(control, {
            type: "warning", title: "安装本地应用", message: "确认安装此应用包？",
            detail: `${path.basename(archivePath)}\n请仅安装来自可信来源的应用包。安装不会自动打开应用，已有业务数据会保留。`,
            buttons: ["取消", "安装"], defaultId: 0, cancelId: 0, noLink: true,
          });
          return result.response === 1;
        },
        selectApplicationArchive: async () => {
          const result = await dialog.showOpenDialog(control, {
            title: "选择应用安装包",
            buttonLabel: "选择安装包",
            filters: [{ name: "应用压缩包", extensions: ["zip"] }],
            properties: ["openFile"],
          });
          return result.canceled ? null : result.filePaths[0];
        },
      });
      unsubscribe = client.subscribe(() => {
        accessoriesPreview.syncConnection();
        memoryWorkspace.sync();
        agentAccess.sync();
        if (!testRuntime) void agentAccess.restore(reportError).catch(reportError);
        timings.state("platform", client.snapshot().platform);
        dashboards.sync(client.snapshot());
        desktop.sync(client.snapshot());
        openTerminalConsole();
        boxUpdates.sync();
        deliveryScheduler.sync();
        void broadcast.publish();
      });

      shutdown = registerShutdown({
        app,
        async closeApplications() {
          powerMonitor.removeListener("resume", resumeFaq);
          await faqCache.close();
          updateChecks.close();
          await starlinkMcp.close();
          deviceTrust.lock("shutdown");
          uiState.invalidateOpen();
          personalWorkshop?.close();
          await agentAccess.close();
          unsubscribeCloud?.();
          cloudRoutes?.close();
          await agentLauncher.close();
          personalDataService?.close();
          starlinkPanel?.close();
          accessoriesPreview.close();
          aiDialogue?.close();
          await memoryWorkspace.close().catch(reportError);
          await deliveryScheduler.close();
          await defaultApplications.close();
          marketSession?.close();
          releaseAccess.close();
          await superClipboard?.close();
          await Promise.all([market.close(), personalSpace?.close(), spaceLinks?.close(), applications?.close()]);
        },
        async closeHost() {
          stopDeviceTrustLifecycle();
          await deviceTrustWindow.dispose();
          deviceTrust.close();
          recoveryFiles.close();
          await backupFiles.close();
          localDataAccess.close();
          await notifications?.close();
          support.close();
          unsubscribeUpdateAccount();
          for (const remove of updateListeners) remove();
          clientUpdates.close(); boxUpdates.close();
          desktop.dispose();
          unsubscribe();
          broadcast.dispose();
          await uiState.dispose();
          stopNetworkMonitor?.();
          await Promise.resolve(setupRuntime?.dispose()).catch(() => {});
          await Promise.allSettled([dashboards.close(), client.close()]);
          await timings.flush();
        },
        onError(error) {
          reportError(error);
          dialog.showErrorBox("无法退出记忆盒子", "应用尚未完全退出。请关闭应用后再次退出记忆盒子。");
        },
      });
      app.on("window-all-closed", () => app.quit());
      let setupStartFailed = false;
      setupRuntime = await createSetupRuntime({
        control, controlURL, ipcMain, account, client, safeStorage, userData,
        onDiagnostic: event => timings.provisioning(event),
        advertisementNames: createAdvertisementNames({
          lookupName: (deviceId) => account.lookupDeviceName(deviceId),
          cacheScope: () => account.getIdentity()?.accountId || null,
          helperPath: nativePaths.discovery,
        }),
        consumerBaseUrl: process.env.WANX_CONSUMER_URL || DEFAULT_CONSUMER_URL,
        onError: reportError,
      }).catch((error) => {
        reportError(error);
        setupStartFailed = true;
        return null;
      });
      await control.loadURL(controlURL);
      if (setupStartFailed) sendToLiveFrame(control, "wanx:setup:state", {
        state: "terminalError", errorCode: "SETUP_START_FAILED",
      });
      await clientUpdates.ready();
      updateChecks.sync();
      if (process.env.WANX_SMOKE_USER_DATA)
        await writeFile(path.join(userData, "smoke-ui-ready.marker"), "ready");
      stopNetworkMonitor = monitorNetworkChanges({
        powerMonitor,
        onChange: () => client.networkChanged(),
        onError: reportError,
      });
      if (!startup.wasOpenedAtLogin()) desktop.showManagement();
      deliveryScheduler.sync();
      void broadcast.publish();
      const initialization = timed("client.initialize", () => client.initialize()).then(openTerminalConsole);
      if (testRuntime) {
        await initialization;
        await testRuntime.ready(clientUpdates);
      } else void initialization.catch(reportError);
    })
    .catch((error) => {
      reportError(error);
      app.exit(1);
    });
