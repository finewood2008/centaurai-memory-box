// ../builder/integration/team-client/service.mjs
import { mkdtemp, rm, readFile as readFile2, writeFile as writeFile2, appendFile } from "node:fs/promises";
import os from "node:os";
import path2 from "node:path";
import { createHash, randomUUID } from "node:crypto";

// ../builder/core/package.mjs
import { mkdir, writeFile, copyFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ../builder/core/preview-annotations.mjs
function installPreviewAnnotations(port) {
  let mode = "off", started = false, layer, shadow, hover = null, drag = null, frame = 0, revision = 0, hidden = false, capture = null, watchdog = 0, serial = 0;
  const anchors = /* @__PURE__ */ new Map(), numbers = /* @__PURE__ */ new Map(), doc = document, win = window;
  const send = (event, value = {}) => port.postMessage({ type: "wanx:annotation-event", event, ...value });
  const text = (node) => String(node?.textContent || node?.getAttribute?.("aria-label") || node?.getAttribute?.("placeholder") || node?.tagName || "\u533A\u57DF").replace(/\s+/g, " ").trim().slice(0, 100);
  const page = () => [win.location?.hash || "", ...[...(doc.getElementById("app") || doc.body).querySelectorAll('h1,h2,[aria-current="page"],[aria-selected="true"],nav .active')].slice(0, 5).map(text)].join("|");
  const rect = (node) => {
    const b = node.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  };
  const clipped = (b) => {
    const x = Math.max(0, b.x), y = Math.max(0, b.y), right = Math.min(win.innerWidth, b.x + b.width), bottom = Math.min(win.innerHeight, b.y + b.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  };
  function target(node) {
    if (!node?.closest) return null;
    return node.closest('button,a,input,textarea,select,[role="button"],[role="tab"],[role="checkbox"]') || node.closest("h1,h2,h3,h4,p,label,li,td,th,article,section") || node;
  }
  function resolve(a) {
    if (a.node?.isConnected) return a.node;
    if (a.page !== page() || !a.node?.id) return null;
    const n = doc.getElementById(a.node.id);
    if (n && n.tagName === a.tag && text(n) === a.label) {
      a.node = n;
      return n;
    }
    return null;
  }
  function position(a) {
    const n = resolve(a);
    if (!n) return { state: a.page === page() ? "stale" : "other-page", rect: null };
    const b = rect(n), o = a.offset;
    return { state: "ready", rect: o ? { x: b.x + o.x * b.width, y: b.y + o.y * b.height, width: o.width * b.width, height: o.height * b.height } : b };
  }
  function draw(b, label = "", dashed = false) {
    const v = clipped(b);
    if (!v) return;
    const box = doc.createElement("div");
    box.style.cssText = `position:fixed;box-sizing:border-box;pointer-events:none;left:${v.x}px;top:${v.y}px;width:${v.width}px;height:${v.height}px;border:2px ${dashed ? "dashed" : "solid"} #b65c38;border-radius:3px;background:#b65c380b;`;
    if (label) {
      const badge = doc.createElement("span");
      badge.textContent = label;
      badge.style.cssText = "position:absolute;left:-2px;top:-2px;background:#b65c38;color:white;font:600 12px/22px sans-serif;min-width:22px;text-align:center;border-radius:3px;";
      box.append(badge);
    }
    shadow.append(box);
  }
  function render() {
    frame = 0;
    if (!started) return;
    shadow.replaceChildren();
    const positions = [];
    for (const [id, a] of anchors) {
      if (!numbers.has(id)) continue;
      const p = position(a);
      positions.push({ id, ...p });
      if (mode !== "off" && !hidden && p.rect) draw(p.rect, String(numbers.get(id)));
    }
    if (mode !== "off" && !hidden) {
      if (drag && mode === "box") draw(drag.box || { x: drag.x, y: drag.y, width: 0, height: 0 }, "", true);
      else if (hover?.isConnected) draw(rect(hover), "", true);
    }
    send("positions", { positions, viewport: { width: win.innerWidth, height: win.innerHeight } });
  }
  function schedule() {
    if (started && !frame) frame = win.requestAnimationFrame(render);
  }
  function moved() {
    revision++;
    if (drag) {
      drag = null;
      send("notice", { message: "\u9875\u9762\u4F4D\u7F6E\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u62D6\u6846\u3002" });
    }
    schedule();
  }
  function block(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function selected(node, box) {
    if (!node || node === doc.documentElement || node === doc.body) return;
    const existing = [...anchors].find(([, a2]) => a2.node === node && !a2.offset && !box);
    if ([...anchors.keys()].filter((id2) => numbers.has(id2)).length >= 6 && !existing) {
      send("notice", { message: "\u672C\u8F6E\u6700\u591A\u6807\u8BB0 6 \u5904\uFF0C\u53EF\u5148\u7F16\u8F91\u6216\u53D1\u9001\u3002" });
      return;
    }
    const id = existing?.[0] || "target_" + ++serial;
    if (!existing) {
      const b = rect(node);
      if (!b.width || !b.height) return;
      anchors.set(id, { node, tag: node.tagName, label: text(node), page: page(), ...box ? { offset: { x: (box.x - b.x) / b.width, y: (box.y - b.y) / b.height, width: box.width / b.width, height: box.height / b.height } } : {} });
    }
    const a = anchors.get(id), p = position(a);
    if (!p.rect || !clipped(p.rect)) return;
    send("selected", { id, label: a.label, kind: box ? "box" : "element", rect: p.rect, viewport: { width: win.innerWidth, height: win.innerHeight } });
    schedule();
  }
  function init() {
    if (started || !doc.documentElement?.append) return;
    started = true;
    layer = doc.createElement("div");
    layer.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    shadow = layer.attachShadow({ mode: "closed" });
    doc.documentElement.append(layer);
    win.addEventListener("pointerdown", (e) => {
      if (mode === "off") return;
      e.stopImmediatePropagation();
      if (e.pointerType !== "touch") e.preventDefault();
      if (hidden || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, node: target(e.target) };
    }, true);
    win.addEventListener("pointermove", (e) => {
      if (mode === "off" || hidden) return;
      hover = target(e.target);
      if (drag && mode === "box") {
        drag.box = { x: Math.min(drag.x, e.clientX), y: Math.min(drag.y, e.clientY), width: Math.abs(drag.x - e.clientX), height: Math.abs(drag.y - e.clientY) };
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      schedule();
    }, true);
    win.addEventListener("pointerup", (e) => {
      if (mode === "off") return;
      block(e);
      const start = drag;
      drag = null;
      if (!start || hidden) return;
      const distance = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (mode === "point") {
        if (distance < 8) selected(start.node);
      } else if (distance >= 8) {
        const box = clipped({ x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), width: Math.abs(start.x - e.clientX), height: Math.abs(start.y - e.clientY) });
        if (box && box.width >= 8 && box.height >= 8) selected(target(doc.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), box);
      }
      schedule();
    }, true);
    win.addEventListener("pointercancel", () => {
      drag = null;
      schedule();
    }, true);
    for (const name of ["click", "dblclick", "auxclick", "contextmenu", "submit", "beforeinput", "dragstart"]) win.addEventListener(name, (e) => {
      if (mode !== "off") block(e);
    }, true);
    win.addEventListener("keydown", (e) => {
      if (mode === "off") return;
      if (e.key === "Escape") {
        block(e);
        mode = "off";
        drag = null;
        send("mode", { mode });
        schedule();
        return;
      }
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
        e.stopImmediatePropagation();
        return;
      }
      block(e);
    }, true);
    win.addEventListener("scroll", moved, true);
    win.addEventListener("resize", moved);
    win.addEventListener("blur", () => {
      drag = null;
      schedule();
    });
    if (win.MutationObserver) new win.MutationObserver(moved).observe(doc.getElementById("app") || doc.body, { childList: true, subtree: true });
  }
  const reply = (requestId, result, error) => {
    if (requestId) port.postMessage({ type: "wanx:annotation-response", requestId, ...error ? { error } : { result } });
  };
  function restore() {
    hidden = false;
    capture = null;
    win.clearTimeout(watchdog);
    schedule();
  }
  init();
  return { receive(m) {
    if (m?.type !== "wanx:annotation-command") return false;
    const { requestId, action } = m;
    try {
      if (action === "mode") {
        mode = ["point", "box"].includes(m.mode) ? m.mode : "off";
        if (mode !== "off") {
          init();
          doc.activeElement?.blur?.();
        }
        drag = null;
        hover = null;
        schedule();
        reply(requestId, { mode });
        return true;
      }
      if (action === "sync") {
        numbers.clear();
        for (const v of (m.marks || []).slice(0, 6)) if (typeof v.id === "string" && Number.isSafeInteger(v.number)) numbers.set(v.id, v.number);
        schedule();
        reply(requestId, {});
        return true;
      }
      if (action === "remove") {
        anchors.delete(m.id);
        numbers.delete(m.id);
        schedule();
        reply(requestId, {});
        return true;
      }
      const a = anchors.get(m.id);
      if (!a) throw Error("VISUAL_REVIEW_STALE");
      if (action === "locate") {
        const node = resolve(a);
        if (!node) throw Error("VISUAL_REVIEW_STALE");
        node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        schedule();
        reply(requestId, position(a));
        return true;
      }
      if (action === "prepare") {
        hidden = true;
        shadow?.replaceChildren();
        win.clearTimeout(watchdog);
        watchdog = win.setTimeout(restore, 6e3);
        win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
          const p = position(a);
          if (!p.rect || !clipped(p.rect)) {
            restore();
            reply(requestId, null, "VISUAL_REVIEW_STALE");
            return;
          }
          capture = { id: m.id, revision, rect: p.rect };
          reply(requestId, { rect: p.rect, viewport: { width: win.innerWidth, height: win.innerHeight } });
        }));
        return true;
      }
      if (action === "validate") {
        const p = position(a), valid = capture?.id === m.id && capture.revision === revision && p.rect && ["x", "y", "width", "height"].every((k) => Math.abs(p.rect[k] - capture.rect[k]) < 1);
        restore();
        reply(requestId, { valid: Boolean(valid) });
        return true;
      }
      if (action === "restore") {
        restore();
        reply(requestId, {});
        return true;
      }
      throw Error("ANNOTATION_COMMAND_INVALID");
    } catch (e) {
      restore();
      reply(requestId, null, e.message);
    }
    return true;
  } };
}

// ../builder/core/frame.mjs
function frameDocument(bundle, css = "") {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const boot = `let port;let seq=0;const pending=new Map();const call=(method,params={})=>new Promise((resolve,reject)=>{if(!port)return reject(new Error('RUNTIME_NOT_READY'));const id=++seq;pending.set(id,{resolve,reject});port.postMessage({id,method,params});});window.addEventListener('message',function init(e){if(e.source!==parent||e.data?.type!=='wanx:init'||!e.ports[0]||port)return;port=e.ports[0];const annotations=(${installPreviewAnnotations.toString()})(port);port.onmessage=({data:m})=>{if(annotations.receive(m))return;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result)}};const api=Object.freeze({haowen:Object.freeze({invoke:(operation,input={})=>call('dialogue.invoke',{operation,input}),select:kind=>call('haowen.select',{kind}),channels:()=>call('haowen.channels',{})}),foundation:Object.freeze({invoke:(operation,input={})=>call('foundation.invoke',{operation,input})}),reports:Object.freeze(Object.fromEntries(['context','list','get','save','delete'].map(n=>[n,p=>call('reports.'+n,p)]))),data:Object.freeze(Object.fromEntries(['list','get','put','delete'].map(n=>[n,p=>call('data.'+n,p)]))),knowledge:Object.freeze(Object.fromEntries(['select','search','documents','graph','evidence'].map(n=>[n,p=>call('knowledge.'+n,p)]))),model:Object.freeze({generate:p=>call('model.generate',p),list:()=>call('model.list'),select:p=>call('model.select',p)}),files:Object.freeze({select:()=>call('files.select'),read:id=>call('files.read',{id})})});document.addEventListener('input',()=>port.postMessage({type:'wanx:dirty',dirty:true}),true);document.addEventListener('change',()=>port.postMessage({type:'wanx:dirty',dirty:true}),true);Promise.resolve(WanxMiniapp.mount(document.getElementById('app'),api)).catch(()=>{document.getElementById('app').textContent='\u5E94\u7528\u542F\u52A8\u5931\u8D25\uFF0C\u8BF7\u8FD4\u56DE\u5DE5\u4F5C\u53F0\u68C0\u67E5\u5F53\u524D\u7248\u672C\u3002'});});`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css.replace(/<\/style/gi, "<\\/style")}</style></head><body><main id="app"></main><script>${bundle.replace(/<\/script/gi, "<\\/script")}
${boot}</script></body></html>`;
}

// ../builder/core/package.mjs
var root = fileURLToPath(new URL("..", import.meta.url));
function validatePortable(payload) {
  if (payload.runtimeNamespace !== void 0 && !["studio", "workshop"].includes(payload.runtimeNamespace)) throw new Error("RUNTIME_NAMESPACE_INVALID");
  if (!/^(?:ai\.wanx\.selfmade\.[a-f0-9]{32}|dev\.wanx\.[a-z0-9-]{1,96})$/.test(payload.applicationId) || !/^[a-f0-9]{64}$/.test(payload.artifactHash) || !/^\d+\.\d+\.\d+$/.test(payload.version)) throw new Error("SELFMADE_PACKAGE_INVALID");
  const generated = JSON.stringify({ manifest: payload.manifest, bundle: payload.bundle, css: payload.css });
  if (/(?:\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_.-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.|\/Users\/|\/Volumes\/|\/home\/|192\.168\.\d+\.\d+|127\.0\.0\.1:\d+)/.test(generated)) throw new Error("PACKAGE_CONTAINS_PRIVATE_LOCATOR");
  if (Buffer.byteLength(generated) > 4 * 1024 * 1024) throw new Error("PACKAGE_TOO_LARGE");
}
async function writeMiniappPackage(payload, directory, { assets = path.join(root, "dist/runtime") } = {}) {
  validatePortable(payload);
  await mkdir(directory, { recursive: true, mode: 448 });
  const manifest = { applicationId: payload.applicationId, name: payload.name, version: payload.version, protocolVersion: 1, runtime: "electron", launchMode: "shared", entrypoint: "runtime-main.cjs", description: "\u672C\u4EBA\u81EA\u9020\u7684\u4E07\u8C61\u5C0F\u5E94\u7528", installationSource: "selfmade" };
  await writeFile(path.join(directory, "application.manifest.json"), JSON.stringify(manifest, null, 2));
  const portable = { applicationId: payload.applicationId, name: payload.name, version: payload.version, artifactHash: payload.artifactHash, manifest: payload.manifest, bundle: payload.bundle, css: payload.css };
  await writeFile(path.join(directory, "miniapp.runtime.json"), JSON.stringify(portable, null, 2));
  if (payload.deployment) {
    const d = payload.deployment, keys = ["schemaVersion", "profile", "operationId", "environment", "generation", "baseApplicationId", "slotApplicationId", "boxId"];
    if (Object.keys(d).length !== keys.length || Object.keys(d).some((k) => !keys.includes(k)) || d.schemaVersion !== 1 || !["wanx-miniapp-v1", "wanx-expert-app-v1"].includes(d.profile) || d.slotApplicationId !== payload.applicationId || !["dev", "prod"].includes(d.environment) || !Number.isSafeInteger(d.generation) || d.generation < 1 || !(typeof d.baseApplicationId === "string" && (d.profile === "wanx-miniapp-v1" ? /^ai\.wanx\.selfmade\.[a-f0-9]{32}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).test(d.baseApplicationId)) || !/^[a-f0-9]{32}$/.test(d.operationId) || typeof d.boxId !== "string" || !d.boxId || d.boxId.length > 128) throw new Error("DEPLOYMENT_PACKAGE_INVALID");
    portable.deployment = { ...d };
    await writeFile(path.join(directory, "miniapp.runtime.json"), JSON.stringify(portable, null, 2));
  }
  if (payload.runtimeNamespace !== void 0) {
    portable.runtimeNamespace = payload.runtimeNamespace;
    await writeFile(path.join(directory, "miniapp.runtime.json"), JSON.stringify(portable, null, 2));
  }
  if (payload.editable?.allowed === true) await writeFile(path.join(directory, "wanx.editable.json"), JSON.stringify(payload.editable));
  await writeFile(path.join(directory, "miniapp-frame.html"), frameDocument(payload.bundle, payload.css));
  for (const file of ["runtime-main.cjs", "runtime-preload.cjs", "runtime-renderer.js", "runtime.html"]) await copyFile(path.join(assets, file), path.join(directory, file));
  return manifest;
}

// ../builder/integration/team-client/service.mjs
var fail = (code) => Object.assign(new Error(code), { code });
var integer = (v) => Number.isSafeInteger(v) && v > 0;
var nativeMemberId = (value) => integer(Number(value)) && String(Number(value)) === String(value);
var studioApplicationId = (value) => typeof value === "string" && value.length <= 64 && /^(?:ai\.wanx\.selfmade\.[a-f0-9]{32}|dev\.wanx\.[a-z0-9-]{1,96}(?:\.(?:[a-f0-9]{8}|a[a-f0-9]{8}))?)$/.test(value);
var sameWanxAccount = (createdBy, me) => Number(createdBy) === Number(me?.id) || me?.role === "admin" && String(me?.username || "").startsWith("sso_") && Number(createdBy) === 1;
function createTeamService({ client, applications, assets }) {
  const nativeContext = (c) => {
    const state = client.snapshot();
    if (c.protocolVersion !== 1 || c.authorization != null || c.dataIdentity || !integer(c.user?.id) || state.account?.phase !== "authenticated" || !["ready", "recovering"].includes(state.phase) || !c.accountId || !c.clientId || !c.boxId || c.accountId !== state.account.accountId || c.clientId !== state.account.clientId || c.boxId !== state.connection?.deviceId) throw fail("TEAM_IDENTITY_INVALID");
  };
  const nativeMember = (member) => ({ ...member, membershipId: String(member.id), subject: member.display_name || member.username, roleId: member.role === "admin" ? "manager" : "member", status: member.disabled ? "disabled" : "active" });
  async function session() {
    const link = await client.applicationConnection("wanx");
    const c = link.context();
    nativeContext(c);
    const request = async (route, method = "GET", body) => {
      nativeContext(link.context());
      const r = await link.request({ path: route, method, headers: body ? { "content-type": "application/json" } : {}, ...body ? { body: Buffer.from(JSON.stringify(body)) } : {} });
      nativeContext(link.context());
      if ([401, 403].includes(r.status)) throw Object.assign(fail("TEAM_PERMISSION_DENIED"), { status: r.status });
      if (r.body.length > 8 * 1024 * 1024) throw fail("TEAM_RESPONSE_TOO_LARGE");
      let value;
      try {
        value = r.body.length ? JSON.parse(r.body.toString("utf8")) : null;
      } catch {
        throw fail("TEAM_RESPONSE_INVALID");
      }
      if (r.status < 200 || r.status >= 300) {
        const code = typeof value?.code === "string" && /^[A-Z_]+$/.test(value.code) ? value.code : [401, 403].includes(r.status) ? "TEAM_PERMISSION_DENIED" : r.status === 404 ? "TEAM_SERVICE_UNAVAILABLE" : "TEAM_REQUEST_FAILED";
        await appendFile("/tmp/wanx-team-service-errors.log", JSON.stringify({ route, status: r.status, code, body: value, at: (/* @__PURE__ */ new Date()).toISOString() }) + "\n").catch(() => {
        });
        throw Object.assign(fail(code), { status: r.status });
      }
      return value;
    };
    const me = await request("/api/auth/me");
    if (!integer(me.id) || me.id !== c.user?.id || me.application_id !== "wanx" || !["admin", "user"].includes(me.role)) throw fail("TEAM_IDENTITY_INVALID");
    return { request, link, me };
  }
  const manages = (me) => me.role === "admin";
  const identity = (me) => ({ id: me.id, membershipId: String(me.id), username: me.username, displayName: me.display_name || me.username, roleId: me.role === "admin" ? "manager" : "member", permissions: me.role === "admin" ? ["applications.manage", "members.read", "resources.manage"] : [] });
  const directory = async (s) => (await s.request("/api/users")).map(nativeMember);
  async function ready(s) {
    const c = await s.request("/api/app-studio/context");
    if (c.features?.teamPublishing !== 1) throw fail("TEAM_PUBLISHING_UNAVAILABLE");
  }
  async function catalog(s) {
    if (!manages(s.me)) {
      await ready(s);
      return (await s.request("/api/app-studio/projects")).projects;
    }
    await ready(s);
    const products = await s.request("/api/admin/applications"), items = [];
    for (const product of products.filter((p) => studioApplicationId(p.application_id))) {
      const deployment = await s.request("/api/admin/applications/" + product.application_id + "/deployment");
      const p = deployment.configuration?.studio_team;
      if (p) items.push({ id: p.projectId, appId: product.application_id, name: product.name, installed: { artifactHash: p.artifactHash }, enabled: deployment.enabled, audience: p.audience });
    }
    return items;
  }
  async function publication(s, input) {
    await ready(s);
    if (!studioApplicationId(input.applicationId)) throw fail("TEAM_INPUT_INVALID");
    const route = "/api/admin/applications/" + input.applicationId;
    const product = await s.request(route), deployment = await s.request(route + "/deployment");
    if (!deployment.configuration?.studio_team) throw fail("TEAM_APPLICATION_UNAVAILABLE");
    return { route, product, deployment };
  }
  function audienceMembers(input, members) {
    const selected = [...new Set((input.members || []).map(String))];
    if (!["all", "selected"].includes(input.audience) || input.audience === "selected" && (!selected.length || selected.some((id) => !nativeMemberId(id) || !members.some((m) => m.membershipId === id && m.status === "active")))) throw fail("TEAM_MEMBERS_REQUIRED");
    return selected;
  }
  async function writeAudience(s, route, input, members, selected) {
    for (const member of members.filter((m) => m.status === "active")) await s.request(route + "/access", "PUT", { user_id: member.id, enabled: input.audience === "all" || selected.includes(member.membershipId) || member.membershipId === identity(s.me).membershipId });
  }
  return { async action(operation, input = {}) {
    if (["login", "join", "security"].includes(operation)) throw fail("TEAM_OPERATION_DENIED");
    const s = await session();
    if (operation === "identity") return identity(s.me);
    if (operation === "catalog") return catalog(s);
    if (operation === "open") {
      if (!studioApplicationId(input.applicationId) || !/^[a-f0-9]{64}$/.test(input.artifactHash)) throw fail("TEAM_INPUT_INVALID");
      const payload = await s.request("/api/app-studio/apps/" + input.applicationId + "/install");
      if (payload.applicationId !== input.applicationId || payload.artifactHash !== input.artifactHash) throw fail("TEAM_ARTIFACT_MISMATCH");
      const directory2 = await mkdtemp(path2.join(os.tmpdir(), "wanx-team-app-"));
      try {
        let current;
        const installed = (await applications.listInstalled()).find((p) => p.applicationId === payload.applicationId && p.version === payload.version);
        if (payload.packageBase64) {
          const archive = path2.join(directory2, "application.zip");
          const bytes = Buffer.from(payload.packageBase64, "base64");
          await writeFile2(archive, bytes);
          const packageHash = createHash("sha256").update(bytes).digest("hex");
          if (payload.packageSha256 && payload.packageSha256 !== packageHash) throw fail("STANDARD_PACKAGE_HASH_MISMATCH");
          if (installed) {
            const descriptor = installed.descriptor;
            if (!descriptor || descriptor.sha256 !== packageHash || descriptor.applicationId !== payload.applicationId || descriptor.version !== payload.version) throw fail("TEAM_ARTIFACT_MISMATCH");
            current = installed;
          } else current = await applications.install({ archivePath: archive, standardArtifactHash: packageHash, manifest: payload.manifest });
        } else {
          await writeMiniappPackage(payload, directory2, { assets });
          current = await applications.install({ sourceDir: directory2 });
        }
        s.link.context();
        const existing = (await applications.listInstalled()).find((p) => p.applicationId === payload.applicationId);
        if (existing?.version === payload.version && existing.artifactId && existing.artifactId !== current?.artifactId && payload.packageBase64) throw fail("TEAM_ARTIFACT_MISMATCH");
        if (!current) throw fail("TEAM_INSTALL_FAILED");
        s.link.context();
        return await applications.launch(payload.applicationId);
      } finally {
        await rm(directory2, { recursive: true, force: true });
      }
    }
    if (!manages(s.me)) throw fail("TEAM_ADMIN_REQUIRED");
    if (operation === "members") return directory(s);
    if (operation === "invites") return (await s.request("/api/users/invites")).map((invite) => ({ ...invite, invitationId: String(invite.id), roleId: "member" }));
    if (operation === "invite.create") return s.request("/api/users/invites", "POST", { note: String(input.note || "\u56E2\u961F\u6210\u5458").slice(0, 200), expires_in_days: 7, role: "user" });
    if (operation === "invite.revoke") {
      if (!integer(input.id)) throw fail("TEAM_INPUT_INVALID");
      return s.request("/api/users/invites/" + input.id + "/revoke", "POST");
    }
    if (operation === "member.update") {
      if (!integer(input.id) || input.id === s.me.id || Object.keys(input).some((k) => !["id", "disabled", "role"].includes(k))) throw fail("TEAM_INPUT_INVALID");
      const body = {};
      if ("disabled" in input) {
        if (typeof input.disabled !== "boolean") throw fail("TEAM_INPUT_INVALID");
        body.disabled = input.disabled;
      }
      if ("role" in input) {
        if (!["admin", "user"].includes(input.role)) throw fail("TEAM_INPUT_INVALID");
        body.role = input.role;
      }
      if (!Object.keys(body).length) throw fail("TEAM_INPUT_INVALID");
      return s.request("/api/users/" + input.id, "PATCH", body);
    }
    if (operation === "publication") {
      const { route, product, deployment } = await publication(s, input), access = await s.request(route + "/access");
      const p = deployment.configuration.studio_team;
      return { applicationId: input.applicationId, artifactHash: p.artifactHash, audience: p.audience, enabled: deployment.enabled, canPublish: sameWanxAccount(product.created_by, s.me), members: access.filter((a) => a.enabled).map((a) => String(a.user_id)) };
    }
    if (operation === "publication-audience") {
      const { route, product, deployment } = await publication(s, input);
      if (!sameWanxAccount(product.created_by, s.me)) throw fail("TEAM_PUBLISHER_MISMATCH");
      if (input.artifactHash !== deployment.configuration.studio_team.artifactHash) throw fail("TEAM_PUBLICATION_CHANGED");
      let payload;
      try {
        payload = await s.request(`/api/app-studio/projects/${deployment.configuration.studio_team.projectId}/install/${input.artifactHash}`);
      } catch (e) {
        if (["USER_ADOPTION_REQUIRED", "USER_ACCEPTANCE_REQUIRED"].includes(e.code)) throw fail("TEAM_SCOPE_REQUIRES_CURRENT");
        throw e;
      }
      const members = await directory(s), selected = audienceMembers(input, members);
      const next = { enabled: false, resource_bindings: deployment.resource_bindings || {}, configuration: { ...deployment.configuration, studio_team: { ...deployment.configuration.studio_team, audience: input.audience } } };
      await s.request(route + "/deployment", "PUT", next);
      await writeAudience(s, route, input, members, selected);
      await s.request(`/api/app-studio/projects/${deployment.configuration.studio_team.projectId}/installed`, "POST", { operationId: randomUUID(), artifactHash: payload.artifactHash, applicationId: input.applicationId, version: payload.version });
      return s.request(route + "/deployment", "PUT", { ...next, enabled: deployment.enabled });
    }
    if (operation === "projects") {
      await ready(s);
      return (await s.request("/api/app-studio/projects")).projects;
    }
    if (operation === "publish") {
      await ready(s);
      if (!/^[a-f0-9]{32}$/.test(input.projectId) || !/^[a-f0-9]{64}$/.test(input.artifactHash) || !["all", "selected"].includes(input.audience)) throw fail("TEAM_INPUT_INVALID");
      const payload = await s.request(`/api/app-studio/projects/${input.projectId}/install/${input.artifactHash}`), id = payload.applicationId;
      const members = await directory(s), selected = audienceMembers(input, members);
      let product;
      try {
        product = await s.request("/api/admin/applications/" + id);
      } catch (e) {
        if (e.status !== 404) throw e;
        product = await s.request("/api/admin/applications", "POST", { application_id: id, name: payload.name, description: "\u56E2\u961F\u5185\u90E8\u5E94\u7528", capabilities: [], agent_template: {}, resource_requirements: {} });
      }
      if (!sameWanxAccount(product.created_by, s.me)) throw fail("TEAM_PUBLISHER_MISMATCH");
      const previous = await s.request("/api/admin/applications/" + id + "/deployment");
      const deployment = { enabled: false, resource_bindings: previous.resource_bindings || {}, configuration: { ...previous.configuration, studio_team: { projectId: input.projectId, artifactHash: input.artifactHash, audience: input.audience } } };
      await s.request("/api/admin/applications/" + id + "/deployment", "PUT", deployment);
      await writeAudience(s, "/api/admin/applications/" + id, input, members, selected);
      await s.request(`/api/app-studio/projects/${input.projectId}/installed`, "POST", { operationId: randomUUID(), artifactHash: payload.artifactHash, applicationId: id, version: payload.version });
      await s.request("/api/admin/applications/" + id + "/deployment", "PUT", { ...deployment, enabled: true });
      return { applicationId: id, version: payload.version, published: true };
    }
    if (operation === "unpublish") {
      if (!studioApplicationId(input.applicationId)) throw fail("TEAM_INPUT_INVALID");
      const route = "/api/admin/applications/" + input.applicationId + "/deployment";
      const p = await s.request(route);
      if (!p.configuration?.studio_team) throw fail("TEAM_APPLICATION_UNAVAILABLE");
      return s.request(route, "PUT", { enabled: false, resource_bindings: p.resource_bindings, configuration: p.configuration });
    }
    if (operation === "access") {
      if (!studioApplicationId(input.applicationId) || !integer(input.userId) || typeof input.enabled !== "boolean") throw fail("TEAM_INPUT_INVALID");
      return s.request("/api/admin/applications/" + input.applicationId + "/access", "PUT", { user_id: input.userId, enabled: input.enabled });
    }
    throw fail("TEAM_OPERATION_DENIED");
  }, identity: async () => identity((await session()).me) };
}
function registerTeamIPC({ ipcMain, isTrusted, team }) {
  ipcMain.handle("wanx-client:team", async (event, input) => {
    if (!isTrusted(event) || !input || Object.keys(input).some((k) => !["operation", "input"].includes(k))) throw fail("TEAM_ORIGIN_DENIED");
    try {
      return await team.action(input.operation, input.input);
    } catch (e) {
      await appendFile("/tmp/wanx-team-service-errors.log", JSON.stringify({ phase: "ipc", operation: input?.operation, code: e.code || e.message, detail: String(e), at: (/* @__PURE__ */ new Date()).toISOString() }) + "\n").catch(() => {
      });
      throw fail(/^[A-Z][A-Z0-9_]+$/.test(e.code || e.message) ? e.code || e.message : "TEAM_REQUEST_FAILED");
    }
  });
}
function guardTeamIPC({ ipcMain, client, team, isTrusted }) {
  return new Proxy(ipcMain, { get(target, key) {
    if (key !== "handle") return typeof target[key] === "function" ? target[key].bind(target) : target[key];
    return (name, handler) => target.handle(name, async (event, ...args) => {
      if (/^wanx-client:(studio-|builder-|maintenance-open)/.test(name)) {
        if (!isTrusted(event)) throw fail("TEAM_ORIGIN_DENIED");
        if (!(await team.identity()).permissions.includes("applications.manage")) throw fail("TEAM_ADMIN_REQUIRED");
      }
      if (client.isTeamDirect() && /^wanx-client:(wallet-|panel-balance|profile-|change-password|send-change-code|support-)/.test(name)) throw fail("TEAM_PLATFORM_ACCOUNT_REQUIRED");
      return handler(event, ...args);
    });
  } });
}
export {
  createTeamService,
  guardTeamIPC,
  registerTeamIPC
};
