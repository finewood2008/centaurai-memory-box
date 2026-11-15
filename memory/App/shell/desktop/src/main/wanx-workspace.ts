import { WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export type WanxStatus = "ready" | "missing" | "incompatible" | "unavailable";
export const wanxPageRoutes = { login: "/login", boxes: "/boxes", space: "/space", data: "/star-map", profile: "/settings#account", settings: "/settings#wanx", credits: "/settings#credits", "dialogue-models": "/settings#box-model" } as const;
export type WanxPage = keyof typeof wanxPageRoutes;
type WanxAccountState = { phase: "loading" | "signed_out" | "authenticated"; revision: number };
export function isWanxPage(page: unknown): page is WanxPage {
  return typeof page === "string" && Object.hasOwn(wanxPageRoutes, page);
}

interface WanxConfig {
  appPath: string;
  electronPath: string;
  userData: string;
}
interface EmbeddedControl {
  webContents: WebContentsView["webContents"];
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
}
interface EmbeddedOptions extends WanxConfig {
  parentWindow(): BrowserWindow | null;
  createControl(options: { preload: string; documentURL: string }): EmbeddedControl;
  registerClose(close: () => Promise<void>): void;
  accountChanged(phase: unknown, identity: unknown): void;
  navigate(page: unknown): void;
}

function readConfig(userDataPath: string): WanxConfig | WanxStatus {
  try {
    const configPath = join(userDataPath, "wanx-foundation.json");
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) : {};
    const appPath = process.env.CENTAUR_WANX_ROOT?.trim() || config.root;
    if (!appPath) return "missing";
    if (typeof appPath !== "string" || !isAbsolute(appPath)) return "incompatible";
    const root = realpathSync(appPath);
    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const main = join(root, "shell", "main.mjs");
    if (metadata.wanxEdition !== "personal" || metadata.main !== "shell/entry.mjs" || !existsSync(main)) return "incompatible";
    // Use the foundation's own Electron for its separately hosted applications.
    const electronRoot = join(root, "node_modules", "electron");
    const electronPath = realpathSync(join(electronRoot, "dist", readFileSync(join(electronRoot, "path.txt"), "utf8").trim()));
    return { appPath: root, electronPath, userData: join(userDataPath, "wanx-foundation") };
  } catch {
    return "incompatible";
  }
}

function clampBounds(win: BrowserWindow, bounds: unknown): Rectangle | null {
  if (!bounds || typeof bounds !== "object") return null;
  const values = bounds as Record<string, unknown>;
  const [x, y, width, height] = ["x", "y", "width", "height"].map((key) => values[key]);
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number"
    || ![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 46 || width <= 0 || height <= 0) return null;
  const [w = 0, h = 0] = win.getContentSize();
  if (x >= w || y >= h) return null;
  return { x, y, width: Math.min(width, w - x), height: Math.min(height, h - y) };
}

export function createWanxWorkspace(userDataPath: () => string, accountChanged: (state: WanxAccountState) => void) {
  let view: WebContentsView | undefined;
  let current: { win: BrowserWindow; page: WanxPage; bounds: Rectangle } | undefined;
  let owner: BrowserWindow | undefined;
  let closeFoundation: (() => Promise<void>) | undefined;
  let pending: Promise<WanxStatus> | undefined;
  let recovery: Promise<WanxStatus> | undefined;
  let documentURL: string | undefined;
  let ready = false;
  let closed = false;
  let account: WanxAccountState = { phase: "loading", revision: 0 };
  let accountIdentity: unknown;
  let accountBridgeReady = false;

  function updateAccount(phase: unknown, identity: unknown) {
    if (phase !== "loading" && phase !== "signed_out" && phase !== "authenticated") return;
    accountBridgeReady = true;
    if (phase === account.phase && identity === accountIdentity) return;
    accountIdentity = identity;
    account = { phase, revision: account.revision + 1 };
    if (phase !== "authenticated" && current?.page !== "login") hide();
    accountChanged(account);
  }

  function detach() {
    if (view && owner && !owner.isDestroyed()) owner.contentView.removeChildView(view);
    owner = undefined;
  }

  function hide(win?: BrowserWindow) {
    if (win && current?.win !== win) return;
    current = undefined;
    detach();
  }

  function attach() {
    if (!current || !view || !ready || current.win.isDestroyed()) return;
    if (owner !== current.win) {
      if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view);
      owner = current.win;
      owner.contentView.addChildView(view);
    }
    view.setBounds(current.bounds);
  }

  function selectPage(page: WanxPage) {
    if (view && ready && !view.webContents.isDestroyed()) view.webContents.send("wanx-client:navigate", page);
  }

  function showReadyView(): WanxStatus {
    if (closed || !view || view.webContents.isDestroyed()) return "unavailable";
    ready = true;
    if (current) selectPage(current.page);
    attach();
    return "ready";
  }

  function recoverView(): Promise<WanxStatus> {
    if (recovery) return recovery;
    if (!view || !documentURL || view.webContents.isDestroyed()) return Promise.resolve("unavailable");
    recovery = view.webContents.loadURL(documentURL).then(showReadyView, (error) => {
      console.warn("[wanx] Cannot reload foundation:", error);
      return "unavailable" as const;
    }).finally(() => { recovery = undefined; });
    return recovery;
  }

  async function initialize(): Promise<WanxStatus> {
    const config = readConfig(userDataPath());
    if (typeof config === "string") return config;
    try {
      mkdirSync(config.userData, { recursive: true, mode: 0o700 });
      const { startWanxDesktop } = await import(pathToFileURL(join(config.appPath, "shell", "main.mjs")).href);
      if (typeof startWanxDesktop !== "function") return "incompatible";
      await (startWanxDesktop as (options: EmbeddedOptions) => Promise<void>)({
        ...config,
        parentWindow: () => current?.win.isDestroyed() === false ? current.win : null,
        navigate: (page) => { if (isWanxPage(page)) guestNavigate(page); },
        accountChanged: updateAccount,
        registerClose: (callback) => { closeFoundation = callback; },
        createControl: ({ preload, documentURL: url }) => {
          documentURL = url;
          const contents = new WebContentsView({ webPreferences: {
            preload,
            additionalArguments: ["--centaur-embedded"],
            partition: "persist:centaur-wanx-workspace",
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            backgroundThrottling: false,
          } });
          view = contents;
          const invalidateView = () => {
            const wasReady = ready;
            ready = false;
            const win = current?.win;
            detach();
            if (wasReady && win && !win.isDestroyed()) win.webContents.send("centaur:wanx-unavailable");
          };
          contents.webContents.on("render-process-gone", invalidateView);
          contents.webContents.on("destroyed", invalidateView);
          contents.webContents.on("will-frame-navigate", (event) => {
            if (event.isMainFrame || !event.url.startsWith("blob:file:")) event.preventDefault();
          });
          contents.webContents.on("will-redirect", (event) => event.preventDefault());
          contents.setBackgroundColor("#faf8f4");
          return {
            webContents: contents.webContents,
            isDestroyed: () => contents.webContents.isDestroyed(),
            async loadURL(target) {
              if (target !== url || !url.startsWith("file:")) throw new Error("Unsupported foundation document");
              await contents.webContents.loadURL(target);
            },
          };
        },
      });
      return accountBridgeReady ? showReadyView() : "incompatible";
    } catch (error) {
      console.warn("[wanx] Cannot start foundation:", error);
      return "unavailable";
    }
  }

  function guestNavigate(page: WanxPage) {
    if (account.phase !== "authenticated" || !current || current.page === page || current.win.isDestroyed()) return;
    current.page = page;
    current.win.webContents.send("centaur:wanx-navigate", wanxPageRoutes[page]);
  }

  function acceptGuestNavigation(event: Electron.IpcMainEvent, page: unknown) {
    if (!ready || !isWanxPage(page) || event.sender !== view?.webContents
      || event.senderFrame !== view?.webContents.mainFrame || event.senderFrame?.url !== documentURL) return;
    guestNavigate(page);
  }

  return {
    getAccount: () => account,
    async show(win: BrowserWindow, page: unknown, rawBounds: unknown): Promise<WanxStatus> {
      if (closed || win.isDestroyed() || !isWanxPage(page)) return "unavailable";
      if (page !== "login" && account.phase !== "authenticated") return "unavailable";
      const bounds = clampBounds(win, rawBounds);
      if (!bounds) return "unavailable";
      const changed = current?.page !== page;
      current = { win, page, bounds };
      if (!pending) {
        pending = initialize();
        void pending.then((status) => {
          if (!view && !closeFoundation && status !== "ready") {
            pending = undefined;
          }
        });
      }
      if (ready) {
        if (changed) selectPage(page);
        attach();
        return "ready";
      }
      const status = await pending;
      if (status === "ready" && !ready && !closed && current?.win === win) return recoverView();
      return status;
    },
    hide,
    acceptGuestNavigation,
    async close() {
      closed = true;
      hide();
      try {
        await pending;
        await recovery;
        await closeFoundation?.();
      } finally {
        if (view && !view.webContents.isDestroyed()) view.webContents.close();
      }
    },
  };
}
