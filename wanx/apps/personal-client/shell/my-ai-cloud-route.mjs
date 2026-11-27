import { createHash, randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { rename, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { parseCloudTurn, sendCloudAnswer } from "./my-ai-cloud-protocol.mjs";

const agents = ["codex_cli", "claude_code", "gemini"];
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const managed = /^admin-managed-[a-zA-Z0-9_-]+$/;
const endpoint = "/api/wanx/memory-model";

// The box validates these managed rows against its leased cloud provider before
// returning the catalogue and again when resolving an explicit model_ref.
export function createBoxCloudTransport(client) {
  async function request(path, body, signal, check) {
    check();
    const link = await client.applicationConnection();
    try {
      check();
      const reply = await link.request({ path: endpoint + path, method: body ? "POST" : "GET",
        headers: { accept: "application/json", "content-type": "application/json" },
        ...(body && { body: JSON.stringify(body) }), signal });
      check();
      if (reply.status !== 200) throw failure("盒子云模型请求失败（" + reply.status + "）。请检查连接、模型授权和余额。");
      return JSON.parse(Buffer.from(reply.body).toString());
    } finally { link.close?.(); }
  }
  return {
    async catalog(signal, check) {
      const data = await request("", null, signal, check);
      return (data.capabilities?.memory_summary?.models ?? []).filter(row => managed.test(row.provider_name) &&
        typeof row.model === "string" && row.model.length <= 256 && row.input?.includes("text"))
        .map(row => ({ ref: row.provider_name + "/" + row.model, model: row.model, name: row.name || row.model }));
    },
    async complete(selected, turn, signal, check) {
      if (!managed.test(selected.ref.split("/")[0])) throw failure("仅可使用盒子托管的云模型。");
      const result = await request("/complete", { role: "memory_summary", model_ref: selected.ref,
        messages: turn.messages, max_tokens: turn.maxTokens, json_mode: false }, signal, check);
      if (result.model !== selected.model || typeof result.text !== "string" || !result.text.trim()) throw failure("云端模型回执无效。");
      return result;
    },
  };
}

function codexCatalog(selected) {
  return {models:[{
    slug:selected.model, display_name:selected.name, base_instructions:"Answer the user in text.",
    supported_reasoning_levels:[], shell_type:"shell_command", visibility:"list", supported_in_api:true,
    priority:0, support_verbosity:false, truncation_policy:{mode:"tokens",limit:8192}, experimental_supported_tools:[],
  }]};
}

export function createMyAiCloudRoutes({ context, transport, store, onResult, desktopGatewayDir, desktopConfig, platform = process.platform }) {
  let serial = Promise.resolve(), listener, listening, closed = false;
  const leases = new Map();
  let desktop, desktopQueue = Promise.resolve();
  let recoveryError;
  function restoreConfig() {
    try { desktopConfig?.restore(); recoveryError = undefined; }
    catch (error) { recoveryError = error.message; }
  }
  restoreConfig();
  const runId = randomBytes(12).toString("hex");
  const owner = () => {
    const value = context().owner;
    if (!value) throw failure("请先解锁当前账号。");
    return value;
  };
  const guard = (snapshot, check) => () => {
    check?.();
    if (closed || !snapshot.scope || context().scope !== snapshot.scope) throw failure("盒子或账号已切换，请重新选择。");
  };
  async function preferences() { await serial; return await store.load() ?? {}; }
  function revoke(token) {
    const lease = leases.get(token);
    lease?.abort.abort();
    leases.delete(token);
    if (desktop?.token === token) {
      try { unlinkSync(desktop.helper); } catch { /* The in-memory lease is already revoked. */ }
      desktop = undefined;
      restoreConfig();
    }
  }
  function sync() {
    const scope = context().scope;
    for (const [key, value] of leases) if (value.scope !== scope || value.expires < Date.now()) revoke(key);
  }
  async function handle(req, res) {
    const token = req.headers["x-api-key"] || req.headers["x-goog-api-key"] || req.headers.authorization?.replace(/^Bearer /, "");
    const lease = leases.get(token);
    try {
      if (!lease) throw failure("网关授权已失效。",401);
      if (req.headers.origin || lease.expires < Date.now() || context().scope !== lease.scope) throw failure("会话授权已结束。",403);
      const route = new URL(req.url,"http://localhost").pathname;
      if (req.method === "DELETE" && route === "/session") { revoke(token); res.writeHead(204); return res.end(); }
      if (lease.agent === "codex" && req.method === "GET" && route === "/v1/models") {
        const selected = lease.selected;
        res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"});
        return res.end(JSON.stringify(codexCatalog(selected)));
      }
      if (req.method !== "POST") throw failure("接口不可用。",404);
      const parts = [];
      let length = 0;
      for await (const part of req) {
        length += part.length;
        if (length > 2*1024*1024) throw failure("请求超过盒子容量限制。",413);
        parts.push(part);
      }
      const body = JSON.parse(Buffer.concat(parts).toString());
      if (lease.agent === "codex" && body.model !== lease.selected.model) throw failure("请在 Codex 中选择卡片列出的云模型。");
      const turn = parseCloudTurn(lease.agent,route,body);
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const signal = AbortSignal.any([abort.signal,lease.abort.signal,AbortSignal.timeout(120000)]);
      const check = guard(lease, () => signal.throwIfAborted());
      check();
      const answer = await transport.complete(lease.selected,turn,signal,check);
      check();
      if (desktop?.token === token) desktop.receivedAt = new Date().toISOString();
      onResult?.({ agent:lease.agent, model:answer.model, ref:lease.selected.ref });
      sendCloudAnswer(res,lease.agent,body,route,answer);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(error.status ?? 502,{"content-type":"application/json"});
        res.end(JSON.stringify({error:{type:"api_error",message:error.status ? error.message : "盒子云模型请求未完成。"}}));
      } else if (!res.destroyed) res.destroy();
    }
  }
  async function port() {
    if (!listening) {
      listener = createServer((req,res) => void handle(req,res));
      listening = new Promise((resolve,reject) => {
        listener.once("error",reject);
        listener.listen(0,"127.0.0.1",() => resolve(listener.address().port));
      }).catch(e => { listening = null; throw e; });
    }
    return listening;
  }
  function desktopStatus() {
    sync();
    const active = desktop && leases.get(desktop.token);
    return {
      selected: active?.selected ?? null, connected:Boolean(context().scope),
      ...(recoveryError && {recoveryError}),
      ...(active && {gateway:{base:desktop.base, helper:desktop.helper, helperCommand:desktop.helperCommand, helperArgs:desktop.helperArgs, receivedAt:desktop.receivedAt}}),
    };
  }
  async function selectDesktop(ref, check) {
    check();
    if (ref === null) {
      if (desktop) revoke(desktop.token);
      else restoreConfig();
      if (recoveryError) throw failure(recoveryError);
      return desktopStatus();
    }
    const snapshot = context(), live = guard(snapshot,check);
    live();
    const list = await transport.catalog(AbortSignal.timeout(12000),live);
    live();
    const selected = list.find(item => item.ref === ref);
    if (!selected) throw failure("所选云模型已不可用。");
    if (desktopStatus().selected?.ref === ref) return desktopStatus();
    const boundPort = await port();
    await mkdir(desktopGatewayDir, {recursive:true, mode:0o700});
    const ownerKey = createHash("sha256").update(JSON.stringify([snapshot.owner,snapshot.box])).digest("hex");
    const directory = path.join(desktopGatewayDir,runId,ownerKey);
    await mkdir(directory,{recursive:true,mode:0o700});
    const pending = path.join(directory,randomBytes(12).toString("hex"));
    try {
      const token = randomBytes(32).toString("hex");
      const helper = path.join(directory, platform === "win32" ? "credential.ps1" : "credential");
      // Use an explicit interpreter and argv on Windows; no global shell or Node installation is required.
      const helperCommand = platform === "win32"
        ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : helper;
      const helperArgs = platform === "win32" ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper] : [];
      const script = platform === "win32" ? "[Console]::Out.WriteLine('" + token + "')\r\n"
        : "#!/bin/sh\nprintf '%s\\n' '" + token + "'\n";
      await writeFile(pending, script, {mode:0o700,flag:"wx"});
      live();
      if (desktop) revoke(desktop.token);
      await rename(pending, helper);
      live();
      const base = "http://127.0.0.1:"+boundPort+"/v1";
      const catalog = path.join(directory, "models.json");
      await writeFile(catalog,JSON.stringify(codexCatalog(selected)),{mode:0o600});
      live();
      desktopConfig?.apply({base,helper,helperCommand,helperArgs,catalog,model:selected.model});
      recoveryError = undefined;
      leases.set(token, {agent:"codex",selected,scope:snapshot.scope,expires:Date.now()+12*3600000,abort:new AbortController()});
      desktop = {token,directory,helper,helperCommand,helperArgs,base,receivedAt:null};
      return desktopStatus();
    } catch (error) {
      await rm(pending,{force:true});
      if (!desktop) await rm(path.join(directory,platform === "win32" ? "credential.ps1" : "credential"),{force:true});
      if (desktopConfig?.pending()) recoveryError = "Codex 配置需要恢复。";
      throw error;
    }
  }
  async function action(op, agent, ref, check) {
    if (agent === "codex" && desktopGatewayDir) {
      const snapshot = context(), originalOwner = owner();
      const checkOwner = () => { check(); if (owner() !== originalOwner) throw failure("当前账号已切换。"); };
      checkOwner();
      if (op === "status") return desktopStatus();
      if (op === "catalog") {
        const live = guard(snapshot, checkOwner);
        live();
        const models = await transport.catalog(AbortSignal.timeout(12000),live);
        live();
        return {models};
      }
      if (op === "select") {
        const stable = ref === null ? checkOwner : guard(snapshot,checkOwner);
        const change = desktopQueue.then(() => selectDesktop(ref,stable));
        desktopQueue = change.catch(() => {});
        return change;
      }
    }
    if (!agents.includes(agent)) throw failure("此客户端不支持云模型切换。");
    const key = owner(), snapshot = context();
    const stable = () => { check(); if (owner() !== key) throw failure("当前账号已切换。"); };
    stable();
    if (op === "status") {
      const selected = (await preferences())[key]?.[agent] ?? null;
      stable();
      return {selected, connected:Boolean(snapshot.scope), ...(agent === "codex_cli" && desktopConfig && desktop && {
        desktopDefault:leases.get(desktop.token)?.selected.model,
      })};
    }
    let next = null;
    if (op === "catalog" || (op === "select" && ref !== null)) {
      const live = guard(snapshot,stable);
      live();
      const models = await transport.catalog(AbortSignal.timeout(12000),live);
      live();
      if (op === "catalog") return {models};
      const selected = models.find(item => item.ref === ref);
      if (!selected) throw failure("所选云模型已不可用。");
      next = {...selected, box:snapshot.box};
    }
    if (op !== "select") throw failure("未知操作。");
    const write = serial.then(async () => {
      const data = await store.load() ?? {};
      stable();
      if (next) guard(snapshot,stable)();
      data[key] = {...data[key],[agent]:next};
      await store.save(data);
    });
    serial = write.catch(() => {});
    await write;
    return {selected:next,connected:Boolean(context().scope), ...(agent === "codex_cli" && desktopConfig && desktop && {
      desktopDefault:leases.get(desktop.token)?.selected.model,
    })};
  }
  const timer = setInterval(sync,30000);
  timer.unref();
  return {action, sync, async launch(agent, check) {
    if (!agents.includes(agent)) return undefined;
    const {selected} = await action("status",agent,undefined,check);
    if (!selected) return undefined;
    const snapshot = context(), live = guard(snapshot,check);
    live();
    if (snapshot.box !== selected.box) throw failure("请连接所选模型对应的盒子，或切回原订阅。");
    const list = await transport.catalog(AbortSignal.timeout(12000),live);
    if (!list.some(item => item.ref === selected.ref)) throw failure("所选云模型暂不可用，请更换模型或切回原订阅。");
    const boundPort = await port();
    live();
    sync();
    if (leases.size >= 128) throw failure("已打开的云模型会话过多。");
    const token = randomBytes(32).toString("hex");
    leases.set(token,{agent,selected,scope:snapshot.scope,expires:Date.now()+12*3600000,abort:new AbortController()});
    return {agent,model:selected.model,port:boundPort,token};
  }, close() {
    closed = true;
    clearInterval(timer);
    for (const key of leases.keys()) revoke(key);
    if (desktopGatewayDir) void rm(path.join(desktopGatewayDir,runId),{recursive:true,force:true}).catch(() => {});
    listener?.closeAllConnections();
    listener?.close();
  }};
}
