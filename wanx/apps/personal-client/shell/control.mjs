import {projectApplicationsForUI} from './ui-broadcast.mjs';
import { displayCreditAtoms, validateCreditWallet } from "../account/credit-wallet.mjs";

import {PANEL_NOTE_METHODS,panelNoteState} from './panel-note.mjs';
import { panelSpaceState } from "./panel-space.mjs";
import { isControlSender } from "./security.mjs";
import { dataInteractionKey, dataOwnerKey } from "../device-trust/data-context.mjs";
import { backupSourcePattern } from "./memory-backup.mjs";
import { ANNOTATION_WORKBENCH_CONTRACT, validateWorkbenchInput } from "./annotation-workbench-contract.mjs";

// Electron IPC errors omit custom fields. Return only this locally generated
// validation notice; all other errors retain their existing sanitization.
async function uploadResult(action) {
  try { return await action(); }
  catch (error) {
    if (error.code !== "SPACE_UPLOAD_LIMIT") throw error;
    return { uploadRejection: { code: error.code, message: error.message } };
  }
}

function text(value, max, code) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(code);
  return value.trim();
}
function phone(input) {
  const value = text(input?.phone, 32, "invalid_phone");
  if (!/^1\d{10}$/.test(value)) throw new Error("invalid_phone");
  return value;
}

function requireConnectedBox(state) {
  if (state.dataIdentity?.profileId || state.connection?.authorization === "local-trust-v1") {
    if (!dataInteractionKey(state)) throw new Error("BOX_CONNECTION_REQUIRED");
    return;
  }
  if (state.account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
  if (state.phase === "ready" && state.connection?.mode === "local" && state.connection.deviceId) return;
  if (state.network?.enabled === false || state.platform?.phase !== "ready" || !["ready", "recovering"].includes(state.network?.phase))
    throw new Error("NETWORK_NOT_READY");
  if (state.phase !== "ready" || state.connection?.mode !== "netbird" || !state.connection.deviceId)
    throw new Error("BOX_CONNECTION_REQUIRED");
}

export function openConnectedDashboard(client, dashboards, destination, deviceId) {
  const state = client.snapshot();
  requireConnectedBox(state);
  if (state.dataIdentity?.profileId || state.connection?.authorization === "local-trust-v1")
    throw new Error("LOCAL_DATA_HOST_CONTROL_DENIED");
  if (!state.connection.gatewayURL) throw new Error("BOX_CONNECTION_REQUIRED");
  if (destination && state.connection.deviceId !== deviceId) throw new Error("BOX_CONNECTION_CHANGED");
  return dashboards.open(state, destination);
}

// Remote dashboards have no account bridge. Check the exact control main frame
// for every action, including reads, and never accept network credentials here.
export function registerControlActions({
  ipcMain,
  control,
  controlURL,
  panel,
  panelURL,
  client,
  applications,
  dashboards,
  selectApplicationArchive,
  market,
  personalSpace,
  superClipboard,
  spaceLinks,
  confirmSpacePurge,
  updates,
  credits,
  creditWallet,
  accountProfile,
  notifications,
  aiDialogue, personalDataService, personalWorkshop, starlinkPanel,
  support,
  uiState,
  desktop,
  getState,
  publishState = () => {},
  getDesktopStartup,
  setDesktopStartup,
  showAbout,
  openDeviceTrust,
  openMemoryWorkspace,
  localMemoryStorage,
  memoryBackup,
  quit,
  allowDevelopmentInstall = false,
  confirmLocalApplicationArchive,
  timings = null,
}) {
  const panelActions = new Set([
    "get-state", "applications-list", "applications-request-open", "applications-confirm-open",
    "applications-cancel-open",
    "desktop-open", "desktop-hide", "desktop-resize", "desktop-about", "panel-balance", "panel-application-names",
    "panel-space-snapshot", "panel-space-refresh", "panel-space-upload", "panel-space-transfer", "panel-note",
  ]);
  const reads = new Set(["help-faq", "space-links-mcp-state", "space-links-mcp-folders", "space-links-mcp-archive", "space-links-mcp-prompt", "panel-note", "panel-application-names", "support-current", "panel-space-snapshot", "panel-space-refresh", "panel-balance", "credits-tasks", "credits-balance", "credits-transactions", "credits-reservation", "get-state", "discovery-devices", "console-claim-status", "remembered-login-get", "remembered-login-list", "applications-list", "market-list", "market-candidate", "desktop-startup-get", "desktop-resize", "credit-payment-timing"]);
  const register = (name, action) => {
    ipcMain.handle(`wanx-client:${name}`, (event, argument) => {
      const management = isControlSender(event, control, controlURL);
      if (!management && !(panelActions.has(name) && isControlSender(event, panel, panelURL)))
        throw new Error("此页面无权操作记忆盒子连接。");
      if (["applications-launch", "applications-request-open", "applications-confirm-open", "studio-preview-open"].includes(name) ||
          /^(?:panel-)?ai-dialogue-(?:send|resume|version)$/.test(name)) updates?.client?.assertUsable?.();
      // Keep validation synchronous; mutations also refresh both trusted windows.
      const result = action(argument);
      if (reads.has(name) || (name.startsWith("ai-dialogue-") || name.startsWith("panel-ai-dialogue-"))) return result;
      return Promise.resolve(result).finally(() => publishState());
    });
  };
  reads.add("memory-open");
  register("memory-open", () => openMemoryWorkspace?.() ?? { available: false });
  reads.add("local-memory-storage");
  reads.add("memory-backup");
  register("memory-backup", async ({ action, sourceId, id, digest, context } = {}) => {
    if (!["status", "catalog", "enable", "disable", "backup", "restore", "rollback"].includes(action) ||
        (sourceId !== undefined && (typeof sourceId !== "string" || !backupSourcePattern.test(sourceId))) ||
        (id !== undefined && (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))) ||
        (digest !== undefined && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) ||
        (context !== undefined && (typeof context !== "string" || !/^[a-f0-9]{64}$/.test(context)))) {
      return { error: "无效的记忆备份操作。" };
    }
    try { return { result: await memoryBackup?.(action, { sourceId, id, digest, context }) }; }
    catch (error) {
      return { error: error.code ? ({
        SPACE_DISK_FULL: "盒子空间不足，请腾出空间后重试。",
        SPACE_NOT_FOUND: "所选文件夹或备份已移走。",
        SPACE_CHUNK_INVALID: "备份完整性校验失败，请重试。",
      }[error.code] || "无法读取或写入盒子空间，请检查连接后重试。") : error.message };
    }
  });
  register("local-memory-storage", async ({ action, name } = {}) => {
    if (!["get", "initialize", "open", "choose", "mkdir", "reset"].includes(action))
      throw new Error("无效的本机目录操作。");
    try { return { storage: await localMemoryStorage?.(action, { name }) }; }
    catch (error) {
      const directoryError = { EEXIST: "同名文件夹已存在。", ENOSPC: "磁盘空间不足。", EACCES: "没有此文件夹的写入权限。", EPERM: "没有此文件夹的写入权限。" };
      return { error: error.code ? directoryError[error.code] || "无法处理此本机文件夹。" : error.message };
    }
  });
  register("workshop", ({action,input} = {}) => {
    if (!personalWorkshop) throw Error("WORKSHOP_UNAVAILABLE");
    return personalWorkshop.action(action,input);
  });
  register("data", ({action,input} = {}) => {
    if (!personalDataService) throw Error("SEMANTICA_NOT_CONFIGURED");
    return personalDataService.action(action,input);
  });
  reads.add('starlink');
  register('starlink', ({action,input} = {}) => {
    if (!starlinkPanel) throw Error('SEMANTICA_NOT_CONFIGURED');
    return starlinkPanel.action(action,input);
  });
  const creditsRead = async action => {
    try { return await action(); }
    catch (error) {
      if (error?.code === "CREDITS_NOT_CONFIGURED" || error?.message === "CREDITS_NOT_CONFIGURED")
        return { ok: false, code: "CREDITS_NOT_CONFIGURED" };
      throw error;
    }
  };
  register("device-trust-open", (input) => {
    if (input != null && (typeof input !== "object" || Array.isArray(input) || Object.keys(input).length))
      throw new Error("LOCAL_TRUST_INVALID_INPUT");
    if (!openDeviceTrust) throw new Error("LOCAL_TRUST_UNAVAILABLE");
    return openDeviceTrust();
  });
  for (const method of ["sidebar-memory","sidebar-mode","sidebar-source","sidebar-source-list","sidebar-memmy","sidebar-memory-cancel","load","open","send","stop","watch","unwatch","model","legacy-open","upload","release","resume","artifact","history-update","history-export","space-list","space-grant","release-context","knowledge-list","knowledge-grant","knowledge-evidence","usage","version","version-select","handoff","channels-list","channels-detail","channels-save","channels-toggle","channels-delete","channels-test","channels-start","channels-poll","channels-cancel","channels-verification","channels-verify-start","channels-verify-confirm","channels-verify-revoke","history-list"]) register(`ai-dialogue-${method}`, input => {
    if (!aiDialogue) throw new Error("DIALOGUE_UNAVAILABLE");
    return aiDialogue.action(method, input);
  });
  for (const action of ["share-create", "share-list", "share-detail", "share-copy", "share-revoke", "share-dismiss", "spaces", "space-manage", "file-transfer", "storage-set", "storage-choose", "mcp-reset-endpoint","mcp-drives","mcp-manage","mcp-rotate","mcp-state", "mcp-issue", "mcp-revoke", "mcp-grant", "mcp-revoke-grant", "mcp-folders", "mcp-archive", "mcp-prompt", "mcp-copy"]) {
    register(`space-links-${action}`, input => {
      if (!spaceLinks) throw new Error("SPACE_LINK_UNAVAILABLE");
      return spaceLinks.manage(action, input);
    });
  }
  const requirePanelSpace = (scope, offline = false) => {
    if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
    if (offline && !dataOwnerKey(client.snapshot())) throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (!offline) requireConnectedBox(client.snapshot());
    if (!scope || scope !== personalSpace.snapshot().scope) throw new Error("SPACE_CONTEXT_CHANGED");
  };
  register("panel-space-snapshot", () => {
    if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
    return panelSpaceState(personalSpace.snapshot());
  });
  register("panel-space-refresh", async () => {
    if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
    requireConnectedBox(client.snapshot());
    return panelSpaceState(await personalSpace.refresh());
  });
  register("panel-space-upload", async (input = {}) => {
    requirePanelSpace(input.scope);
    if (!Array.isArray(input.paths) || !input.paths.length) throw new Error("SPACE_INVALID_DROP");
    await personalSpace.refresh();
    requirePanelSpace(input.scope);
    return uploadResult(() => personalSpace.uploads("", input.paths, input.scope, input.names));
  });
  register("panel-space-transfer", (input = {}) => {
    requirePanelSpace(input.scope, true);
    if (!["pause", "resume", "pause-batch", "resume-batch", "retry-batch"].includes(input.action)) throw new Error("PANEL_ACTION_NOT_ALLOWED");
    if (!(input.action.endsWith("-batch") ? personalSpace.snapshot().imports?.some(batch => batch.id === input.id) : personalSpace.snapshot().tasks.some(task => task.id === input.id && task.direction === "upload")))
      throw new Error("SPACE_NOT_FOUND");
    return personalSpace.transfer(input.action, input.id);
  });
  reads.add("space-annotation-workbench-contract");
  reads.add("space-annotation-workbench");
  reads.add("space-redaction-rules");
  reads.add("space-open-text-edit");
  register("space-annotation-workbench-contract", () => ANNOTATION_WORKBENCH_CONTRACT);
  for (const method of ["snapshot", "refresh", "stat", "list", "mkdir", "move", "trash", "restore", "purge", "uploads", "download", "downloads", "transfer", "preview", "cancel-preview", "open-text-edit", "save-text-edit", "restore-version", "annotation", "set-annotation", "auto-annotate", "search-annotations", "annotation-workbench", "redaction-rules", "save-redaction-rules", "redact"]) {
    register(`space-${method}`, async (input = {}) => {
      if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
      if (method === "annotation-workbench") return personalSpace.operation(method, validateWorkbenchInput(input));
      if (method === "cancel-preview") return personalSpace.cancelPreview();
      if (method === "snapshot" || method === "refresh") return personalSpace[method]();
      if (method === "downloads") return personalSpace.downloads(input.ids);
      if (method === "uploads") return uploadResult(() => personalSpace.uploads(input.parent || "", undefined, input.scope, undefined, input.space_id || "personal", input.folders === true));
      if (method === "preview") {
        try { return await personalSpace.preview(input.id, {interactive: input.interactive === true}); }
        catch (error) {
          if (!["SPACE_PREVIEW_DOWNLOAD", "SPACE_PREVIEW_TOO_LARGE", "SPACE_PREVIEW_UNSUPPORTED"].includes(error.code)) throw error;
          return { previewRejection: error.code };
        }
      }
      if (method === "download") return personalSpace.download(input.id);
      if (method === "transfer") return personalSpace.transfer(input.action, input.id);
      if (method === "purge") {
        const scope = personalSpace.snapshot().scope;
        if (!(await confirmSpacePurge?.())) return { canceled: true };
        if (scope !== personalSpace.snapshot().scope) throw new Error("SPACE_CONTEXT_CHANGED");
      }
      return personalSpace.operation(method, input);
    });
  }
  register("panel-note", async (input={}) => {
    if(!superClipboard)throw new Error("CLIPBOARD_UNAVAILABLE");
    const {method,scope,...args}=input;
    if(!PANEL_NOTE_METHODS.has(method))throw new Error("PANEL_ACTION_NOT_ALLOWED");
    if(method!=="snapshot"&&(!scope||scope!==superClipboard.snapshot().scope))throw new Error("SPACE_CONTEXT_CHANGED");
    if(["preview","copy","download"].includes(method)&&!superClipboard.snapshot(args.noteId).note?.blocks?.some(b=>b.type==="image"&&b.item===args.id)&&!superClipboard.snapshot().tasks?.some(t=>t.kind==="image"&&t.id===args.id))throw new Error("CLIPBOARD_NOT_FOUND");
    if(method==="transfer"&&!['pause','resume'].includes(args.action))throw new Error("PANEL_ACTION_NOT_ALLOWED");
    if(method==="note-command"&&!['clear','restore','local','remote','recover-local','create','delete'].includes(args.action))throw new Error("PANEL_ACTION_NOT_ALLOWED");
    return panelNoteState(await superClipboard.operation(method,{...args,...(["choose","download"].includes(method)?{panel:true}:{})}));
  });
  for (const method of ["snapshot","refresh","capture","paste","choose","transfer","copy","preview","download","manage","export","note-save","note-refresh","note-command","note-paste"]) {
    register(`clipboard-${method}`, async (input={}) => {
      if(!superClipboard)throw new Error("CLIPBOARD_UNAVAILABLE");
      if(method!=="snapshot" && input.scope!==superClipboard.snapshot().scope)throw new Error("SPACE_CONTEXT_CHANGED");
      if(method==="manage" && input.action==="purge") {
        if(!(await confirmSpacePurge?.()))return {canceled:true};
        if(input.scope!==superClipboard.snapshot().scope)throw new Error("SPACE_CONTEXT_CHANGED");
      }
      const {scope,...args}=input;
      return superClipboard.operation(method,args);
    });
  }
  register("space-upload-dropped", (input = {}) => {
    if (!personalSpace) throw new Error("SPACE_UNAVAILABLE");
    if (!Array.isArray(input.paths) || !input.paths.length) throw new Error("SPACE_INVALID_DROP");
    return uploadResult(() => personalSpace.uploads(input.parent || "", input.paths, input.scope, input.names, input.space_id || "personal"));
  });
  register("panel-application-names", async () => {
    if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (!market) return [];
    const { items } = await market.list();
    return items.map(({ applicationId, name, iconUrl }) => ({ applicationId, name, ...(iconUrl ? { iconUrl } : {}) }));
  });
  register("panel-balance", () => creditsRead(async () => {
    if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (creditWallet) {
      const summary = (await creditWallet.balance()).data;
      const wallet = summary.billing_backend === "qeetoken" ? (await creditWallet.wallet()).data : summary;
      if (summary.billing_backend === "qeetoken") validateCreditWallet(wallet, client.snapshot().account.accountId);
      return { available_text: wallet.balance_credit_atoms == null ? null : displayCreditAtoms(wallet.balance_credit_atoms),
        sync_state: wallet.sync_state || "synced" };
    }
    if (!credits) throw new Error("CREDITS_NOT_CONFIGURED");
    const balance = await credits.balance();
    return { available: balance.available };
  }));
  for (const method of ["balance", "transactions", "reservation", "tasks"]) {
    register(`credits-${method}`, (input) => creditsRead(() => {
      if (!credits) throw new Error("CREDITS_NOT_CONFIGURED");
      return credits[method](input);
    }));
  }
  for (const method of ["catalog", "quote", "balance", "wallet", "usage", "orders", "order", "entries", "calls", "call", "summary", "createOrder", "closeOrder"]) {
    if (!["createOrder", "closeOrder"].includes(method)) reads.add(`wallet-${method}`);
    register(`wallet-${method}`, async input => {
      try {
        if (client.snapshot().account?.phase !== "authenticated") throw Object.assign(new Error(), { code: "ACCOUNT_LOGIN_REQUIRED" });
        if (!creditWallet) throw Object.assign(new Error(), { code: "CONTRACT_NOT_CONFIGURED" });
        return { ok: true, value: await creditWallet[method](input) };
      } catch (error) {
        // Electron does not preserve custom Error fields. Use a narrow result
        // record so the UI retains contract codes and support request IDs.
        return { ok: false, error: {
          code: /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code || "") ? error.code : "CREDITS_REQUEST_FAILED",
          status: Number.isInteger(error?.status) ? error.status : null,
          request_id: error?.request_id || null,
          retryable: error?.retryable === true,
          details: error?.details || {},
        } };
      }
    });
  }
  register("credit-payment-timing", input => timings?.creditPayment(input));
  for (const method of ["read", "refresh", "open"]) register(`notifications-${method}`, async input => {
    if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (!notifications) throw new Error("NOTIFICATIONS_UNAVAILABLE");
    if (method === "refresh") return notifications.refresh();
    if (method === "read") return notifications.markRead(input?.all === true ? { all: true } : { id: text(input?.id, 64, "NOTIFICATION_INVALID_ID") });
    const target = notifications.target(text(input?.id, 64, "NOTIFICATION_INVALID_ID"));
    if (starlinkPanel && target.applicationId === 'centaurai.wanx.semantica') return { destination: 'data' };
    if (target.category === "application") return { destination: "applications" };
    if (target.applicationId) return uiState.requestOpen(target.applicationId);
    if (target.category === "task") return { destination: "notifications" };
  });
  for (const [action, method] of [["profile-save", "save"], ["profile-avatar", "chooseAvatar"], ["profile-avatar-remove", "removeAvatar"]]) {
    register(action, input => {
      if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
      if (!accountProfile) throw new Error("PROFILE_UNAVAILABLE");
      if (action === "profile-save" && (!input || Object.keys(input).some(key => key !== "displayName"))) throw new Error("PROFILE_INVALID_INPUT");
      return accountProfile[method](input);
    });
  }
  register("get-state", async () => {
    if (getState) return getState();
    const installed = applications ? await applications.listInstalled() : [];
    return { ...client.snapshot(), applications: projectApplicationsForUI(installed) };
  });
  register("login-password", (input) => {
    const number = phone(input);
    if (
      typeof input.password !== "string" ||
      !input.password ||
      Buffer.byteLength(input.password, "utf8") > 72
    )
      throw new Error("invalid_credentials");
    if (input.remember !== undefined && typeof input.remember !== "boolean")
      throw new Error("invalid_credentials");
    return client.loginPassword({ phone: number, password: input.password,
      ...(input.remember !== undefined ? { remember: input.remember } : {}) }, { waitForDevices: false });
  });
  register("remembered-login-list", () => client.listRememberedLogins());
  register("remembered-login-get", (input) => client.getRememberedLogin(input?.phone === undefined ? undefined : phone(input)));
  register("remembered-login-forget", (input) => client.forgetRememberedLogin(input?.phone === undefined ? undefined : phone(input)));
  register("login-sms", (input) => {
    const number = phone(input);
    const code = text(input?.code, 12, "invalid_sms_code");
    if (!/^\d{6}$/.test(code)) throw new Error("invalid_sms_code");
    return client.loginSMS({ phone: number, code }, { waitForDevices: false });
  });
  register("send-sms", (input) => client.sendSMS({ phone: phone(input) }));
  register("send-registration-code", (input) => client.sendSMS({ phone: phone(input), scene: "consumer_register" }));
  register("register", (input) => {
    const number = phone(input);
    if (typeof input.password !== "string" || Buffer.byteLength(input.password, "utf8") < 8 ||
      Buffer.byteLength(input.password, "utf8") > 72 || /[\r\n\0]/.test(input.password))
      throw new Error("invalid_credentials");
    const code = text(input.code, 12, "invalid_sms_code");
    if (!/^\d{6}$/.test(code)) throw new Error("invalid_sms_code");
    return client.register({ phone: number, password: input.password, code }, { waitForDevices: false });
  });
  register("send-reset-code", (input) => client.sendResetCode({ phone: phone(input) }));
  register("send-change-code", () => client.sendChangeCode());
  for (const [action, method] of [["reset-password", "resetPassword"], ["change-password", "changePassword"]]) {
    register(action, (input) => {
      const number = action === "reset-password" ? phone(input) : undefined;
      if (typeof input?.password !== "string" || Buffer.byteLength(input.password, "utf8") < 8 ||
          Buffer.byteLength(input.password, "utf8") > 72 || /[\r\n\0]/.test(input.password))
        throw new Error("invalid_credentials");
      const code = text(input?.code, 6, "invalid_sms_code");
      if (!/^\d{6}$/.test(code)) throw new Error("invalid_sms_code");
      return client[method]({ ...(number ? { phone: number } : {}), code, password: input.password });
    });
  }
  register("logout", () => { uiState?.invalidateOpen(); return client.logout(); });
  register("refresh-devices", () => client.refreshDevices());
  register("discovery-devices", (input) => {
    const ids = input?.deviceIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 ||
        ids.some(id => typeof id !== "string" || !/^centauros-(?:[0-9a-f]{24}|[0-9a-f]{32})$/.test(id)) ||
        new Set(ids).size !== ids.length) throw new Error("ACCOUNT_INVALID_INPUT");
    return client.lookupDeviceDiscovery([...ids]);
  });
  register("console-claim", (input) => {
    if (!input || Object.keys(input).some(key => !["claimCode", "clientAttemptId", "expectedDeviceId"].includes(key)))
      throw new Error("ACCOUNT_INVALID_INPUT");
    return client.redeemConsoleClaim({ claimCode: input.claimCode, clientAttemptId: input.clientAttemptId,
      ...(input.expectedDeviceId === undefined ? {} : { expectedDeviceId: input.expectedDeviceId }) });
  });
  register("console-claim-status", (input) => {
    if (!input || Object.keys(input).some(key => key !== "deviceId")) throw new Error("ACCOUNT_INVALID_INPUT");
    return client.getConsoleClaimAuthorization(text(input.deviceId, 36, "invalid_device"));
  });
  register("ownership-list", () => client.listOwnershipTransfers());
  for (const method of ["current", "decide", "revoke"]) register(`support-${method}`, input => {
    if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
    if (!support) throw new Error("SUPPORT_UNAVAILABLE");
    return support[method](input);
  });
  register("ownership-send-code", () => client.sendTransferCode());
  register("ownership-create", (input) => {
    if (input?.retainData !== true) throw new Error("ACCOUNT_INVALID_INPUT");
    const verificationCode = text(input?.verificationCode, 6, "invalid_sms_code");
    if (!/^\d{6}$/.test(verificationCode)) throw new Error("invalid_sms_code");
    uiState?.invalidateOpen();
    return client.createOwnershipTransfer({ deviceId: text(input?.deviceId, 128, "invalid_device"),
      targetPhone: phone({ phone: input?.targetPhone }), verificationCode, retainData: true });
  });
  register("ownership-accept", (input) => {
    if (input?.retainData !== true) throw new Error("ACCOUNT_INVALID_INPUT");
    uiState?.invalidateOpen();
    return client.acceptOwnershipTransfer({ transferId: text(input?.transferId, 128, "ACCOUNT_INVALID_INPUT"), retainData: true });
  });

  register("connect-box", (deviceId) => {
    const id = text(deviceId, 128, "invalid_device");
    uiState?.invalidateOpen();
    return client.connectBox(id);
  });
  register("connect", (input) => {
    if (input?.mode !== "direct") throw new Error("invalid_network_mode");
    uiState?.invalidateOpen();
    return client.connect({
      mode: "direct",
      deviceId: text(input.deviceId, 128, "invalid_connection"),
      name: text(input.name, 128, "invalid_connection"),
      url: text(input.url, 2048, "invalid_endpoint"),
    });
  });
  register("disconnect", () => { uiState?.invalidateOpen(); return client.disconnect(); });
  register("dashboard-open", () => { throw new Error("DASHBOARD_TERMINAL_ONLY"); });
  register("maintenance-open", (input) => {
    if (!["terminal", "desktop"].includes(input?.tool)) throw new Error("INVALID_MAINTENANCE_TOOL");
    return openConnectedDashboard(client, dashboards, input.tool, text(input.deviceId, 128, "invalid_device"));
  });
  register("applications-list", async () => projectApplicationsForUI(await applications?.listInstalled() || []));
  register("applications-install", (input) => {
    if (!allowDevelopmentInstall) throw new Error("MARKET_SIGNED_PACKAGE_REQUIRED");
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    if (input?.sourceDir !== undefined && input?.archivePath !== undefined) throw new Error("APPLICATION_SOURCE_REQUIRED");
    if (input?.sourceDir !== undefined)
      return applications.install({ sourceDir: text(input.sourceDir, 4096, "invalid_application_source") });
    if (input?.archivePath !== undefined)
      return applications.install({ archivePath: text(input.archivePath, 4096, "invalid_application_source") });
    if (!selectApplicationArchive) throw new Error("APPLICATION_ARCHIVE_PICKER_UNAVAILABLE");
    return selectApplicationArchive().then(archivePath => archivePath
      ? applications.install({ archivePath }) : { canceled: true });
  });
  register("applications-local-install", async (input) => {
    if (input && Object.keys(input).length) throw new Error("APPLICATION_SOURCE_REQUIRED");
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    if (!selectApplicationArchive || !confirmLocalApplicationArchive) throw new Error("APPLICATION_ARCHIVE_PICKER_UNAVAILABLE");
    const archivePath = await selectApplicationArchive();
    if (!archivePath || !await confirmLocalApplicationArchive(archivePath)) return { canceled: true };
    return applications.install({ archivePath });
  });
  register("applications-local-uninstall", input => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    const id = text(input?.applicationId, 64, "invalid_application_id");
    const operation = () => applications.uninstallLocal(id);
    return uiState ? uiState.runApplicationOperation(id, "uninstalling", operation) : operation();
  });
  register("applications-local-rollback", input => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    const id = text(input?.applicationId, 64, "invalid_application_id");
    const operation = () => applications.rollback(id);
    return uiState ? uiState.runApplicationOperation(id, "rolling-back", operation) : operation();
  });
  register("applications-launch", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    const state = client.snapshot();
    requireConnectedBox(state);
    const id = text(input?.applicationId, 64, "invalid_application_id");
    return applications.launch(id);
  });
  register("applications-select-current", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    const id = text(input?.applicationId, 64, "invalid_application_id");
    const version = text(input?.version, 64, "INVALID_APPLICATION_VERSION");
    const operation = () => applications.selectCurrent(id, version);
    return uiState ? uiState.runApplicationOperation(id, "selecting", operation) : operation();
  });
  register("applications-stop", (input) => {
    if (!applications) throw new Error("APPLICATIONS_UNAVAILABLE");
    return applications.stop(text(input?.applicationId, 64, "invalid_application_id"));
  });
  register("applications-request-open", (input) => {
    const id = text(input?.applicationId, 64, "invalid_application_id");
    if (!uiState) throw new Error("APPLICATIONS_UNAVAILABLE");
    return uiState.requestOpen(id);
  });
  register("applications-confirm-open", (input) => {
    if (!uiState) throw new Error("APPLICATIONS_UNAVAILABLE");
    return uiState.confirmOpen({ intentId: text(input?.intentId, 128, "invalid_intent"), deviceId: text(input?.deviceId, 128, "invalid_device") });
  });
  register("applications-cancel-open", (input) => {
    if (!uiState) throw new Error("APPLICATIONS_UNAVAILABLE");
    return uiState.cancelOpen({ intentId: text(input?.intentId, 128, "invalid_intent") });
  });
  register("desktop-open", (input) => {
    if (!["my-ai", "memory", "ai-dialogue", "space", "boxes", "settings", "credits", "profile", "notifications"].includes(input?.page)) throw new Error("invalid_page");
    desktop?.showManagement(input.page);
  });
  register("desktop-hide", () => desktop?.hidePanel());
  register("desktop-resize", (input) => {
    if (!Number.isFinite(input?.height)) throw new Error("invalid_panel_height");
    desktop?.resizePanel(Math.max(240, Math.min(560, Math.ceil(input.height))));
  });
  register("desktop-startup-get", () => getDesktopStartup?.());
  register("desktop-startup-set", (input) => {
    if (typeof input?.enabled !== "boolean") throw new Error("invalid_startup_setting");
    return setDesktopStartup?.(input.enabled);
  });
  register("help-faq", input => client.faq(input));
  register("help-feedback", async input => {
    try { return { ok: true, value: await client.faqFeedback(input) }; }
    catch (error) {
      const code = /^(?:FAQ_FEEDBACK_[A-Z_]+|ACCOUNT_(?:NETWORK_ERROR|CANCELLED|INVALID_INPUT|INVALID_RESPONSE|REDIRECT_REJECTED))$/.test(error?.code || "")
        ? error.code : "FAQ_FEEDBACK_UNAVAILABLE";
      const userMessage = code === "FAQ_FEEDBACK_INVALID_CONTENT" && typeof error.userMessage === "string"
        ? [...error.userMessage.replace(/[\x00-\x1f\x7f]/g, "").trim()].slice(0, 200).join("") : undefined;
      return { ok: false, code, ...(userMessage ? { userMessage } : {}),
        ...(code === "FAQ_FEEDBACK_RATE_LIMITED" ? { limitScope: error.limitScope, retryAfterSeconds: error.retryAfterSeconds } : {}) };
    }
  });

  register("desktop-about", () => showAbout?.());
  register("desktop-quit", () => quit?.());
  for (const [product, methods] of [["client", ["check", "download", "install"]], ["box", ["check", "plan", "execute", "status", "cancel", "resume"]]]) {
    for (const method of methods) register(`updates-${product}-${method}`, input => {
      if (!updates?.[product]) throw new Error("UPDATE_NOT_CONFIGURED");
      if (client.snapshot().account?.phase !== "authenticated") throw new Error("ACCOUNT_LOGIN_REQUIRED");
      if (["install", "execute", "resume"].includes(method) && input?.confirmed !== true) throw new Error("UPDATE_CONFIRMATION_REQUIRED");
      return updates[product][method](input || {});
    });
  }
  for (const method of ["list", "candidate", "install", "uninstall", "rollback"]) {
    register(`market-${method}`, (input) => {
      if (!market) throw new Error("MARKET_UNAVAILABLE");
      if (client.snapshot().account?.phase !== "authenticated")
        throw new Error("ACCOUNT_LOGIN_REQUIRED");
      if (method === "list") return market.list();
      const id = text(input?.applicationId, 64, "invalid_application_id");
      const operation = () => market[method](id);
      if (method === "candidate") {
        const accountId = client.snapshot().account.accountId;
        const result = operation();
        if (notifications) {
          void Promise.resolve(result).then(async value => {
            const installed = (await applications.listInstalled()).some(row => row.applicationId === id);
            if (client.snapshot().account?.accountId === accountId) notifications.candidate(id, value, installed);
          }).catch(() => {}); // Notification observation never changes market results.
        }
        return result;
      }
      if (!uiState) return operation();
      return uiState.runApplicationOperation(id, { install: "installing", uninstall: "uninstalling", rollback: "rolling-back" }[method], operation);
    });
  }
}
