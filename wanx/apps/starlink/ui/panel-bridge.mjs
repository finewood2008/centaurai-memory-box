export function createPanelBridge(host, source) {
  return Object.freeze({
    async call(action, input = {}) {
      const reply = await host.call(source, action, input);
      if (action.startsWith('onboarding-') || action.startsWith('conversation-') ||
          ['workbench-request', 'create-warehouse', 'reprocess-models'].includes(action)) return reply;
      if (!reply.ok) throw Object.assign(new Error(reply.code), { code: reply.code, publicMessage: reply.message });
      return reply.value;
    },
    subscribe: callback => host.subscribe(source, callback),
    register: controls => host.register?.(source, controls),
    legacyQuickCreation: completed => host.legacyQuickCreation?.(source, completed),
    setCreationEnabled: enabled => host.setCreationEnabled?.(source, enabled),
  });
}
