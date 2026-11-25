// The iframe stays mounted while normal client state updates repaint the shell.
// Identity changes destroy it synchronously before another account can render.
window.createStarlinkPanelView = ({ request, changed }) => {
  let scope = '', available = false, visible = false, frame, overlay, anchor, observer, positionFrame;
  let controls, legacyQuickKey, directoryEnabled = false, generation = 0;
  let banner = null;
  function syncBannerButtons() {
    const inView = visible && available;
    const project = document.querySelector('#starlink-banner-project');
    const upload = document.querySelector('#starlink-banner-import');
    if (project) {
      project.disabled = !(inView && banner?.canSelect);
      const label = project.querySelector('.starlink-banner-project-name');
      if (label) label.textContent = banner?.projectName || '选择项目';
    }
    if (upload) upload.disabled = !(inView && banner?.canImport);
    const button = document.querySelector('#starlink-banner-warehouses');
    if (button) button.disabled = !(visible && available && directoryEnabled);
  }
  const listeners = new Set();
  const trusted = source => available && frame && source === frame.contentWindow;
  function destroy() {
    generation++; listeners.clear(); controls = null; directoryEnabled = false; banner = null;
    syncBannerButtons();
    if (positionFrame !== undefined) window.cancelAnimationFrame(positionFrame);
    positionFrame = undefined;
    observer?.disconnect(); observer = anchor = null;
    overlay?.remove(); overlay = frame = null;
  }
  function position() {
    if (!overlay || !anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    Object.assign(overlay.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function schedulePosition() {
    if (positionFrame !== undefined) return;
    // Resizing the iframe during a ResizeObserver delivery can resize its own observed content.
    positionFrame = window.requestAnimationFrame(() => {
      positionFrame = undefined;
      position();
    });
  }
  Object.defineProperty(window, 'wanxStarlinkPanel', { value: Object.freeze({
    connect(source) {
      if (!trusted(source)) throw new Error('UNTRUSTED_FRAME');
      // WindowProxy identity survives iframe reloads. Give each document its
      // own capability, listeners and service reset so old promises cannot
      // submit a retry through the new document's session.
      const current = ++generation;
      listeners.clear(); controls = null; directoryEnabled = false; banner = null;
      syncBannerButtons();
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
        setBannerActions(sender, state) {
          check(sender);
          banner = {projectName: typeof state?.projectName === 'string' ? state.projectName.slice(0, 120) : '',
            canSelect: state?.canSelect === true, canImport: state?.canImport === true};
          syncBannerButtons();
        },
        setDirectoryEnabled(sender, enabled) {
          check(sender);
          directoryEnabled = enabled === true;
          syncBannerButtons();
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
  window.addEventListener?.('click', () => {
    if (visible && available) controls?.dismissAssistant?.();
  }, true);
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
      syncBannerButtons();
    },
    action(name) {
      if (visible && available && name === 'open-graph') return controls?.openGraph?.();
      if (visible && available && name === 'project' && banner?.canSelect) return controls?.chooseProject?.();
      if (visible && available && name === 'import' && banner?.canImport) return controls?.importMaterial?.();
      if (name === 'warehouses' && visible && available && directoryEnabled) return controls?.openWarehouseDirectory?.();
    },
    render() {
      return available ? '<section id="starlink-panel-region" class="starlink-panel-region" aria-label="星图"></section>'
        : '<section class="starlink-panel-empty"><h2>星图</h2><p>连接盒子后，可以新建星图、导入资料和查看实体之间的关系。</p></section>';
    },
    mount() {
      syncBannerButtons();
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
      observer?.disconnect(); observer = new ResizeObserver(schedulePosition); observer.observe(anchor);
      position();
    },
    needsLoad: () => false, refresh: async () => {},
    isComposing: () => false, retainInput: () => null,
  };
};
