import path from "node:path";
import foundation from "../foundation-runtime/foundation.cjs";
const { Foundation } = foundation;
import { createHash } from "node:crypto";
import drive from "../foundation-runtime/vendor/host-drive.cjs";

export function connectionHost(connection, assertLive = () => {}) {
  const host = {
    context: async () => {
      assertLive();
      return connection.context();
    },
    onSessionInvalidated: (fn) =>
      connection.onInvalidated?.(fn) ||
      connection.subscribe?.((event) => {
        if (event?.type === "invalidated") fn(event);
      }) ||
      (() => {}),
    async request(route, options = {}) {
      assertLive();
      let body = options.body,
        headers = { ...options.headers };
      if (
        body &&
        typeof body === "object" &&
        !Buffer.isBuffer(body) &&
        !(body instanceof Uint8Array)
      ) {
        headers["content-type"] = "application/json";
        body = Buffer.from(JSON.stringify(body));
      }
      const response = await connection.request({
        path: route,
        method: options.method || "GET",
        headers,
        body,
        signal:
          options.signal || AbortSignal.timeout(options.timeoutMs || 120000),
      });
      assertLive();
      let raw = response.body;
      if (raw?.[Symbol.asyncIterator]) {
        const chunks = [];
        let size = 0;
        for await (const b of raw) {
          size += b.length;
          if (size > 20 * 1024 * 1024)
            throw Error("FOUNDATION_RESPONSE_TOO_LARGE");
          chunks.push(b);
        }
        raw = Buffer.concat(chunks);
      }
      return new Response([204, 205, 304].includes(response.status) || raw == null ? null : raw, {
        status: response.status,
        headers: response.headers,
      });
    },
    openStream: async (route, options = {}) => {
      assertLive();
      return connection.openStream({ path: route, ...options });
    },
  };
  host.drive = drive.createDriveClient(host);
  return host;
}
export function createNativeFoundationPool({
  host,
  root,
  dialog,
  parent,
  openWorkshop,
}) {
  const entries = new Map(),
    pending = new Map();
  let live = true;
  const unsubscribe = host.onSessionInvalidated?.(() => {
    live = false;
    for (const f of entries.values()) f.close();
    entries.clear();
  });
  return {
    async invoke(descriptor) {
      if (!live) throw Error("HOST_SESSION_EXPIRED");
      const d = descriptor?.nativeFoundation;
      if (
        !d ||
        !/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(d.appId) ||
        !["preview", "production"].includes(d.environment) ||
        !/^[a-f0-9]{64}$/.test(d.scopeId)
      )
        throw Error("FOUNDATION_CONTEXT_INVALID");
      let f = entries.get(d.scopeId);
      if (!f) {
        if (!pending.has(d.scopeId))
          pending.set(
            d.scopeId,
            (async () => {
              const context = await host.context(),
                identity = createHash("sha256")
                  .update(
                    JSON.stringify([
                      context.accountId,
                      context.boxId,
                      context.user.id,
                    ]),
                  )
                  .digest("hex");
              const created = new Foundation({
                host,
                context,
                root: path.join(root, identity, d.scopeId),
                profile: {
                  applicationId: d.appId,
                  name: "知客定制",
                  version: "0.12.1",
                  templateId: "office-automation",
                  bindingMode: "local-template-instance",
                  actions: [{ id: "capture", title: "客户资料" }],
                },
                copy: true,
                environment: d.environment,
                dialog,
                parent,
                openWorkshop: async () => {
                  if (openWorkshop) return openWorkshop(d.appId);
                  const r = await host.request(
                    "/api/_client/workshop/open-source",
                    { method: "POST" },
                  );
                  if (!r.ok) throw Error("WORKSHOP_ENTRY_UNAVAILABLE");
                  return r.json();
                },
                approve: async (kind, detail) => {
                  const options = {
                    type: "question",
                    title: "万象能力授权",
                    message: kind,
                    detail:
                      detail +
                      "\n\n" +
                      (d.environment === "preview"
                        ? "预览环境。"
                        : "正式环境。") +
                      "仅对当前定制应用和当前账号、盒子生效。",
                    buttons: ["取消", "允许本次操作"],
                    defaultId: 0,
                    cancelId: 0,
                  };
                  const result = parent
                    ? await dialog.showMessageBox(parent, options)
                    : await dialog.showMessageBox(options);
                  return result.response === 1;
                },
              });
              try {
                await created.init();
                created.foundationEnvironment = d.environment;
                if (!live) throw Error("HOST_SESSION_EXPIRED");
                entries.set(d.scopeId, created);
                return created;
              } catch (e) {
                created.close();
                throw e;
              }
            })().finally(() => pending.delete(d.scopeId)),
          );
        f = await pending.get(d.scopeId);
      }
      if (
        f.profile.applicationId !== d.appId ||
        f.foundationEnvironment !== d.environment
      )
        throw Error("FOUNDATION_CONTEXT_INVALID");
      const result = await f.invoke(d.operation, d.input);
      if (!live) throw Error("HOST_SESSION_EXPIRED");
      return result;
    },
    close() {
      unsubscribe?.();
      live = false;
      for (const f of entries.values()) f.close();
      entries.clear();
    },
  };
}
