// This guard belongs to one trusted Builder WebContents. Preview CSP owns
// resource loading; no shared session/webRequest listener is changed here.
function installPreviewNavigationGuard(contents) {
  const deny = event => event.preventDefault();
  const navigate = event => {
    // Only the trusted UI may create its direct opaque srcdoc preview. A
    // preview cannot replace itself, its parent, or a nested frame document.
    try {
      const main = contents.mainFrame;
      if (main && event.url === 'about:srcdoc' && event.isMainFrame === false
          && event.initiator === main && event.frame?.parent === main) return;
    } catch { /* A destroyed or detached frame grants no navigation. */ }
    event.preventDefault();
  };
  const listeners = [['will-frame-navigate', navigate], ['will-navigate', deny],
    ['will-redirect', deny], ['will-attach-webview', deny]];
  for (const [name, listener] of listeners) contents.on(name, listener);
  contents.setWindowOpenHandler(() => ({action: 'deny'}));
  contents.once('destroyed', () => {
    for (const [name, listener] of listeners) contents.removeListener(name, listener);
  });
}

module.exports = {installPreviewNavigationGuard};
