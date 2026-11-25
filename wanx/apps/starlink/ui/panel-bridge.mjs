export function createPanelBridge(host, source) {
  return Object.freeze({
    async call(action, input = {}) {
      const reply = await host.call(source, action, input);
      if (action.startsWith('onboarding-') || action.startsWith('conversation-') ||
          ['workbench-request', 'create-warehouse', 'reprocess-models'].includes(action)) return reply;
      if (!reply.ok) throw Object.assign(new Error(reply.code), { code: reply.code, publicMessage: reply.message,
        ...(action==='assistant-intent'?{status:reply.status}:{}) });
      return reply.value;
    },
    subscribe: callback => host.subscribe(source, callback),
    rememberGuideProject: id => host.rememberGuideProject?.(source,id),
    ...(host.dismissGuide && {dismissGuide: () => host.dismissGuide(source)}),
    ...(host.openGuide && {openGuide: key => host.openGuide(source,key)}),
    register: controls => host.register?.(source, controls),
    legacyQuickCreation: completed => host.legacyQuickCreation?.(source, completed),
    ...(host.setGuideView && {setGuideView: view => host.setGuideView(source,view)}),
    ...(host.setBannerActions && {setBannerActions: state => host.setBannerActions(source, state)}),
    setDirectoryEnabled: enabled => host.setDirectoryEnabled?.(source, enabled),
  });
}
