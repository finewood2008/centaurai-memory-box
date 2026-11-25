import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readMemoryConnection } from "./local-memory-runtime.mjs";
import { nasRequest, spaceVolumeRequest } from "./accessory-nas.mjs";
import { recordingSession } from "./accessory-media-session.mjs";
import { dataInteractionKey } from "../device-trust/data-context.mjs";


function toolEnvironment() {
  const common = ["/opt/homebrew/opt/ffmpeg-full/bin", "/opt/homebrew/bin", "/usr/local/bin"];
  const executable = name => common.map(directory => path.join(directory, name)).find(existsSync);
  return {
    PATH: [process.env.PATH, ...common].filter(Boolean).join(path.delimiter),
    ...(executable("ffmpeg") ? { FFMPEG_BIN: executable("ffmpeg") } : {}),
    ...(executable("ffprobe") ? { FFPROBE_BIN: executable("ffprobe") } : {}),
  };
}

export const ACCESSORY_SCHEME = "wanx-accessories";
const catalogFiles = new Set(["/accessories", "/app.js", "/style.css", "/accessories.css",
  "/box-connection.css", "/accessory-art.svg", "/centaurai-mark.png", "/favicon.svg"]);

export function createAccessoriesPreview({ app, window, BrowserWindow, navigate, resourceDirectory, dataDirectory, memoryFile, ensureMemory, client, account, dialog, safeStorage, onError }) {
  let worker, catalog, revision = 0;
  let runtime;
  const windows = new Map();
  const names = { disk: "会议录音智能体", clip: "随身录音智能体" };
  const validKind = kind => kind === "disk" || kind === "clip";
  let localAccount;
  const accountId = () => account?.snapshot().phase === 'authenticated' ? account.getIdentity()?.accountId : null;
  const owner = { app, client, safeStorage };
  const connectionKey = () => dataInteractionKey(client.snapshot());
  let lastConnection = connectionKey();
  let connectionRevision = 0;
  function sendConnection(contents) {
    return contents.executeJavaScript("window.dispatchEvent(new CustomEvent('recording-box-connection',{detail:" + Boolean(connectionKey()) + "}))");
  }
  function syncConnection() {
    const next = connectionKey();
    if (next === lastConnection) return;
    lastConnection = next;
    ++connectionRevision;
    invalidateCatalog();
    if (mediaSession || !next) attachSession(null);
    for (const agentWindow of windows.values()) {
      if (!agentWindow.isDestroyed()) void sendConnection(agentWindow.webContents).catch(() => {});
    }
    if (next && windows.size) void connectMedia();
  }
  function requireBox(expected = connectionKey()) {
    if (!expected || expected !== connectionKey()) throw Object.assign(new Error("连接盒子后可使用配件功能。"), {code:"BOX_CONNECTION_REQUIRED"});
    return expected;
  }
  let mediaSession, unwatch, connecting = false;
  function refreshMediaView() {
    for (const agentWindow of windows.values()) {
      if (!agentWindow.isDestroyed()) {
        void agentWindow.webContents.executeJavaScript("window.dispatchEvent(new Event('recording-media-status'))").catch(() => {});
      }
    }
  }
  function attachSession(next) {
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
    if (localAccount && accountId() !== localAccount) { resetRuntime(); }
  });
  function resetRuntime() {
    runtime = undefined;
    invalidateCatalog();
    for (const agentWindow of windows.values()) agentWindow.destroy();
    windows.clear();
    const processHandle = worker;
    worker = undefined;
    processHandle?.kill();
    const stop = unwatch;
    unwatch = undefined;
    stop?.();
    const previous = mediaSession;
    mediaSession = undefined;
    void previous?.session.close();
  }
  let closed = false;

  function invalidateCatalog() {
    ++revision;
    catalog = undefined;
  }

  async function connectMedia(retry = false) {
    const openedOn = connectionKey();
    if (closed || !runtime || !windows.size || !openedOn || localAccount !== accountId()) return;
    if (connecting || (!retry && mediaSession)) return;
    const view = runtime, capturedAccount = localAccount, generation = connectionRevision;
    const current = () => !closed && runtime === view && capturedAccount === accountId()
      && openedOn === connectionKey() && generation === connectionRevision;
    connecting = true;
    try {
      const selected = await recordingSession(owner);
      if (!selected) return;
      if (!current()) { await selected.session.close(); return; }
      attachSession(selected);
    } catch (error) {
      if (!current()) return;
      if (retry) onError?.(error);
      refreshMediaView();
    } finally {
      connecting = false;
      if (!current()) void connectMedia();
    }
  }
  const refresh = setInterval(() => {
    void connectMedia();
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
    processHandle.on("message", async message => {
      if (worker !== processHandle) return;
      if (message?.type === 'nas-request') {
        let result, error;
        try { const context = {app,client,memoryFile,dialog,window};
          result = message.op === 'volume-status'
            ? { connected:(await spaceVolumeRequest(context, {op:'volumes'})).length > 0 }
            : await nasRequest(context, message.op, message.input); }
        catch (e) { error = e.message; }
        if (processHandle === worker && processHandle.connected)
          processHandle.send({type:'nas-result',id:message.id,result,error}, () => {});
        return;
      }
      if (message?.type === 'recording-media-ready') {
        refreshMediaView();
        return;
      }
      const active = mediaSession;
      if (message?.type !== "accessory-memory" || worker !== processHandle) return;
      const p = message.payload;
      let memoryId;
      try {
        const assertOwner = () => {
          if (!localAccount || accountId() !== localAccount || worker !== processHandle) throw new Error("配件会话已结束");
          if (p.localOnly !== true) active.session.assertLive();
        };
        assertOwner();
        if (!p || !/^[a-f0-9]{64}$/.test(p.requestId) || !["disk","clip"].includes(p.kind) ||
            !/^m-\d{8}-\d{6}-[a-f0-9]{6}$/.test(p.project) || typeof p.content !== "string" || !Number.isSafeInteger(p.version)) throw new Error();
        await ensureMemory?.();
        const {base, token} = await readMemoryConnection(memoryFile());
        assertOwner();
        const source = p.kind === "disk" ? "meeting_recording" : "portable_recording";
        const response = await fetch(new URL("/api/v1/memory/add", base), {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
          headers: {"content-type":"application/json", "x-memmy-local-token":token},
          body: JSON.stringify({content:p.content, title:p.title, createdAt:p.createdAt, requestId:p.requestId,
            turnId:p.requestId, layer:"L1", source, sourceAgentId:source, adapterId:"agent-source:" + source,
            tags:["accessories", p.kind, p.project, "version-" + p.version]}),
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
        resetRuntime();
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

  function ensureRuntime() {
    const id = accountId();
    if (!id || closed) throw new Error("请先登录半人马AI-记忆盒子再使用配件。");
    if (runtime && localAccount === id) return runtime;
    resetRuntime();
    localAccount = id;
    const viewKey = randomBytes(32).toString("hex");
    const pending = startWorker(viewKey).then(entry => {
      if (runtime !== pending || accountId() !== id) throw new Error("配件会话已结束");
      return {entry, viewKey};
    }).catch(error => {
      if (runtime === pending) resetRuntime();
      throw error;
    });
    runtime = pending;
    return pending;
  }

  const preferences = partition => ({
    partition, contextIsolation:true, sandbox:true, nodeIntegration:false, webSecurity:true,
  });

  function configure(contents, {entry, viewKey}, kind) {
    contents.session.webRequest.onBeforeSendHeaders({ urls: [entry.origin + "/*"] }, (details, done) => {
      done({ requestHeaders: { ...details.requestHeaders, "X-Recording-View": viewKey, "X-Recording-Agent": kind || "catalog" } });
    });
    const isDisc = wc => wc === contents && wc.getURL().split("#")[0] === entry.origin + "/accessories/disk";
    contents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(
      kind === "disk" && permission === "media" && isDisc(wc) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio"));
    contents.session.setPermissionCheckHandler((wc, permission, origin, details) =>
      kind === "disk" && permission === "media" && isDisc(wc) && (origin === entry.origin || origin.startsWith(entry.origin + "/")) && details.mediaType === "audio");
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on('before-input-event',(event,input)=>{
      if(input.type==='keyDown' && !input.isAutoRepeat && (input.meta || input.control) && input.shift && input.key.toLowerCase()==='k'){
        event.preventDefault();window.show();window.focus();navigate('global-guide');
      }
    });
    if (kind) contents.on("did-finish-load", () => { void sendConnection(contents).catch(() => {}); });
    contents.on("will-navigate", (event, url) => {
      const destination = new URL(url);
      event.preventDefault();
      if (destination.origin !== entry.origin) return;
      if (destination.pathname === '/accessories/connect-box') {
        window.show(); window.focus(); navigate('box-connection'); return;
      }
      if (!connectionKey() && !['/accessories/guide-capture','/accessories/guide-memory'].includes(destination.pathname)) return;
      if (['/accessories/guide-capture','/accessories/guide-memory'].includes(destination.pathname)){
        const capture=destination.searchParams.get('capture');
        const target=validKind(kind) && destination.pathname.endsWith('capture') ? {
          destination:'guide-capture', label:names[kind], capture: ['on','off'].includes(capture)?capture:'unknown'
        } : destination.pathname.endsWith('memory')?'memory':'guide-capture';
        window.show();window.focus();navigate(target);return;
      }
      if (destination.pathname === "/accessories/connect") {
        void connectMedia(true);
      }
    });
    contents.on("will-redirect", event => event.preventDefault());
  }

  async function openAgent(kind, id) {
    const openedOn = requireBox();
    if (!validKind(kind) || (id !== undefined && !/^m-\d{8}-\d{6}-[a-f0-9]{6}$/.test(id))) throw new Error("录音项目无效");
    const connection = await ensureRuntime();
    requireBox(openedOn);
    const url = new URL("/accessories/" + kind, connection.entry);
    if (id) url.hash = id;
    let agentWindow = windows.get(kind);
    if (!agentWindow) {
      agentWindow = new BrowserWindow({
        title:names[kind], width:1050, height:760, minWidth:650, minHeight:480,
        show:false, backgroundColor:"#faf7f2",
        webPreferences:preferences("wanx-recording-" + kind + "-" + connection.viewKey),
      });
      windows.set(kind, agentWindow);
      agentWindow.once("closed", () => { if (windows.get(kind) === agentWindow) windows.delete(kind); });
      configure(agentWindow.webContents, connection, kind);
      try { await agentWindow.loadURL(url.href); }
      catch (error) { if (!agentWindow.isDestroyed()) agentWindow.destroy(); throw error; }
      await sendConnection(agentWindow.webContents);
      void connectMedia();
    } else if (id) {
      await agentWindow.webContents.executeJavaScript("window.dispatchEvent(new CustomEvent('recording-open-project',{detail:" + JSON.stringify(id) + "}))");
    }
    requireBox(openedOn);
    if (agentWindow.isMinimized()) agentWindow.restore();
    agentWindow.show();
    agentWindow.focus();
    return {status:"ready"};
  }

  function activeCatalog(selected) {
    return selected && selected === catalog && !closed && localAccount === accountId()
      && selected.box === connectionKey();
  }

  // Only the catalog's public assets and its two hardware indicators are exposed
  // to the embedded origin. Recording windows keep their own session and permissions.
  async function handleCatalog(request) {
    const url = new URL(request.url);
    const selected = catalog;
    if (!activeCatalog(selected) || url.host !== selected.host) return new Response(null, {status:403});
    const volume = request.method === "POST" && url.pathname === "/api/nas/volume-status";
    if (!volume && !(request.method === "GET" && (catalogFiles.has(url.pathname) || url.pathname === "/api/usb-inputs")))
      return new Response(null, {status:404});
    try {
      const {entry, viewKey} = selected.connection;
      const headers = {"X-Recording-View":viewKey, "X-Recording-Agent":"catalog"};
      if (volume) headers["Content-Type"] = "application/json";
      const response = await fetch(new URL(url.pathname, entry), {
        method:request.method, headers, body:volume ? "{}" : undefined, redirect:"error", signal:request.signal,
      });
      const bytes = await response.arrayBuffer();
      if (!activeCatalog(selected)) return new Response(null, {status:403});
      return new Response(bytes, {status:response.status, headers:{
        "content-type":response.headers.get("content-type"), "cache-control":"no-store",
        "content-security-policy":"default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors file:",
        "x-content-type-options":"nosniff",
      }});
    } catch {
      return new Response(null, {status:503});
    }
  }

  async function show(input) {
    if (input?.visible === false) {
      invalidateCatalog();
      return {status:"hidden"};
    }
    const box = requireBox();
    if (input?.project) return openAgent(input.project.kind, input.project.id);
    if (input?.guideOpen && activeCatalog(catalog) && input.catalogHost === catalog.host) {
      if (validKind(input.guideOpen)) return openAgent(input.guideOpen);
      if (input.guideOpen === "storage") { navigate("space"); return {status:"ready"}; }
    }
    if (input?.visible !== true || closed || window.isDestroyed() || !accountId()) return {status:"unavailable"};
    const pending = ensureRuntime();
    const ticket = ++revision;
    const connection = await pending;
    if (ticket !== revision || box !== connectionKey() || localAccount !== accountId() || closed) return {status:"hidden"};
    catalog = {host:randomBytes(16).toString("hex") + ".local", connection, box};
    return {status:"ready", catalogHost:catalog.host};
  }

  function close() {
    closed = true;
    clearInterval(refresh);
    stopAccount?.();
    resetRuntime();
  }

  window.once("closed", close);
  return { show, handleCatalog, syncConnection, close };
}
