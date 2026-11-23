import { setImmediate as nextTurn } from "node:timers/promises";

export function createQuitRequest({ app, control, dialog, onError, platform = process.platform }) {
  let pending;
  return () => {
    if (pending) return pending;
    // Let the native tray menu finish handling its click before opening a sheet.
    pending = nextTurn().then(() => {
      const options = {
        type: "question", title: "退出记忆盒子", message: "退出记忆盒子？",
        detail: "这会关闭记忆盒子所承载的应用，并断开盒子连接。收起窗口可以继续在后台运行。",
        buttons: ["继续运行", "退出记忆盒子"], defaultId: 0, cancelId: 0,
      };
      const parent = control.isDestroyed() ? null : control;
      if (parent?.isMinimized()) parent.restore();
      parent?.show();
      if (platform === "darwin") app.focus({ steal: true });
      parent?.focus();
      return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
    }).then(({ response }) => {
      if (response === 1) app.quit();
    }).catch(onError).finally(() => { pending = null; });
    return pending;
  };
}

// Electron emits before-quit again for repeated user actions and for our final quit.
// Only the latter may bypass cleanup; a failed stop must leave Host available to retry.
export function registerShutdown({ app, closeApplications, closeHost, onError }) {
  let ready = false, pending;
  function finish(finalize = () => app.quit()) {
    if (pending) return pending;
    pending = Promise.resolve()
      .then(closeApplications)
      .then(closeHost)
      .then(() => { ready = true; return finalize(); })
      .catch(error => { ready = false; throw error; })
      .finally(() => { pending = null; });
    return pending;
  }
  app.on("before-quit", event => {
    if (ready) return;
    event.preventDefault();
    if (pending) return;
    void finish().catch(onError);
  });
  return {
    requestInstall(finalize) {
      if (pending) return Promise.reject(Object.assign(new Error("UPDATE_IN_PROGRESS"), { code: "UPDATE_IN_PROGRESS" }));
      return finish(finalize);
    },
  };
}
