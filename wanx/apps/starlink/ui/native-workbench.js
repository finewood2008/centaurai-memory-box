// Unsupported endpoints do not imply that the material disappeared.
export function materialAccessLost(error) {
  return error?.status === 401 || error?.status === 403 ||
    error?.status === 404 && !['SEMANTICA_OPERATION_NOT_ALLOWED','SEMANTICA_UPGRADE_REQUIRED'].includes(error?.code);
}
const targetViews = { ontology: "ontology", review: "materials", releases: "releases", sensitive: "sensitive" };
export function readWorkbenchReply(reply) {
  if (reply?.ok === true) return reply.value;
  const refused = reply?.ok === false && typeof reply.code === 'string' && /^[A-Z][A-Z_]{1,95}$/.test(reply.code);
  const code = refused ? reply.code : 'SEMANTICA_INVALID_RESPONSE';
  const status = refused && !['SEMANTICA_CONNECTION_FAILED', 'SEMANTICA_SERVICE_TIMEOUT'].includes(code) &&
    Number.isInteger(reply?.status) && reply.status >= 400 && reply.status <= 599 ? reply.status : 0;
  const message = refused && typeof reply?.message === 'string' && reply.message.length <= 200 ? reply.message : code;
  throw Object.assign(new Error(message), { code, status });
}
export function createWorkbenchHost({ call, warehouse, container, onView, onImport, onOntologySection, onSource, onSensitivePolicyChanged, onAssistantTerm, onOutsideClick }) {
  let current = null, epoch = 0, wanted = null, wantedDocument = null, wantedReview, wantedOntologyAction;
  const trusted = source => current && source === current.frame.contentWindow && current.warehouse === warehouse();
  const host = Object.freeze({
    async request(source, input) {
      if (!trusted(source)) throw Object.assign(new Error("WAREHOUSE_CHANGED"), { code: "WAREHOUSE_CHANGED" });
      const generation = epoch, selected = current.warehouse;
      const result = await call("workbench-request", { ...input, warehouseId: selected });
      if (epoch !== generation || !trusted(source)) throw Object.assign(new Error("WAREHOUSE_CHANGED"), { code: "WAREHOUSE_CHANGED" });
      const value = readWorkbenchReply(result);
      if (input.method === 'POST' && input.url?.split('?')[0] === '/api/sensitive/settings') onSensitivePolicyChanged?.();
      return value;
    },
    register(source, controls) {
      if (!trusted(source)) return;
      current.controls = controls;
      if(wantedDocument&&controls.openMaterial){const id=wantedDocument,target=wantedReview;wantedDocument=null;wantedReview=undefined;wanted=null;controls.openMaterial(id,target);return;}
      const next = wanted, action = wantedOntologyAction;
      wanted = null;
      wantedOntologyAction = undefined;
      if (next && (next !== controls.view || action)) controls.navigate(next, action);
    },
    viewChanged(source, view) {
      if (trusted(source)) onView(Object.keys(targetViews).find(key => targetViews[key] === view) || view);
    },
    ontologySectionChanged(source, section, category) {
      if (trusted(source)) onOntologySection?.(section, category);
    },
    importMaterials(source, documentId) {
      if (!trusted(source)) return;
      if (documentId === undefined || typeof documentId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(documentId)) {
        void onImport(documentId);
      }
    },
    openSource(source, documentId, versionId, segmentId) {
      const resource = /^[A-Za-z0-9_-]{1,128}$/;
      if (trusted(source) && typeof documentId === 'string' && typeof versionId === 'string' &&
          resource.test(documentId) && resource.test(versionId) &&
          (segmentId === undefined || typeof segmentId === "string" && resource.test(segmentId))) {
        if (segmentId === undefined) void onSource?.(documentId, versionId);
        else void onSource?.(documentId, versionId, segmentId);
      }
    },
  });
  Object.defineProperty(window, "starlinkWorkbench", { value: host, configurable: false, writable: false });
  return {
    has: view => Object.hasOwn(targetViews, view),
    openMaterial(documentId,reviewTarget){
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(documentId)||!warehouse())return false;
      if(reviewTarget!==undefined&&!['current-extraction','ontology-suggestions'].includes(reviewTarget))return false;
      if(current?.controls?.openMaterial)return current.controls.openMaterial(documentId,reviewTarget)!==false;
      wantedDocument=documentId;wantedReview=reviewTarget;return this.show('review');
    },
    show(view, ontologyAction) {
      if (!warehouse()) return false;
      const action = view === "ontology" ? ontologyAction : undefined;
      wanted = targetViews[view];
      wantedOntologyAction = action;
      if (!current) {
        const frame = document.createElement("iframe");
        frame.title = "当前数据仓的知识管理";
        frame.className = "integrated-workbench";
        frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-modals allow-downloads allow-forms");
        const url = new URL("workbench/index.html", document.baseURI);
        url.search = new URLSearchParams({ native: "1", embedded: "1", view: wanted });
        current = { frame, warehouse: warehouse(), controls: null };
        if (onAssistantTerm || onOutsideClick) frame.addEventListener('load', () => {
          if (!trusted(frame.contentWindow)) return;
          frame.contentDocument?.addEventListener('click', event => {
            if (!trusted(frame.contentWindow)) return;
            const marker = event.target.closest?.('[data-starxiaotu-term]');
            if (marker) onAssistantTerm?.(marker.dataset.starxiaotuTerm);
            else onOutsideClick?.();
          });
        });
        frame.src = url.href;
        container().replaceChildren(frame);
      } else if (current.controls) {
        wanted = null;
        wantedOntologyAction = undefined;
        const sameView = current.controls.view === targetViews[view];
        const navigated = current.controls.navigate(targetViews[view], action) !== false;
        if(navigated && sameView && !action)current.controls.refreshGraph?.();
        return navigated;
      }
      return true;
    },
    clearOntologyAction() {
      wantedOntologyAction = undefined;
      current?.controls?.clearOntologyAction?.();
    },
    canLeave: () => current?.controls?.canLeave() !== false,
    invalidateGraph: () => current?.controls?.refreshGraph?.(),
    reset() {
      epoch++; wanted = null; wantedDocument = null; wantedReview = undefined; wantedOntologyAction = undefined;
      current?.frame.remove(); current = null;
      onOntologySection?.("published");
    },
  };
}
