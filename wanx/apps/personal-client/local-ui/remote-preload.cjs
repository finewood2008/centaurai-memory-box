const { contextBridge, ipcRenderer, webUtils } = require("electron");

function errorCode(error) {
  return String(error?.code || error?.message || "CLIENT_REQUEST_FAILED");
}

async function creditsRead(method, input) {
  const value = await ipcRenderer.invoke(`wanx-client:credits-${method}`, input);
  if (value?.ok === false && value.code === "CREDITS_NOT_CONFIGURED")
    throw Object.assign(new Error(value.code), { code: value.code });
  return value;
}

async function walletRequest(method, input) {
  const result = await ipcRenderer.invoke(`wanx-client:wallet-${method}`, input);
  if (result?.ok !== true) {
    const error = result?.error || { code: "CREDITS_INVALID_RESPONSE" };
    throw Object.assign(new Error(error.code), error);
  }
  return result.value;
}

function projectState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const account = source.account || { phase: "signed_out" };
  const authenticated = account.phase === "authenticated";
  const localMode = Boolean(source.dataIdentity?.profileId);
  const localUnlocked = localMode && source.dataIdentity.phase === "unlocked";
  const availableIdentity = localMode ? localUnlocked : authenticated;
  const connection = source.connection || null;
  const networkAvailable = source.network?.enabled !== false &&
    source.platform?.phase === "ready" && ["ready", "recovering"].includes(source.network?.phase);
  const networkReady = networkAvailable && source.network?.phase === "ready";
  // Existing connections follow confirmed data-path health, not management churn.
  const selected = source.dataIdentity?.selected;
  const connected = source.phase === "ready" && Boolean(connection?.deviceId) && (localMode
    ? localUnlocked && connection.authorization === "local-trust-v1" && selected?.boxId === connection.deviceId && Boolean(selected?.sessionId)
    : authenticated && (connection.mode === "local" || (networkAvailable && connection.mode === "netbird")));
  const dataOwnerId = localUnlocked && selected ? JSON.stringify(["local-trust-v1", source.dataIdentity.profileId,
    selected.boxId, selected.boxKeyThumbprint, selected.ownershipEpoch, selected.principalId]) : null;
  const dataContextId = connected && localMode ? JSON.stringify([dataOwnerId, source.dataIdentity.clientId,
    source.dataIdentity.generation, selected.bindingId, selected.authorizationVersion, selected.sessionId]) : null;
  const devices = Array.isArray(source.devices)
    ? source.devices.map((device) => ({
        ...device,
        name: device.displayName || device.deviceId,
        lifecycle: device.accessState === "ready" ? "ready" : "unavailable",
        initialized: device.accessState === "ready",
      }))
    : [];

  return {
    ...source,
    connectionPhase: source.phase || "disconnected",
    dataOwnerId, dataContextId,
    route: availableIdentity ? "memory" : "auth",
    phase: !availableIdentity
      ? account.phase === "authenticating"
        ? "authenticating"
        : "signed_out"
      : connected
        ? "connected"
        : "idle",
    account: {
      ...account,
      displayName: account.profile?.displayName || "万象用户",
    },
    devices,
    networkReady: localMode ? localUnlocked : networkReady,
    canLaunchApplications: connected,
    canOpenDashboard: connected && Boolean(connection.gatewayURL),
    availableDevices: devices.filter((device) => device.accessState === "ready"),
    selectedDeviceId: connection?.deviceId || null,
    activeDeviceId: connected ? connection.deviceId : null,
    provisioning: { phase: "idle", stage: null, error: null },
    diagnostics: {
      phase: source.platform?.phase || "idle",
      message: source.platform?.reason || null,
    },
  };
}

async function rawState() {
  return ipcRenderer.invoke("wanx-client:get-state");
}

const actions = {
  "help.faq": input => ipcRenderer.invoke("wanx-client:help-faq", { etag: input?.etag }),
  "help.feedback": async input => {
    const result = await ipcRenderer.invoke("wanx-client:help-feedback", {
      content: input?.content, contact: input?.contact, categoryId: input?.categoryId, itemId: input?.itemId,
    });
    if (result?.ok !== true) {
      const code = /^(?:FAQ_FEEDBACK_[A-Z_]+|ACCOUNT_(?:NETWORK_ERROR|CANCELLED|INVALID_INPUT|INVALID_RESPONSE|REDIRECT_REJECTED))$/.test(result?.code || "")
        ? result.code : "FAQ_FEEDBACK_UNAVAILABLE";
      const userMessage = code === "FAQ_FEEDBACK_INVALID_CONTENT" && typeof result.userMessage === "string"
        ? [...result.userMessage.replace(/[\x00-\x1f\x7f]/g, "").trim()].slice(0, 200).join("") : undefined;
      throw Object.assign(new Error(code), { code, ...(userMessage ? { userMessage } : {}),
        ...(code === "FAQ_FEEDBACK_RATE_LIMITED" ? { limitScope: result.limitScope === "day" ? "day" : "minute",
          retryAfterSeconds: Number.isFinite(result.retryAfterSeconds) && result.retryAfterSeconds > 0
            ? Math.min(86400, Math.ceil(result.retryAfterSeconds)) : 60 } : {}) });
    }
    return result.value;
  },

  workshop: input => ipcRenderer.invoke("wanx-client:workshop",input),
  ...Object.fromEntries(["material-workflows","material-workflow","material-preview","material-transition","material-transition-status"].map(action=>["data."+action,input=>ipcRenderer.invoke("wanx-client:data",{action,input})])),
  ...Object.fromEntries(["document-text","correct","evidence","authorization-summary","governance-summary","governance-reviews","governance-detail","governance-resolve","governance-flag","governance-propose","governance-apply","governance-unflag"].map(action=>["data."+action,input=>ipcRenderer.invoke("wanx-client:data",{action,input})])),
  ...Object.fromEntries(["initialize","warehouses","warehouse","create-warehouse","rename-warehouse","select-warehouse","documents","document","delete-document","jobs","graph","retrieval","search","retry-job","build-index","processing","reprocess-models","select-files","select-space-files","space-list","release-files","upload","open-starlink","share-details","create-share-key","revoke-share-key","reveal-share-key","copy-share-key","copy-share-value","release-share-key"].map(action=>["data."+action,input=>ipcRenderer.invoke("wanx-client:data",{action,input})])),
  ...Object.fromEntries(["load","open","send","stop","watch","unwatch","model","legacy-open","upload","release","resume","artifact","history-update","history-export","space-list","space-grant","release-context","knowledge-list","knowledge-grant","knowledge-evidence","usage","polish","version","version-select","handoff","channels-list","channels-detail","channels-save","channels-toggle","channels-delete","channels-test","channels-start","channels-poll","channels-cancel","channels-verification","channels-verify-start","channels-verify-confirm","channels-verify-revoke","history-list"].map(method => [`dialogue.${method}`, input => ipcRenderer.invoke(`wanx-client:ai-dialogue-${method}`, input)])),
  "notifications.read": input => ipcRenderer.invoke("wanx-client:notifications-read", { id: input?.id, all: input?.all === true }),
  "notifications.refresh": () => ipcRenderer.invoke("wanx-client:notifications-refresh"),
  "notifications.open": input => ipcRenderer.invoke("wanx-client:notifications-open", { id: input?.id }),
  "wallet.quote": input => walletRequest("quote", input),
  "wallet.catalog": () => walletRequest("catalog"),
  "wallet.balance": () => walletRequest("balance"),
  "wallet.wallet": () => walletRequest("wallet"),
  "wallet.usage": input => walletRequest("usage", input),
  "wallet.orders": input => walletRequest("orders", input),
  "wallet.order": input => walletRequest("order", input),
  "wallet.entries": input => walletRequest("entries", input),
  "wallet.calls": input => walletRequest("calls", input),
  "wallet.call": input => walletRequest("call", input),
  "wallet.summary": input => walletRequest("summary", input),
  "wallet.createOrder": input => walletRequest("createOrder", input),
  "wallet.closeOrder": input => walletRequest("closeOrder", input),
  "profile.save": input => ipcRenderer.invoke("wanx-client:profile-save", { displayName: input?.displayName }),
  "profile.avatar": () => ipcRenderer.invoke("wanx-client:profile-avatar"),
  "profile.avatar-remove": () => ipcRenderer.invoke("wanx-client:profile-avatar-remove"),
  "credits.tasks": () => creditsRead("tasks"),
  "credits.balance": () => creditsRead("balance"),
  "credits.transactions": input => creditsRead("transactions", { after: input?.after }),
  "credits.reservation": input => creditsRead("reservation", { id: input?.id }),
  "auth.login": (input) =>
    ipcRenderer.invoke("wanx-client:login-password", {
      phone: input?.username,
      password: input?.password,
      remember: input?.remember,
    }),
  "auth.send-code": (input) =>
    ipcRenderer.invoke("wanx-client:send-registration-code", { phone: input?.username }),
  "auth.register": (input) =>
    ipcRenderer.invoke("wanx-client:register", { phone: input?.username, password: input?.password, code: input?.code }),
  "auth.send-reset-code": (input) =>
    ipcRenderer.invoke("wanx-client:send-reset-code", { phone: input?.username }),
  "auth.reset-password": (input) =>
    ipcRenderer.invoke("wanx-client:reset-password", { phone: input?.username, code: input?.code, password: input?.password }),
  "auth.send-change-code": () => ipcRenderer.invoke("wanx-client:send-change-code"),
  "auth.change-password": (input) =>
    ipcRenderer.invoke("wanx-client:change-password", { code: input?.code, password: input?.password }),
  "auth.logout": () => ipcRenderer.invoke("wanx-client:logout"),
  "auth.forget-login": (input) => ipcRenderer.invoke("wanx-client:remembered-login-forget", input?.phone === undefined ? undefined : { phone: input.phone }),
  "devices.refresh": () => ipcRenderer.invoke("wanx-client:refresh-devices"),
  "device-trust.open": () => ipcRenderer.invoke("wanx-client:device-trust-open"),
  "devices.discovery": (input) => ipcRenderer.invoke("wanx-client:discovery-devices", { deviceIds: input?.deviceIds }),
  "devices.claim": (input) => ipcRenderer.invoke("wanx-client:console-claim", { claimCode: input?.claimCode, clientAttemptId: input?.clientAttemptId,
    ...(input?.expectedDeviceId === undefined ? {} : { expectedDeviceId: input.expectedDeviceId }) }),
  "devices.claim-status": (input) => ipcRenderer.invoke("wanx-client:console-claim-status", { deviceId: input?.deviceId }),
  "ownership.list": () => ipcRenderer.invoke("wanx-client:ownership-list"),
  "support.current": input => ipcRenderer.invoke("wanx-client:support-current", { deviceId: input?.deviceId }),
  "support.decide": input => ipcRenderer.invoke("wanx-client:support-decide", {
    deviceId: input?.deviceId, ownershipEpoch: input?.ownershipEpoch, requestId: input?.requestId,
    requestDigest: input?.requestDigest, decision: input?.decision, confirmed: input?.confirmed,
  }),
  "support.revoke": input => ipcRenderer.invoke("wanx-client:support-revoke", {
    deviceId: input?.deviceId, ownershipEpoch: input?.ownershipEpoch, requestId: input?.requestId,
    requestDigest: input?.requestDigest, supportSessionId: input?.supportSessionId, confirmed: input?.confirmed,
  }),
  "ownership.send-code": () => ipcRenderer.invoke("wanx-client:ownership-send-code"),
  "ownership.create": (input) => ipcRenderer.invoke("wanx-client:ownership-create", input),
  "ownership.accept": (input) => ipcRenderer.invoke("wanx-client:ownership-accept", input),

  "devices.connect": (input) =>
    ipcRenderer.invoke("wanx-client:connect-box", input?.deviceId),
  "devices.disconnect": () => ipcRenderer.invoke("wanx-client:disconnect"),
  "maintenance.open": (input) => ipcRenderer.invoke("wanx-client:maintenance-open", { tool: input?.tool, deviceId: input?.deviceId }),
  "applications.list": () => ipcRenderer.invoke("wanx-client:applications-list"),
  "applications.install-local": () => ipcRenderer.invoke("wanx-client:applications-local-install"),
  "applications.uninstall-local": input => ipcRenderer.invoke("wanx-client:applications-local-uninstall", { applicationId: input?.applicationId }),
  "applications.rollback-local": input => ipcRenderer.invoke("wanx-client:applications-local-rollback", { applicationId: input?.applicationId }),
  "market.list": () => ipcRenderer.invoke("wanx-client:market-list"),
  "market.candidate": (input) => ipcRenderer.invoke("wanx-client:market-candidate", { applicationId: input?.applicationId }),
  "market.install": (input) => ipcRenderer.invoke("wanx-client:market-install", { applicationId: input?.applicationId }),
  "market.uninstall": (input) => ipcRenderer.invoke("wanx-client:market-uninstall", { applicationId: input?.applicationId }),
  "market.rollback": (input) => ipcRenderer.invoke("wanx-client:market-rollback", { applicationId: input?.applicationId }),
  "applications.launch": (input) => ipcRenderer.invoke("wanx-client:applications-launch", input),
  "applications.request-open": (input) => ipcRenderer.invoke("wanx-client:applications-request-open", input),
  "applications.confirm-open": (input) => ipcRenderer.invoke("wanx-client:applications-confirm-open", input),
  "applications.cancel-open": (input) => ipcRenderer.invoke("wanx-client:applications-cancel-open", input),
  "desktop.startup.get": () => ipcRenderer.invoke("wanx-client:desktop-startup-get"),
  "desktop.startup.set": (input) => ipcRenderer.invoke("wanx-client:desktop-startup-set", input),
  "desktop.about": () => ipcRenderer.invoke("wanx-client:desktop-about"),
  "desktop.quit": () => ipcRenderer.invoke("wanx-client:desktop-quit"),
  "applications.select-current": (input) => ipcRenderer.invoke("wanx-client:applications-select-current", input),
  "applications.stop": (input) => ipcRenderer.invoke("wanx-client:applications-stop", input),
  ...Object.fromEntries([
    ...["check", "download", "install"].map(method => ["client", method]),
    ...["check", "plan", "execute", "status", "cancel", "resume"].map(method => ["box", method]),
  ].map(([product, method]) => [`updates.${product}.${method}`, input => ipcRenderer.invoke(`wanx-client:updates-${product}-${method}`, input)])),
};

for (const method of ["snapshot", "refresh", "stat", "list", "mkdir", "move", "trash", "restore", "purge", "uploads", "download", "downloads", "transfer", "preview", "cancel-preview", "restore-version"])
  actions[`space.${method}`] = input => ipcRenderer.invoke(`wanx-client:space-${method}`, input);

for (const method of ["share-create", "share-list", "share-detail", "share-copy", "share-revoke", "share-dismiss", "spaces", "space-manage", "file-transfer", "storage-set", "storage-choose", "mcp-reset-endpoint","mcp-drives","mcp-manage","mcp-rotate","mcp-state", "mcp-issue", "mcp-revoke", "mcp-grant", "mcp-revoke-grant", "mcp-folders", "mcp-archive", "mcp-prompt", "mcp-copy"])
  actions[`space.links-${method}`] = input => ipcRenderer.invoke(`wanx-client:space-links-${method}`, input);

for (const method of ["snapshot","refresh","capture","paste","choose","transfer","copy","preview","download","manage","export","note-save","note-refresh","note-command","note-paste"])
  actions[`clipboard.${method}`] = input => ipcRenderer.invoke(`wanx-client:clipboard-${method}`, input);

async function action(name, input = {}) {
  const handler = actions[name];
  if (!handler)
    return { ok: false, code: "UNKNOWN_CLIENT_ACTION", state: await getLocalState() };
  try {
    const value = await handler(input);
    return { ok: true, value, state: await getLocalState() };
  } catch (error) {
    let rawCode = errorCode(error);
    if (name === "help.faq") rawCode = rawCode.match(/(?:^|Error: )(FAQ_RATE_LIMITED|FAQ_UNAVAILABLE|FAQ_INVALID_RESPONSE|ACCOUNT_NETWORK_ERROR|ACCOUNT_CANCELLED|ACCOUNT_INVALID_INPUT)$/)?.[1] || "FAQ_UNAVAILABLE";
    if (name === "help.feedback") rawCode = rawCode.match(/(?:^|Error: )((?:FAQ_FEEDBACK_[A-Z_]+|ACCOUNT_(?:NETWORK_ERROR|CANCELLED|INVALID_INPUT|INVALID_RESPONSE|REDIRECT_REJECTED)))$/)?.[1] || "FAQ_FEEDBACK_UNAVAILABLE";
    const clipboardCode = rawCode.match(/(?:^|Error: )((?:CLIPBOARD|SPACE|BOX|ACCOUNT|SECURE_STORAGE)_[A-Z0-9_]+)$/)?.[1];
    const dialogueCode = rawCode.match(/(?:^|Error: )([A-Z][A-Z0-9_]{1,80})$/)?.[1];
    if (name === "workshop")
      return { ok: false, code: dialogueCode || "WORKSHOP_REQUEST_FAILED", state: await getLocalState() };
    return { ok: false, code: (name.startsWith("dialogue.") || name.startsWith("data.")) ? dialogueCode || "DIALOGUE_REQUEST_FAILED" : name.startsWith("clipboard.") ? clipboardCode || "CLIPBOARD_OPERATION_FAILED" : rawCode, state: await getLocalState(),
      ...(name === "help.feedback" && rawCode === "FAQ_FEEDBACK_RATE_LIMITED" ? { limitScope: error.limitScope, retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(name === "help.feedback" && rawCode === "FAQ_FEEDBACK_INVALID_CONTENT" && error.userMessage ? { userMessage: error.userMessage } : {}),
      ...(name.startsWith("wallet.") ? { request_id: error.request_id || null, details: error.details || {},
        retryable: error.retryable === true, status: error.status || null } : {}) };
  }
}

async function getLocalState() {
  return projectState(await rawState());
}

contextBridge.exposeInMainWorld(
  "wanxClient",
  Object.freeze({
    getLocalState,
    openMemory: () => ipcRenderer.invoke("wanx-client:memory-open"),
    localMemoryStorage: input => ipcRenderer.invoke("wanx-client:local-memory-storage", input),
    memoryBackup: input => ipcRenderer.invoke("wanx-client:memory-backup", input),
    onFaqUpdated: listener => {
      const handler = () => listener();
      ipcRenderer.on("wanx-client:faq-updated", handler);
      return () => ipcRenderer.removeListener("wanx-client:faq-updated", handler);
    },
    onWorkshopSource: listener => {const handler=(_event,value)=>listener(value);ipcRenderer.on('wanx-client:workshop-source',handler);return()=>ipcRenderer.removeListener('wanx-client:workshop-source',handler);},
    onWorkshopChanged: listener => {const fn=()=>listener();ipcRenderer.on('wanx-client:workshop-changed',fn);return()=>ipcRenderer.removeListener('wanx-client:workshop-changed',fn)},
    listRememberedLogins: () => ipcRenderer.invoke("wanx-client:remembered-login-list"),
    getRememberedLogin: (phone) => ipcRenderer.invoke("wanx-client:remembered-login-get", phone === undefined ? undefined : { phone }),
    recordPaymentTiming: (input) => ipcRenderer.invoke("wanx-client:credit-payment-timing", input),
    action,
    async uploadDroppedFiles(files, input = {}) {
      try {
        if (!Array.isArray(files) || !files.length) throw new Error("SPACE_INVALID_DROP");
        const paths = files.map(file => webUtils.getPathForFile(file));
        if (paths.some(file => !file)) throw new Error("SPACE_INVALID_DROP");
        const value = await ipcRenderer.invoke("wanx-client:space-upload-dropped", { parent: input.parent || "", paths, names: files.map(file => file.name), ...(input.scope ? {scope: input.scope} : {}), ...(input.space_id ? {space_id: input.space_id} : {}) });
        if (value?.uploadRejection) return { ok: false, ...value.uploadRejection };
        return { ok: true, value };
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
    },
    async clipboardFiles(files, input={}) {
      try {
        if(!Array.isArray(files)||!files.length||files.length>20)throw new Error("CLIPBOARD_LIMIT");
        if(files.some(file=>file.size>20*1024*1024))throw new Error("CLIPBOARD_LIMIT");
        const paths=files.map(file=>webUtils.getPathForFile(file));
        let payload;
        if(paths.every(Boolean))payload={paths};
        else if(files.length===1&&["image/png","image/jpeg","image/gif","image/webp"].includes(files[0].type))payload={image:Buffer.from(await files[0].arrayBuffer()).toString("base64"),name:files[0].name,mime:files[0].type};
        else throw new Error("CLIPBOARD_VIRTUAL_FILE");
        return await action("clipboard.capture",{...payload,scope:input.scope});
      }catch(error){return {ok:false,code:errorCode(error)};}
    },
    onClipboardState(listener) {
      const receive=(_event,state)=>listener(state);ipcRenderer.on("wanx-client:clipboard-state",receive);
      return ()=>ipcRenderer.removeListener("wanx-client:clipboard-state",receive);
    },
    checkHealth: async () => ({
      ok: false,
      code: "DIAGNOSTIC_UNAVAILABLE",
      state: await getLocalState(),
    }),
    onLocalState(listener) {
      const receive = (_event, state) => listener(projectState(state));
      ipcRenderer.on("wanx-client:state", receive);
      return () => ipcRenderer.removeListener("wanx-client:state", receive);
    },
    onAIDialogue(listener) {
      const receive = (_event, value) => listener(value);
      ipcRenderer.on("wanx-client:ai-dialogue", receive);
      return () => ipcRenderer.removeListener("wanx-client:ai-dialogue", receive);
    },
    onSpaceContentChanged(listener) {
      const receive = () => listener();
      ipcRenderer.on("wanx-client:space-content-changed", receive);
      return () => ipcRenderer.removeListener("wanx-client:space-content-changed", receive);
    },
    onSpaceState(listener) {
      const receive = (_event, state) => listener(state);
      ipcRenderer.on("wanx-client:space-state", receive);
      return () => ipcRenderer.removeListener("wanx-client:space-state", receive);
    },
    onNavigate(listener) {
      const receive = (_event, page) => {
        if (["my-ai", "memory", "applications", "ai-dialogue", "space", "boxes", "settings", "profile", "credits", "notifications"].includes(page)) listener(page);
      };
      ipcRenderer.on("wanx-client:navigate", receive);
      return () => ipcRenderer.removeListener("wanx-client:navigate", receive);
    },
  }),
);

const setupCall = async (method, input) => {
  const result = await ipcRenderer.invoke(`wanx:setup:${method}`, input);
  if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
  return result.value;
};
let setupReady = false;
ipcRenderer.on("wanx:setup:ready", () => { setupReady = true; });

contextBridge.exposeInMainWorld("wanxSetup", {
  state: () => setupReady ? setupCall("state") : Promise.reject(Object.assign(new Error("SETUP_NOT_READY"), { code: "SETUP_NOT_READY" })),
  begin: (candidate) => setupCall("begin", candidate),
  resume: (input = {}) => setupCall("resume", input),
  confirmPhysical: () => setupCall("confirmPhysical"),
  scanWifi: () => setupCall("scanWifi"),
  wifi: (input) => setupCall("wifi", input),
  confirmOwnership: () => setupCall("confirmOwnership"),
  redeemClaimCode: (input) => setupCall("redeemClaimCode", { claimCode: input?.claimCode, clientAttemptId: input?.clientAttemptId }),
  refresh: () => setupCall("refresh"),
  cancel: () => setupCall("cancel"),
  reset: () => setupCall("reset"),
  subscribe: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("wanx:setup:state", handler);
    return () => ipcRenderer.removeListener("wanx:setup:state", handler);
  },
  onReady: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("wanx:setup:ready", handler);
    return () => ipcRenderer.removeListener("wanx:setup:ready", handler);
  },
});

contextBridge.exposeInMainWorld("wanxSetupTransport", {
  scanTimeoutMs: process.platform === "win32" ? 60000 : 30000,
  subscribe: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on("wanx:setup:transport", handler);
    return () => ipcRenderer.removeListener("wanx:setup:transport", handler);
  },
  reply: (result) => ipcRenderer.send("wanx:setup:transport-result", result),
  status: (connectionId, frame) => ipcRenderer.send("wanx:setup:transport-status", { connectionId, frame }),
});

contextBridge.exposeInMainWorld("wanxDiscovery", {
  bluetoothState: () => ipcRenderer.invoke("wanx:discovery:bluetooth-state"),
  openBluetoothSettings: async (section = "bluetooth") => {
    const result = await ipcRenderer.invoke("wanx:discovery:open-bluetooth-settings", section);
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
  },
  subscribe: (onCandidates, onSettled) => {
    const candidates = (_event, payload) => onCandidates(payload);
    const settled = (_event, payload) => onSettled(payload);
    ipcRenderer.on("nexusaos:discovery:candidates", candidates);
    ipcRenderer.on("nexusaos:discovery:settled", settled);
    return () => {
      ipcRenderer.removeListener("nexusaos:discovery:candidates", candidates);
      ipcRenderer.removeListener("nexusaos:discovery:settled", settled);
    };
  },
  cancel: (sessionId) => ipcRenderer.send("nexusaos:discovery:cancel", { sessionId }),
  select: (sessionId, candidateId) => ipcRenderer.send("nexusaos:discovery:select", { sessionId, candidateId }),
  reselect: (sessionId, candidateId) => ipcRenderer.send("nexusaos:discovery:reselect", { sessionId, candidateId }),
  forget: (sessionId) => ipcRenderer.send("nexusaos:discovery:forget", { sessionId }),
});
