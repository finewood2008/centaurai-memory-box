import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readMemoryConnection } from "./local-memory-runtime.mjs";
import { nasRequest } from "./accessory-nas.mjs";
import { recordingSession } from "./accessory-media-session.mjs";

const accessoryPage = /^\/accessories(?:\/(?:disk|clip|storage|storage\/drive|nas))?\/?$/;

function toolEnvironment() {
  const common = ["/opt/homebrew/opt/ffmpeg-full/bin", "/opt/homebrew/bin", "/usr/local/bin"];
  const executable = name => common.map(directory => path.join(directory, name)).find(existsSync);
  return {
    PATH: [process.env.PATH, ...common].filter(Boolean).join(path.delimiter),
    ...(executable("ffmpeg") ? { FFMPEG_BIN: executable("ffmpeg") } : {}),
    ...(executable("ffprobe") ? { FFPROBE_BIN: executable("ffprobe") } : {}),
  };
}

function boundsInWindow(window, supplied) {
  if (!supplied || !["x", "y", "width", "height"].every(key => Number.isSafeInteger(supplied[key]))) return null;
  const [windowWidth, windowHeight] = window.getContentSize();
  const x = Math.max(0, supplied.x);
  const y = Math.max(0, supplied.y);
  const width = Math.min(supplied.x + supplied.width, windowWidth) - x;
  const height = Math.min(supplied.y + supplied.height, windowHeight) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function createAccessoriesPreview({ app, window, WebContentsView, resourceDirectory, dataDirectory, memoryFile, onError, client, account, dialog, safeStorage }) {
  let worker, preparing, guest;
  let localAccount;
  const accountId = () => account?.snapshot().phase === 'authenticated' ? account.getIdentity()?.accountId : null;
  const owner = { app, window, client, dialog, safeStorage };
  let mediaSession, unwatch, connecting = false, requestAfterCheck = false;
  let waitingForGrant = false;
  function setWaitingForGrant(waiting) {
    if (waitingForGrant === waiting) return;
    waitingForGrant = waiting;
    if (worker?.connected) worker.send({type:'recording-grant-pending', waiting}, () => {});
  }
  function attachSession(next) {
    setWaitingForGrant(false);
    const previous = mediaSession;
    unwatch?.();
    unwatch = undefined;
    mediaSession = next;
    if (next) unwatch = next.session.onInvalidated(() => {
      if (mediaSession === next) attachSession(null);
    });
    if (worker?.connected) worker.send({type:'recording-media', env:next?.env, legacy:next?.data}, () => {});
    if (previous && previous !== next) void previous.session.close();
  }
  const stopAccount = account?.subscribe(() => {
    if (localAccount && accountId() !== localAccount) { ++revision; resetRuntime(); }
  });
  function resetRuntime() {
    waitingForGrant = false;
    const processHandle = worker;
    worker = undefined;
    processHandle?.kill();
    const stop = unwatch;
    unwatch = undefined;
    stop?.();
    const previous = mediaSession;
    mediaSession = undefined;
    void previous?.session.close();
    dropGuest();
  }
  let attached = false;
  let closed = false;
  let revision = 0;

  function hide() {
    ++revision;
    if (attached && !window.isDestroyed()) window.contentView.removeChildView(guest);
    attached = false;
  }

  function dropGuest() {
    hide();
    if (guest && !guest.webContents.isDestroyed()) guest.webContents.close();
    guest = undefined;
  }

  async function authorizeMedia(interactive) {
    if (!guest || closed) return;
    if (connecting) { if (interactive) requestAfterCheck = true; return; }
    const view = guest, capturedAccount = localAccount;
    connecting = true;
    try {
      const selected = await recordingSession(owner, interactive);
      if (!selected) {
        if (guest === view) setWaitingForGrant(false);
        return;
      }
      if (guest !== view || closed || capturedAccount !== accountId()) { await selected.session.close(); return; }
      attachSession(selected);
    } catch (error) {
      if (guest !== view || closed || capturedAccount !== accountId()) return;
      setWaitingForGrant(error.code === 'MEDIA_GRANT_PENDING');
      if (interactive && !waitingForGrant) await dialog.showMessageBox(window, {type:'info', message:'录音智能体授权', detail:error.message});
    } finally {
      connecting = false;
      const pending = requestAfterCheck;
      requestAfterCheck = false;
      if (pending && !interactive && !mediaSession && guest === view) void authorizeMedia(true);
    }
  }
  const refresh = setInterval(() => {
    if (guest && !mediaSession) void authorizeMedia(false);
  }, 30000);
  refresh.unref();
  function startWorker(viewKey) {
    const entry = path.join(resourceDirectory, "server.mjs");
    if (!existsSync(entry)) throw new Error("配件服务资源未安装");
    const processHandle = spawn(process.execPath, [entry], {
      cwd: resourceDirectory,
      env: {
        ...toolEnvironment(),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: app.getPath("home"),
        ELECTRON_RUN_AS_NODE: "1",
        PORT: "0",
        HOST: "127.0.0.1",
        ...mediaSession?.env, RECORDING_VIEW_KEY: viewKey,
        RECORDING_MODULE_PROFILE: "accessories",
        RECORDING_ACCESSORY_DATA: path.join(dataDirectory, createHash('sha256').update(localAccount).digest('hex')),
        ...(mediaSession?.data ? {RECORDING_LEGACY_DATA:mediaSession.data} : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let offered = false;
    processHandle.on("message", async message => {
      if (worker !== processHandle) return;
      if (message?.type === 'nas-request') {
        let result, error;
        try { result = await nasRequest({app,client,memoryFile,dialog,window}, message.op, message.input); }
        catch (e) { error = e.message; }
        if (processHandle === worker && processHandle.connected)
          processHandle.send({type:'nas-result',id:message.id,result,error}, () => {});
        return;
      }
      if (message?.type === 'recording-media-ready') {
        if (guest && !guest.webContents.isDestroyed()) void guest.webContents.executeJavaScript("window.dispatchEvent(new Event('recording-authorization'))").catch(() => {});
        return;
      }
      if (message?.type === "recording-first-use" && !offered && !mediaSession && !waitingForGrant && client.snapshot().phase === 'ready') {
        offered = true;
        void authorizeMedia(true);
        return;
      }
      const active = mediaSession;
      if (message?.type !== "accessory-memory" || worker !== processHandle) return;
      const p = message.payload;
      let memoryId;
      try {
        active.session.assertLive();
        if (!p || !/^[a-f0-9]{64}$/.test(p.requestId) || !["disk","clip"].includes(p.kind) ||
            !/^m-\d{8}-\d{6}-[a-f0-9]{6}$/.test(p.project) || typeof p.content !== "string" || !Number.isSafeInteger(p.version)) throw new Error();
        const {base, token} = await readMemoryConnection(memoryFile());
        active.session.assertLive();
        const response = await fetch(new URL("/api/v1/memory/add", base), {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
          headers: {"content-type":"application/json", "x-memmy-local-token":token},
          body: JSON.stringify({content:p.content, title:p.title, createdAt:p.createdAt, requestId:p.requestId,
            turnId:p.requestId, layer:"L1", source:"accessories", sourceAgentId:"accessories", adapterId:"agent-source:accessories",
            tags:["accessories", p.kind, p.project, "version-" + p.version], deferProcessing:true}),
        });
        if (response.ok) { const result = await response.json(); if (typeof result.id === "string") memoryId = result.id; }
      } catch { /* The project remains available for a retry. */ }
      if (processHandle.connected) processHandle.send({type:"memory-result", id:message.id, memoryId}, () => {});
    });
    worker = processHandle;
    processHandle.stderr.resume();
    return new Promise((resolve, reject) => {
      let prefix = "";
      const deadline = setTimeout(() => {
        processHandle.kill();
        reject(new Error("配件服务启动超时"));
      }, 10000);
      processHandle.once("error", error => {
        clearTimeout(deadline);
        reject(error);
      });
      processHandle.once("exit", () => {
        clearTimeout(deadline);
        reject(new Error("配件服务服务已结束"));
        if (worker !== processHandle) return;
        worker = undefined;
        dropGuest();
      });
      processHandle.stdout.setEncoding("utf8");
      processHandle.stdout.on("data", chunk => {
        if (prefix === null) return;
        prefix = (prefix + chunk).slice(-2048);
        const url = /http:\/\/127\.0\.0\.1:\d{1,5}\/accessories(?=\r?\n)/.exec(prefix)?.[0];
        if (url) {
          prefix = null;
          clearTimeout(deadline);
          resolve(new URL(url));
        }
      });
    });
  }

  async function loadGuest() {
    const capturedAccount = accountId();
    if (!capturedAccount) throw new Error('请先登录半人马AI记忆盒子再使用录音配件。');
    localAccount = capturedAccount;
    const viewKey = randomBytes(32).toString("hex");
    const entry = await startWorker(viewKey);
    if (closed || accountId() !== capturedAccount) throw new Error("录音工作台会话已结束");
    const view = new WebContentsView({ webPreferences: {
      partition: "wanx-recording-" + viewKey,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    } });
    guest = view;
    const contents = view.webContents;
    contents.session.webRequest.onBeforeSendHeaders({ urls: [entry.origin + "/*"] }, (details, done) => {
      done({ requestHeaders: { ...details.requestHeaders, "X-Recording-View": viewKey } });
    });
    const isDisc = wc => wc === contents && wc.getURL().split("#")[0] === entry.origin + "/accessories/disk";
    contents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(
      permission === "media" && isDisc(wc) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio"));
    contents.session.setPermissionCheckHandler((wc, permission, origin, details) =>
      permission === "media" && isDisc(wc) && (origin === entry.origin || origin.startsWith(entry.origin + "/")) && details.mediaType === "audio");
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      const destination = new URL(url);
      if (destination.origin !== entry.origin || !accessoryPage.test(destination.pathname)) event.preventDefault();
      if (destination.origin === entry.origin && destination.pathname === "/accessories/connect") void authorizeMedia(true);
    });
    contents.on("will-redirect", event => event.preventDefault());
    await contents.loadURL(entry.href);
    void authorizeMedia(false);
    return view;
  }

  async function show(input) {
    if (input?.visible === false) {
      hide();
      return { status: "hidden" };
    }
    const bounds = input?.visible === true && !closed && !window.isDestroyed() ? boundsInWindow(window, input.bounds) : null;
    if (!bounds) return { status: "unavailable" };
    const request = ++revision;
    if (!guest && !preparing) {
      preparing = loadGuest().catch(error => {
        dropGuest();
        worker?.kill();
        worker = undefined;
        onError(error);
        return null;
      }).finally(() => { preparing = undefined; });
    }
    const view = preparing ? await preparing : guest;
    if (!view || view.webContents.isDestroyed()) return { status: "unavailable" };
    if (request !== revision || closed || window.isDestroyed()) return { status: "hidden" };
    if (input.project && ["disk","clip"].includes(input.project.kind) && /^m-\d{8}-\d{6}-[a-f0-9]{6}$/.test(input.project.id)) {
      const current = new URL(view.webContents.getURL());
      const url = current.origin + "/accessories/" + input.project.kind + "#" + input.project.id;
      if (current.href !== url) await view.webContents.loadURL(url);
      if (request !== revision || closed || window.isDestroyed()) return {status:"hidden"};
    }
    view.setBounds(bounds);
    if (!attached) window.contentView.addChildView(view);
    attached = true;
    return { status: "ready" };
  }

  function close() {
    closed = true;
    clearInterval(refresh);
    stopAccount?.();
    resetRuntime();
    const processHandle = worker;
    worker = undefined;
    processHandle?.kill();
  }

  window.once("closed", close);
  return { show, close };
}
