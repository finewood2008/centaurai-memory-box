import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { dataInteractionKey, dataOwnerKey } from "../device-trust/data-context.mjs";

const LIMIT = 2 * 1024 * 1024;
const REMOTE = "/api/wanx/memory-model";
const CATALOG = "/api/providers/resolved";
const TEXT_ROLES = ["memory_summary", "memory_evolution"];
export const OPTIONAL_MODEL_ROLES = ["agent", "asr", "image_generation"];
const INVENTORY_ROLES = ["embedding", ...OPTIONAL_MODEL_ROLES];
export const SELECTABLE_MODEL_ROLES = [...TEXT_ROLES, ...OPTIONAL_MODEL_ROLES];
const ACTIVE_MODEL = "/api/providers/active-model";
const text = value => typeof value === "string" && value.length > 0 && value.length <= 512;

function catalogModels(rows, requireText = true) {
  if (!Array.isArray(rows)) return [];
  const models = rows.filter(row => row && text(row.provider_name) && text(row.model) &&
    (!requireText || !Array.isArray(row.input) || row.input.includes("text"))).map(row => ({
    ref: `${row.provider_name}/${row.model}`,
    model: row.model,
    name: text(row.name) ? row.name : row.model,
    provider: row.provider_name,
  })).filter(row => text(row.ref));
  return [...new Map(models.map(model => [model.ref, model])).values()];
}

export function createMemoryModelBridge({ client, serviceURL, runtimeFile, preferenceFile, protectFile }) {
  const descriptor = path.join(path.dirname(runtimeFile), "wanx-memory-model.json");
  const assignmentsFile = preferenceFile + ".assignments.json";
  const instance = randomBytes(16).toString("hex");
  const requests = new Set();
  const interaction = () => dataInteractionKey(client.snapshot(), serviceURL);
  const selectionScope = () => {
    const state = client.snapshot();
    const account = dataOwnerKey(state, serviceURL);
    return account && state.connection?.deviceId
      ? createHash("sha256").update(JSON.stringify([account, state.connection.deviceId])).digest("hex") : null;
  };
  let owner = null;
  let bound = null;
  let token = randomBytes(32).toString("hex");
  let mode = "wanx";
  let server;
  let statusTimer;
  let modelStatus;
  let modelError = null;
  // Preferences use the catalog already displayed for this connection; live
  // execution still checks the current model status and box authorization.
  let candidateCatalog = [];
  let roleCatalogs = {};
  let activeModelRef;
  let requestedModels = {};
  let checkingStatus;
  let published = false;
  let closed = false;
  let pending = Promise.resolve();

  function serialize(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  async function writePrivate(file, content) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${instance}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      if (file === descriptor) await protectFile?.(temporary);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function clearDescriptor() {
    const current = await readFile(descriptor, "utf8").then(JSON.parse).catch(() => null);
    if (current?.instance === instance) await rm(descriptor, { force: true });
  }

  function sync(scope) {
    const next = mode === "wanx" && owner && owner === scope ? interaction() : null;
    if (next !== bound) {
      bound = next;
      token = randomBytes(32).toString("hex");
      modelStatus = undefined;
      modelError = null;
      candidateCatalog = [];
      roleCatalogs = {};
      activeModelRef = undefined;
      requestedModels = {};
      published = false;
      for (const request of requests) request.abort();
      if (server && owner && mode === "wanx" && !closed) {
        void serialize(publish).catch(() => {});
        if (bound) void refreshStatus().catch(() => {});
      }
    }
  }

  function refreshStatus() {
    const selected = token;
    if (checkingStatus?.token === selected) return checkingStatus.promise;
    const check = { token: selected, promise: (async () => {
      const result = await remote(REMOTE, "GET", undefined, AbortSignal.timeout(8_000));
      await serialize(async () => {
        if (selected !== token) return;
        const key = selectionScope();
        const saved = key ? await readAssignments() : {};
        if (selected !== token) return;
        requestedModels = Object.fromEntries(SELECTABLE_MODEL_ROLES.map(role => [role,
          text(saved[key]?.[role]) ? saved[key][role] : null]));
        const previous = modelStatus;
        modelStatus = result.status === 200 && result.body && typeof result.body === "object" ? result.body : undefined;
        modelError = modelStatus ? null : result.body?.detail ?? null;
        if (modelStatus) roleCatalogs = modelStatus.capabilities ?? {};
        else if (result.status === 401 || result.status === 403 ||
                 result.body?.detail === "MEMORY_MODEL_BOX_UPDATE_REQUIRED" ||
                 result.body?.detail === "MEMORY_MODEL_NOT_CONFIGURED") roleCatalogs = {};
        if (!published || JSON.stringify(previous) !== JSON.stringify(modelStatus))
          await publish().catch(() => { published = false; });
      });
      return result;
    })() };
    checkingStatus = check;
    void check.promise.finally(() => {
      if (checkingStatus === check) checkingStatus = undefined;
    }).catch(() => {});
    return check.promise;
  }

  async function readAssignments() {
    const value = await readFile(assignmentsFile, "utf8").then(JSON.parse).catch(() => ({}));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function choicesFor(role) {
    const isTextRole = TEXT_ROLES.includes(role);
    const catalog = roleCatalogs[role];
    return catalog ? catalogModels(catalog.models, isTextRole)
      : isTextRole || role === "agent" ? candidateCatalog : [];
  }

  async function refreshCatalog() {
    const selected = token;
    const deadline = AbortSignal.timeout(8_000);
    const [result, active] = await Promise.all([
      remote(CATALOG, "GET", undefined, deadline),
      remote(ACTIVE_MODEL, "GET", undefined, deadline),
    ]);
    if (selected !== token) return;
    if (result.status === 200 && Array.isArray(result.body)) candidateCatalog = catalogModels(result.body);
    else if (result.status === 401 || result.status === 403) candidateCatalog = [];
    if (active.status === 200) activeModelRef = `${active.body?.provider_name}/${active.body?.model}`;
  }

  function roleModel(role) {
    const requested = requestedModels[role];
    const catalog = modelStatus?.capabilities?.[role];
    if (!catalog) {
      return !modelStatus?.capabilities && !requested && text(modelStatus?.model)
        ? { model: modelStatus.model, name: modelStatus.name, provider: modelStatus.provider } : null;
    }
    const allowed = catalogModels(catalog.models);
    return allowed.find(row => row.ref === (requested || catalog.defaultRef)) || null;
  }

  async function remote(route, method, body, signal = AbortSignal.timeout(120_000)) {
    const selected = bound, authorized = token;
    if (!selected || interaction() !== selected) return { status: 503, body: { detail: "MEMORY_MODEL_BOX_DISCONNECTED" } };
    const request = new AbortController();
    requests.add(request);
    const requestSignal = AbortSignal.any([request.signal, signal]);
    let connection;
    try {
      connection = await client.applicationConnection();
      if (requestSignal.aborted || bound !== selected || token !== authorized || interaction() !== selected) throw new Error("context_changed");
      const reply = await connection.request({
        path: route,
        method,
        headers: { accept: "application/json", "content-type": "application/json" },
        body,
        signal: requestSignal,
      });
      if (requestSignal.aborted || bound !== selected || token !== authorized || interaction() !== selected) throw new Error("context_changed");
      if ([404, 405].includes(reply.status))
        return { status: 503, body: { detail: "MEMORY_MODEL_BOX_UPDATE_REQUIRED" } };
      const result = JSON.parse(Buffer.from(reply.body || "").toString());
      if (reply.status >= 200 && reply.status < 300) return { status: reply.status, body: result };
      const detail = typeof result.detail === "string" && /^MEMORY_MODEL_[A-Z_]+$/.test(result.detail)
        ? result.detail : "MEMORY_MODEL_UNAVAILABLE";
      return { status: reply.status, body: { detail } };
    } catch {
      return { status: 503, body: { detail: "MEMORY_MODEL_UNAVAILABLE" } };
    } finally {
      connection?.close?.();
      requests.delete(request);
    }
  }

  function respond(response, status, body) {
    if (response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  }

  async function complete(request, response) {
    const auth = request.headers.authorization || "";
    if (request.method !== "POST" || request.url !== "/complete" || request.headers.origin ||
      !/^Bearer [a-f0-9]{64}$/.test(auth) ||
      !timingSafeEqual(Buffer.from(auth.slice(7), "hex"), Buffer.from(token, "hex"))) {
      respond(response, 403, { detail: "MEMORY_MODEL_FORBIDDEN" });
      return;
    }
    const selected = bound, authorized = token;
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > LIMIT) return respond(response, 413, { detail: "MEMORY_MODEL_INPUT_TOO_LARGE" });
        chunks.push(chunk);
      }
      const { messages, maxTokens, jsonMode, role, expectedRef } = JSON.parse(Buffer.concat(chunks).toString());
      if (!selected || bound !== selected || token !== authorized) return respond(response, 503, { detail: "MEMORY_MODEL_BOX_DISCONNECTED" });
      if (role !== undefined && !TEXT_ROLES.includes(role))
        return respond(response, 400, { detail: "MEMORY_MODEL_INVALID_INPUT" });
      const model = role ? roleModel(role) : null;
      if (role && (!model || (expectedRef !== undefined && model.ref !== expectedRef)))
        return respond(response, 409, { detail: "MEMORY_MODEL_NOT_CONFIGURED" });
      const result = await remote(REMOTE + "/complete", "POST", JSON.stringify({
        messages, max_tokens: maxTokens, json_mode: jsonMode,
        ...(model?.ref && { role, model_ref: model.ref }),
      }), AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]));
      respond(response, result.status, result.body);
    } catch {
      respond(response, 400, { detail: "MEMORY_MODEL_INVALID_INPUT" });
    }
  }

  async function publish() {
    if (closed || mode === "custom") {
      await clearDescriptor();
      return;
    }
    if (!server) {
      const listener = createServer((request, response) => void complete(request, response));
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      server = listener;
      statusTimer = setInterval(() => {
        if (bound) void refreshStatus().catch(() => {});
      }, 30_000);
      statusTimer.unref();
    }
    await writePrivate(descriptor, JSON.stringify({
      version: 1, instance, pid: process.pid, port: server.address().port, token,
      model: modelStatus?.model ?? null,
      roles: Object.fromEntries(TEXT_ROLES.map(role => [role, roleModel(role)?.model ?? null])),
      refs: Object.fromEntries(TEXT_ROLES.map(role => [role, roleModel(role)?.ref ?? null])),
    }));
    published = true;
  }

  return {
    activate(scope, getScope) {
      const activation = serialize(async () => {
        if (closed || scope !== getScope()) return;
        if (owner !== scope) {
          mode = (await readFile(preferenceFile, "utf8").catch(() => "")) === "custom" ? "custom" : "wanx";
          if (scope !== getScope()) return;
          owner = scope;
          sync(scope);
        }
        if (mode === "wanx" && !published) await publish();
      });
      void activation.then(() => {
        if (bound && !modelStatus) return refreshStatus();
      }).catch(() => {});
      return activation;
    },
    sync,
    async settings(scope, changes, getScope) {
      const { mode: requestedMode, role, modelRef } = changes || {};
      const selectedBox = selectionScope();
      const selectionToken = token;
      if (role && modelRef && !choicesFor(role).some(model => model.ref === modelRef)) {
        await Promise.all([refreshCatalog(), refreshStatus()]);
      }
      await serialize(async () => {
        if (closed || owner !== scope || scope !== getScope()) throw new Error("context_changed");
        if (role) {
          const authorizedChoice = modelRef === null || choicesFor(role).some(model => model.ref === modelRef);
          if (!authorizedChoice || !bound || !selectedBox || selectedBox !== selectionScope() || selectionToken !== token)
            throw new Error("model_unavailable");
          const saved = await readAssignments();
          if (selectedBox !== selectionScope() || selectionToken !== token) throw new Error("context_changed");
          const next = { ...saved[selectedBox], [role]: modelRef };
          await writePrivate(assignmentsFile, JSON.stringify({ ...saved, [selectedBox]: next }));
          if (selectionToken === token && selectedBox === selectionScope()) {
            requestedModels = next;
            published = false;
            await publish().catch(() => { published = false; });
          }
        }
        if (requestedMode && requestedMode !== mode) {
          await writePrivate(preferenceFile, requestedMode);
          mode = requestedMode;
          published = false;
          sync(getScope());
        }
        if (!role && (!published || mode === "custom")) await publish();
      });
      if (mode === "wanx" && !role) await Promise.all([refreshStatus(), refreshCatalog()]);
      return {
        mode,
        ...(modelStatus
          ? { model: modelStatus.model, name: modelStatus.name, provider: modelStatus.provider }
          : { error: modelError }),
        ...(mode === "wanx" && {
          roles: Object.fromEntries(TEXT_ROLES.map(role => {
            const catalog = modelStatus?.capabilities?.[role];
            const effective = roleModel(role);
            return [role, {
              selectedRef: requestedModels[role] ?? null,
              models: choicesFor(role),
              ready: Boolean(effective),
              effective: effective ?? null,
              supportsSelection: Boolean(catalog),
            }];
          })),
          inventory: Object.fromEntries(INVENTORY_ROLES.map(role => {
            const catalog = modelStatus?.capabilities?.[role];
            const available = catalog ? catalogModels(catalog.models, false) : choicesFor(role);
            const defaultRef = catalog?.defaultRef ?? (!catalog && role === "agent" ? activeModelRef : null);
            const defaultModel = available.find(model => model.ref === defaultRef);
            return [role, {
              models: available, defaultModel: defaultModel ?? null, reported: Boolean(catalog),
              selectedRef: requestedModels[role] ?? null,
            }];
          })),
        }),
      };
    },
    close() {
      closed = true;
      clearInterval(statusTimer);
      owner = null;
      sync(null);
      return serialize(async () => {
        try {
          await clearDescriptor();
        } finally {
          if (server) {
            const stopped = new Promise(resolve => server.close(resolve));
            server.closeAllConnections();
            await stopped;
          }
        }
      });
    },
  };
}
