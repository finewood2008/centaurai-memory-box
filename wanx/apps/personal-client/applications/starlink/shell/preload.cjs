const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "semantica",
  Object.freeze({
    call: async (action, input = {}) => {
      const result = await ipcRenderer.invoke("semantica:action", {
        action,
        input,
      });
      // contextBridge drops custom Error fields. The renderer reconstructs
      // workbench errors only after this plain envelope crosses the boundary.
      if (action.startsWith('onboarding-') || action.startsWith('conversation-') || ['workbench-request','create-warehouse','reprocess-models'].includes(action)) return result;
      if (!result.ok)
        throw Object.assign(new Error(result.code), { code: result.code, publicMessage: result.message });
      return result.value;
    },
    subscribe: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("semantica:event", listener);
      return () => ipcRenderer.removeListener("semantica:event", listener);
    },
  }),
);
