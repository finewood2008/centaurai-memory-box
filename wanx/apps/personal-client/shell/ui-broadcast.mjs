// MemoBox omits environment badges, but still needs main-owned deployment
// provenance to select local removal rather than ordinary market mutations.
export const projectApplicationsForUI = records => records.map(({presentation,managedLocal,...record}) => ({
  ...record,
  managedLocal: record.installationSource === 'selfmade' && record.deployment?.schemaVersion === 1 &&
    ['wanx-miniapp-v1','wanx-expert-app-v1'].includes(record.deployment.profile) &&
    record.deployment.slotApplicationId === record.applicationId &&
    Number.isSafeInteger(record.deployment.generation) && record.deployment.generation > 0,
}));

export function sendToLiveFrame(window, channel, ...args) {
  if (!window || window.isDestroyed()) return false;
  try {
    const contents = window.webContents;
    if (!contents || contents.isDestroyed() || contents.isCrashed()) return false;
    const frame = contents.mainFrame;
    // Electron 37 can keep detached set on a recovered primary frame.
    if (!frame || frame.isDestroyed()) return false;
    frame.send(channel, ...args);
    return true;
  } catch (error) {
    // Electron can release the native frame while its JS wrapper still exists.
    if (error.message === "Render frame was disposed before WebFrameMain could be accessed" ||
        error.message === "Object has been destroyed") return false;
    throw error;
  }
}

// Account and connection state must reach the UI without waiting for disk reads
// or an app installation. Installed apps refresh in the background and publish
// separately; reads from a previous account/connection can never replace them.
export function createUIBroadcast({ client, applications, uiState, startup, updates, defaultApplications, notifications, windows, onError = () => {} }) {
  let closed = false, scope, installed = [], reading = null, refreshAgain = false;
  function snapshot() {
    const state = client.snapshot();
    const nextScope = JSON.stringify([state.account?.phase, state.account?.accountId, state.account?.clientId,
      state.connection?.deviceId, state.connection?.mode, state.dataIdentity]);
    if (nextScope !== scope) {
      scope = nextScope;
      installed = [];
      reading = null;
      refreshAgain = false;
    }
    return { ...state, applications: structuredClone(installed), ui: uiState.snapshot(), desktopStartup: startup.get(),
      ...(notifications ? { notifications: notifications.snapshot() } : {}),
      ...(defaultApplications ? { defaultApplications: defaultApplications.snapshot() } : {}),
      ...(updates ? { upgrades: { client: updates.client.snapshot(), box: updates.box.snapshot() } } : {}) };
  }
  function deliver(state) {
    if (closed) return;
    for (const window of windows()) sendToLiveFrame(window, "wanx-client:state", state);
  }
  function refresh() {
    if (closed) return;
    if (reading) { refreshAgain = true; return; }
    const currentScope = scope;
    const work = Promise.resolve().then(() => applications.listInstalled());
    reading = work;
    void work.then(projectApplicationsForUI).then(value => {
      snapshot(); // Invalidate a stale read even if no state event was emitted.
      if (closed || currentScope !== scope || reading !== work) return;
      installed = structuredClone(value);
      deliver(snapshot());
    }).catch(onError).finally(() => {
      if (reading !== work) return;
      reading = null;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    });
  }
  function getState() {
    const state = snapshot();
    refresh();
    return state;
  }
  function publish() {
    if (closed) return;
    deliver(getState());
  }
  return { getState, publish, dispose() { closed = true; reading = null; } };
}
