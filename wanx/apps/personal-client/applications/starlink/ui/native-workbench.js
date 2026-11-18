// Unsupported endpoints do not imply that the material disappeared.
export function materialAccessLost(error) {
  return error?.status === 401 || error?.status === 403 ||
    error?.status === 404 && !['SEMANTICA_OPERATION_NOT_ALLOWED','SEMANTICA_UPGRADE_REQUIRED'].includes(error?.code);
}
const targetViews = { ontology: "ontology", review: "materials", releases: "releases" };
export function readWorkbenchReply(reply) {
  if (reply?.ok === true) return reply.value;
  const refused = reply?.ok === false && typeof reply.code === 'string' && /^[A-Z][A-Z_]{1,95}$/.test(reply.code);
  const code = refused ? reply.code : 'SEMANTICA_INVALID_RESPONSE';
  const status = refused && !['SEMANTICA_CONNECTION_FAILED', 'SEMANTICA_SERVICE_TIMEOUT'].includes(code) &&
    Number.isInteger(reply?.status) && reply.status >= 400 && reply.status <= 599 ? reply.status : 0;
  const message = refused && typeof reply?.message === 'string' && reply.message.length <= 200 ? reply.message : code;
  throw Object.assign(new Error(message), { code, status });
}
export function createWorkbenchHost({ call, warehouse, container, onView, onImport }) {
  let current = null, epoch = 0, wanted = null, wantedDocument = null, wantedReview;
  const trusted = source => current && source === current.frame.contentWindow && current.warehouse === warehouse();
  const host = Object.freeze({
    async request(source, input) {
      if (!trusted(source)) throw Object.assign(new Error("WAREHOUSE_CHANGED"), { code: "WAREHOUSE_CHANGED" });
      const generation = epoch, selected = current.warehouse;
      const result = await call("workbench-request", { ...input, warehouseId: selected });
      if (epoch !== generation || !trusted(source)) throw Object.assign(new Error("WAREHOUSE_CHANGED"), { code: "WAREHOUSE_CHANGED" });
      return readWorkbenchReply(result);
    },
    register(source, controls) {
      if (!trusted(source)) return;
      current.controls = controls;
      if(wantedDocument&&controls.openMaterial){const id=wantedDocument,target=wantedReview;wantedDocument=null;wantedReview=undefined;wanted=null;controls.openMaterial(id,target);return;}
      if (wanted && wanted !== controls.view) { const next = wanted; wanted = null; controls.navigate(next); }
      else wanted = null;
    },
    viewChanged(source, view) {
      if (trusted(source)) onView(Object.keys(targetViews).find(key => targetViews[key] === view) || view);
    },
    importMaterials(source) { if (trusted(source)) onImport(); },
  });
  Object.defineProperty(window, "starlinkWorkbench", { value: host, configurable: false, writable: false });
  return {
    has: view => Object.hasOwn(targetViews, view),
    openMaterial(documentId,reviewTarget){
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(documentId)||!warehouse())return false;
      if(reviewTarget!==undefined&&reviewTarget!=='current-extraction')return false;
      if(current?.controls?.openMaterial)return current.controls.openMaterial(documentId,reviewTarget)!==false;
      wantedDocument=documentId;wantedReview=reviewTarget;return this.show('review');
    },
    show(view) {
      if (!warehouse()) return false;
      wanted = targetViews[view];
      if (!current) {
        const frame = document.createElement("iframe");
        frame.title = "当前数据仓的知识管理";
        frame.className = "integrated-workbench";
        frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-modals allow-downloads");
        const url = new URL("workbench/index.html", document.baseURI);
        url.search = new URLSearchParams({ native: "1", embedded: "1", view: wanted });
        current = { frame, warehouse: warehouse(), controls: null };
        frame.src = url.href;
        container().replaceChildren(frame);
      } else if (current.controls) {
        wanted = null;
        const sameView = current.controls.view === targetViews[view];
        const navigated = current.controls.navigate(targetViews[view]) !== false;
        if(navigated && sameView)current.controls.refreshGraph?.();
        return navigated;
      }
      return true;
    },
    canLeave: () => current?.controls?.canLeave() !== false,
    invalidateGraph: () => current?.controls?.refreshGraph?.(),
    reset() { epoch++; wanted = null; wantedDocument=null;wantedReview=undefined; current?.frame.remove(); current = null; },
  };
}
