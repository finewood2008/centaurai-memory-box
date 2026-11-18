// The iframe stays mounted while normal client state updates repaint the shell.
// Identity changes destroy it synchronously before another account can render.
window.createStarlinkPanelView = ({ request, changed }) => {
  let scope = '', available = false, visible = false, frame, overlay, anchor, observer;
  let controls, legacyQuickKey, creationEnabled = false, generation = 0;
  function syncCreateButton() {
    const button = document.querySelector('#starlink-banner-create');
    if (button) button.disabled = !(visible && available && creationEnabled);
  }
  const listeners = new Set();
  const trusted = source => available && frame && source === frame.contentWindow;
  function destroy() {
    generation++; listeners.clear(); controls = null; creationEnabled = false;
    syncCreateButton();
    observer?.disconnect(); observer = anchor = null;
    overlay?.remove(); overlay = frame = null;
  }
  function position() {
    if (!overlay || !anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    Object.assign(overlay.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  Object.defineProperty(window, 'wanxStarlinkPanel', { value: Object.freeze({
    connect(source) {
      if (!trusted(source)) throw new Error('UNTRUSTED_FRAME');
      // WindowProxy identity survives iframe reloads. Give each document its
      // own capability, listeners and service reset so old promises cannot
      // submit a retry through the new document's session.
      const current = ++generation;
      listeners.clear(); controls = null; creationEnabled = false;
      syncCreateButton();
      const check = sender => {
        if (sender !== source || !trusted(source)) throw new Error('UNTRUSTED_FRAME');
        if (current !== generation) throw new Error('HOST_SESSION_EXPIRED');
      };
      const ready = Promise.resolve(request('starlink', {action:'reset'})).then(reply => {
        if (reply?.ok !== true) throw new Error(reply?.code || 'HOST_SESSION_EXPIRED');
      });
      // The next call reports reset failures through the normal UI path.
      void ready.catch(() => {});
      return Object.freeze({
        async call(sender, action, input) {
          check(sender);
          await ready; check(sender);
          const result = await request('starlink', { action, input });
          check(sender); return result;
        },
        subscribe(sender, listener) {
          check(sender);
          if (typeof listener !== 'function') throw new Error('UNTRUSTED_FRAME');
          listeners.add(listener); return () => listeners.delete(listener);
        },
        register(sender, value) {
          check(sender); controls = value; controls?.visible?.(visible);
        },
        legacyQuickCreation(sender, completedOperation) {
          check(sender);
          if (!legacyQuickKey) return null;
          const raw = window.localStorage.getItem(legacyQuickKey);
          if (!raw) return null;
          const saved = JSON.parse(raw);
          if (completedOperation === undefined) return saved;
          if (saved?.input?.operationId === completedOperation) window.localStorage.removeItem(legacyQuickKey);
          return null;
        },
        setCreationEnabled(sender, enabled) {
          check(sender);
          creationEnabled = enabled === true;
          syncCreateButton();
        },
      });
    },
  }) });
  window.wanxClient.onStarlinkEvent?.(event => {
    if (event.type === 'invalidated') {
      // A new connection must initialize a new service and a clean document.
      destroy(); changed(); return;
    }
    for (const listener of listeners) listener(event);
  });
  window.addEventListener?.('resize', position);
  return {
    sync(state, personal, active) {
      const nextAvailable = state.canLaunchApplications === true;
      const nextScope = nextAvailable ? JSON.stringify([state.dataOwnerId, state.dataContextId,
        state.account?.accountId, state.account?.clientId, state.connection?.deviceId, state.connection?.gatewayURL]) : '';
      if (scope !== nextScope) {
        destroy(); scope = nextScope;
      }
      const device = state.activeDeviceId || state.connection?.deviceId;
      const owner = state.dataOwnerId || (!state.dataIdentity?.profileId && state.account?.accountId);
      legacyQuickKey = personal && nextAvailable && owner && device
        ? 'wanx.quick-warehouse:' + JSON.stringify(['personal', owner, device, state.dataIdentity?.clientId || state.account?.clientId || null])
        : null;
      available = nextAvailable; visible = active;
      if (overlay) overlay.hidden = !visible;
      controls?.visible?.(visible);
      syncCreateButton();
    },
    action(name) {
      if (name === 'new-warehouse' && visible && available && creationEnabled) return controls?.createWarehouse?.();
    },
    render() {
      return available ? '<section id="starlink-panel-region" class="starlink-panel-region" aria-label="星图"></section>'
        : '<section class="starlink-panel-empty"><h2>星图</h2><p>连接盒子后，创建知识仓、导入资料并浏览知识图谱。</p></section>';
    },
    mount() {
      syncCreateButton();
      if (!visible || !available) return;
      const region = document.getElementById?.('starlink-panel-region');
      if (!region) return;
      anchor = region;
      if (!frame) {
        overlay = document.createElement('div'); overlay.className = 'starlink-panel-overlay';
        frame = document.createElement('iframe'); frame.title = '星图知识工作台';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals allow-downloads allow-forms');
        frame.src = new URL('../starlink/ui/index.html', document.baseURI).href;
        overlay.append(frame); document.body.append(overlay);
      }
      overlay.hidden = false;
      observer?.disconnect(); observer = new ResizeObserver(position); observer.observe(anchor);
      position();
    },
    needsLoad: () => false, refresh: async () => {},
    isComposing: () => false, retainInput: () => null,
  };
};
