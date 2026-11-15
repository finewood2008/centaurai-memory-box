const views = new Set(["warehouses", "conversation", "materials", "graph", "search", "tasks", "sensitive", "models", "skills", "api", "data"]);
const fail = code => Object.assign(new Error(code), { code });
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);

// WANX waits for a renderer acknowledgement before considering a warehouse open.
export function createStarlinkTarget({ host, service, emit, send, launchId }) {
  let pending = null, revision = 0;
  const reply = (requestId, ok, code) => send({ type: "wanx:starlink-target-result", launchId, requestId, ok, code });
  return {
    async receive(message) {
      if (!launchId || message?.launchId !== launchId || message.type !== "wanx:starlink-target" ||
          typeof message.requestId !== "string" || message.requestId.length > 128) return;
      const current = ++revision;
      send({ type: "wanx:starlink-capabilities", launchId, version: 1, versions: [1,2] });
      try {
        service.assertLive();
        let target = message.target;
        if (!target || !["team-data", "personal-data"].includes(target.kind) || ![1,2].includes(target.version) ||
            !views.has(target.view) || (target.warehouseId !== null && !/^[a-f0-9-]{36}$/.test(target.warehouseId)))
          throw fail("TEAM_DATA_TARGET_INVALID");
        const fields=target.version===2?["kind","version","warehouseId","view","documentId","conversationId","intentId"]:["kind","version","warehouseId","view"];
        if(Object.keys(target).some(key=>!fields.includes(key)))throw fail("TEAM_DATA_TARGET_INVALID");
        if(target.version===2&&(!target.warehouseId||target.kind!=='personal-data'||!['conversation','materials'].includes(target.view)||
          !validId(target.documentId)||
          (target.conversationId!==undefined||target.intentId!==undefined)&&(!validId(target.conversationId)||!validId(target.intentId))))throw fail("TEAM_DATA_TARGET_INVALID");
        // Older Host links still name the retired standalone materials page.
        if (target.view === "materials") target = { ...target, view: "conversation" };
        const context = await host.context();
        const scope = context.dataScope || "personal";
        if (scope !== (target.kind === "team-data" ? "team" : "personal")) throw fail("TEAM_DATA_CONTEXT_REQUIRED");
        if (target.warehouseId) {
          try { await service.call("warehouse", { id: target.warehouseId }); }
          catch (error) {
            if (error.code !== "WAREHOUSE_NOT_FOUND") throw error;
            // A stale link must not abort application startup. The directory is
            // still bound to the validated Host scope; never select a foreign ID.
            target = { kind:target.kind,version:1,warehouseId: null, view: "warehouses" };
          }
        }
        service.assertLive();
        if (current !== revision) throw fail("TEAM_STARLINK_OPEN_SUPERSEDED");
        if (pending) reply(pending.requestId, false, "TEAM_STARLINK_OPEN_SUPERSEDED");
        pending = { requestId: message.requestId, target: { ...target } };
        emit({ type: "launch-target", ...pending });
      } catch (error) {
        reply(message.requestId, false, error.code || "TEAM_STARLINK_OPEN_FAILED");
      }
    },
    async call(action, input = {}) {
      service.assertLive();
      if (action === "launch-target") return pending;
      if (action !== "launch-target-applied" || !pending || input.requestId !== pending.requestId)
        throw fail("TEAM_DATA_TARGET_INVALID");
      await host.context();
      service.assertLive();
      // A newer request may have arrived while the host session was checked.
      if (!pending || input.requestId !== pending.requestId) throw fail("TEAM_STARLINK_OPEN_SUPERSEDED");
      reply(pending.requestId, input.ok === true, input.ok === true ? undefined : "TEAM_STARLINK_OPEN_FAILED");
      pending = null;
      return { acknowledged: true };
    },
  };
}
