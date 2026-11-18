// Only the outer Starlink document receives this facade. Workbench children use
// native-workbench.js and never receive the client's general-purpose bridge.
import { createPanelBridge } from './panel-bridge.mjs';
const host = window.parent !== window && window.parent.wanxStarlinkPanel;
if (host) {
  window.semantica = createPanelBridge(host.connect(window), window);
}
