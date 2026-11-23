import {createRequire as workshopRequire} from "node:module";const require=workshopRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../builder/integration/preview-navigation.cjs
var require_preview_navigation = __commonJS({
  "../builder/integration/preview-navigation.cjs"(exports, module) {
    "use strict";
    function installPreviewNavigationGuard2(contents) {
      const deny = (event) => event.preventDefault();
      const navigate = (event) => {
        try {
          const main = contents.mainFrame;
          if (main && event.url === "about:srcdoc" && event.isMainFrame === false && event.initiator === main && event.frame?.parent === main) return;
        } catch {
        }
        event.preventDefault();
      };
      const listeners = [
        ["will-frame-navigate", navigate],
        ["will-navigate", deny],
        ["will-redirect", deny],
        ["will-attach-webview", deny]
      ];
      for (const [name, listener] of listeners) contents.on(name, listener);
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.once("destroyed", () => {
        for (const [name, listener] of listeners) contents.removeListener(name, listener);
      });
    }
    module.exports = { installPreviewNavigationGuard: installPreviewNavigationGuard2 };
  }
});

// ../builder/integration/host-control.mjs
import { mkdtemp as mkdtemp3, rm as rm4, readFile as readFile5, writeFile as writeFile5 } from "node:fs/promises";
import os2 from "node:os";
import path5 from "node:path";
import { createHash as createHash3, randomUUID as randomUUID4 } from "node:crypto";

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
    for (const [id2, a] of anchors) {
      if (!numbers.has(id2)) continue;
      const p = position(a);
      positions.push({ id: id2, ...p });
      if (mode !== "off" && !hidden && p.rect) draw(p.rect, String(numbers.get(id2)));
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
    if ([...anchors.keys()].filter((id3) => numbers.has(id3)).length >= 6 && !existing) {
      send("notice", { message: "\u672C\u8F6E\u6700\u591A\u6807\u8BB0 6 \u5904\uFF0C\u53EF\u5148\u7F16\u8F91\u6216\u53D1\u9001\u3002" });
      return;
    }
    const id2 = existing?.[0] || "target_" + ++serial;
    if (!existing) {
      const b = rect(node);
      if (!b.width || !b.height) return;
      anchors.set(id2, { node, tag: node.tagName, label: text(node), page: page(), ...box ? { offset: { x: (box.x - b.x) / b.width, y: (box.y - b.y) / b.height, width: box.width / b.width, height: box.height / b.height } } : {} });
    }
    const a = anchors.get(id2), p = position(a);
    if (!p.rect || !clipped(p.rect)) return;
    send("selected", { id: id2, label: a.label, kind: box ? "box" : "element", rect: p.rect, viewport: { width: win.innerWidth, height: win.innerHeight } });
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

// applications/standard-deployment-limits.mjs
var STANDARD_MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
var STANDARD_MAX_EXTRACTED_BYTES = 128 * 1024 * 1024;

// ../builder/integration/host-entry.mjs
import { randomUUID as randomUUID3 } from "node:crypto";

// ../builder/integration/project-preview.mjs
import { randomUUID } from "node:crypto";

// ../builder/core/standard-frame.mjs
var STANDARD_LAYOUT_FORMAT = "wanx-standard-layout-v1";
var STANDARD_LAYOUT_MAX_BYTES = 12 * 1024 * 1024;
var fail = (code) => Object.assign(new Error(code), { code });
function previewDocument(response, artifactHash) {
  if (response?.standardLayout !== void 0) {
    const layout = response.standardLayout;
    if (!layout || Object.keys(layout).sort().join() !== ["format", "artifactHash", "packageSha256", "document"].sort().join() || layout.format !== STANDARD_LAYOUT_FORMAT || !/^[a-f0-9]{64}$/.test(layout.artifactHash) || layout.artifactHash !== artifactHash || !/^[a-f0-9]{64}$/.test(layout.packageSha256) || layout.packageSha256 !== response.packageSha256 || typeof layout.document !== "string" || !layout.document || new TextEncoder().encode(layout.document).length > STANDARD_LAYOUT_MAX_BYTES) throw fail("STANDARD_PREVIEW_INVALID");
    return { document: layout.document, layoutOnly: true };
  }
  if (response?.packageBase64 || response?.manifest?.protocolVersion === 3) throw fail("STANDARD_PREVIEW_REQUIRED");
  return { document: frameDocument(response.bundle, response.css), layoutOnly: false };
}

// ../builder/integration/project-preview.mjs
var fail2 = (code) => Object.assign(new Error(code), { code });
var reads = /* @__PURE__ */ new Set(["data.list", "data.get", "model.list", "reports.context", "reports.list", "reports.get", "knowledge.search", "knowledge.documents", "knowledge.graph", "knowledge.evidence"]);
var foundationReads = /* @__PURE__ */ new Set(["status", "customers", "customer", "records", "opportunities", "pending", "pending.business", "models", "backup.status", "expert.tasks", "schedules", "schedule.history", "legacy", "data.list", "data.get"]);
function createProjectPreview(session, { invokeFoundation } = {}) {
  const entries = /* @__PURE__ */ new Map();
  let generation = 0;
  async function release(item) {
    try {
      await item.s.request("/runtime/" + item.token, "DELETE");
    } catch {
    }
  }
  return {
    async previewOpen(input) {
      if (!/^[a-f0-9]{32}$/.test(input?.projectId) || !/^[a-f0-9]{64}$/.test(input?.artifactHash)) throw fail2("STUDIO_PROJECT_INVALID");
      const g = ++generation, s = await session();
      const previous = [...entries.values()];
      entries.clear();
      await Promise.all(previous.map(release));
      const value = await s.request("/projects/" + input.projectId + "/runtime", "POST", { artifactHash: input.artifactHash, environment: "preview" });
      const item = { s, token: value.session, hash: input.artifactHash };
      if (g !== generation) {
        void release(item);
        throw fail2("PREVIEW_STALE");
      }
      let rendered;
      try {
        rendered = previewDocument(value, input.artifactHash);
      } catch (error) {
        await release(item);
        throw error;
      }
      s.assertLive();
      const handle = randomUUID();
      entries.set(handle, { ...item, layoutOnly: rendered.layoutOnly });
      return { handle, artifactHash: input.artifactHash, ...rendered };
    },
    async previewInvoke(input) {
      if (entries.get(input?.handle)?.layoutOnly) throw fail2("EXPERT_DEPLOYMENT_REQUIRED");
      const foundationRead = input?.method === "foundation.invoke" && foundationReads.has(input?.params?.operation);
      if (!reads.has(input?.method) && !foundationRead && !(input?.method === "dialogue.invoke" && input?.params?.operation === "read")) throw fail2("PREVIEW_READ_ONLY");
      const item = entries.get(input.handle);
      if (!item) throw fail2("PREVIEW_STALE");
      item.s.assertLive();
      const current = await session();
      if (current.key !== item.s.key) throw fail2("STUDIO_CONTEXT_CHANGED");
      let result = await item.s.request("/runtime/" + item.token + "/invoke", "POST", { method: input.method, params: input.params || {} });
      if (foundationRead && result?.nativeFoundation) {
        if (!invokeFoundation) throw fail2("FOUNDATION_NATIVE_REQUIRED");
        result = await invokeFoundation(result, item.s);
        await item.s.request("/runtime/" + item.token + "/invoke", "POST", { method: "foundation.invoke", params: { operation: "status", input: {} } });
      }
      item.s.assertLive();
      if (entries.get(input.handle) !== item) throw fail2("PREVIEW_STALE");
      return result;
    },
    async previewClose(input) {
      const item = entries.get(input?.handle);
      if (item) {
        entries.delete(input.handle);
        await release(item);
      }
      return { closed: true };
    }
  };
}

// ../builder/integration/export-package.mjs
import { mkdtemp, rm, rename, readFile as readFile2, writeFile as writeFile2, access } from "node:fs/promises";
import path2 from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
var exec = promisify(execFile);
var fail3 = (code) => Object.assign(new Error(code), { code });
async function exportStudioPackage({ input, request, assertLive, assets, chooseExport }) {
  if (!input || ![2, 3].includes(input.protocolVersion) || Object.keys(input).some((k) => !["protocolVersion", "projectId", "taskId", "artifactHash", "version"].includes(k)) || !/^[a-f0-9]{32}$/.test(input.projectId) || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.taskId) || !/^[a-f0-9]{64}$/.test(input.artifactHash) || !/^\d+\.\d+\.\d+$/.test(input.version)) throw fail3("STUDIO_EXPORT_INVALID");
  const read = async () => {
    assertLive();
    const payload2 = await request(`/projects/${input.projectId}/install/${input.artifactHash}`);
    assertLive();
    if (payload2.artifactHash !== input.artifactHash || payload2.taskId !== input.taskId || payload2.version !== input.version) throw fail3("ACCEPTANCE_STALE");
    return payload2;
  };
  const payload = await read();
  const destination = await chooseExport(`${payload.applicationId}-${payload.version}.zip`);
  assertLive();
  if (!destination) return { state: "cancelled" };
  const directory = await mkdtemp(path2.join(os.tmpdir(), "wanx-package-"));
  const temporary = await mkdtemp(path2.join(path2.dirname(destination), ".wanx-export-"));
  try {
    const archive = path2.join(temporary, "application.zip");
    if (payload.packageBase64) {
      const bytes = Buffer.from(payload.packageBase64, "base64");
      if (!bytes.length || bytes.subarray(0, 2).toString() !== "PK") throw fail3("STANDARD_PACKAGE_INVALID");
      if (payload.packageSha256 && createHash("sha256").update(bytes).digest("hex") !== payload.packageSha256) throw fail3("STANDARD_PACKAGE_HASH_MISMATCH");
      await writeFile2(archive, bytes);
    } else {
      await writeMiniappPackage(payload, directory, { assets });
      await exec("/usr/bin/zip", ["-q", "-r", archive, "."], { cwd: directory });
    }
    const fresh = await read();
    if (JSON.stringify(fresh) !== JSON.stringify(payload)) throw fail3("ACCEPTANCE_STALE");
    if (payload.packageBase64) {
      try {
        await access(destination);
        throw fail3("EXPORT_EXISTS");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    assertLive();
    await rename(archive, destination);
    const sha256 = createHash("sha256").update(await readFile2(destination)).digest("hex");
    return { state: "exported", path: destination, sha256, version: payload.version, artifactHash: payload.artifactHash };
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

// ../builder/integration/personal-client/deployment-delivery.mjs
import { mkdir as mkdir2, readFile as readFile3, writeFile as writeFile3, rename as rename2, rm as rm2, lstat } from "node:fs/promises";
import path3 from "node:path";
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
var fail4 = (code) => Object.assign(Error(code), { code });
var stable = (value) => JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
var digest = (value) => "sha256:" + createHash2("sha256").update(stable(value)).digest("hex");
var standardFormat = "wanx-standard-expert-client-v1";
var standardContract = { id: "wanx.expert-app.v1", version: "1.0.0", collections: { state: { json: "string" } } };
function deploymentPayloadDigest(payload) {
  const { packageBase64, ...metadata } = payload;
  return digest(payload.format === standardFormat ? metadata : payload);
}
var id = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
function deploymentTicket(value) {
  if (!value || !id(value.id) || !id(value.operationId) || !["prepare_client", "activate"].includes(value.step) || !["wanx-miniapp-v1", "wanx-expert-app-v1"].includes(value.profile) || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Number.isSafeInteger(value.fence) || value.fence < 1 || !/^[a-f0-9]{64}$/.test(value.artifactHash) || !/^sha256:[a-f0-9]{64}$/.test(value.payloadDigest) || !/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(value.slotApplicationId) || !(typeof value.baseApplicationId === "string" && (value.profile === "wanx-miniapp-v1" ? /^ai\.wanx\.selfmade\.[a-f0-9]{32}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).test(value.baseApplicationId)) || !id(value.projectId) || !["dev", "prod"].includes(value.environment) || typeof value.boxId !== "string" || !value.boxId || typeof value.nonce !== "string" || value.nonce.length < 16 || value.nonce.length > 256 || value.scopeId !== void 0 && !/^[a-f0-9]{64}$/.test(value.scopeId)) throw fail4("DEPLOYMENT_TICKET_INVALID");
  return value;
}
async function save(file, value) {
  const temporary = file + "." + randomUUID2() + ".tmp";
  try {
    await writeFile3(temporary, JSON.stringify(value), { flag: "wx", mode: 384 });
    await rename2(temporary, file);
  } finally {
    await rm2(temporary, { force: true });
  }
}
async function ownedDirectory(directory) {
  await mkdir2(directory, { recursive: true, mode: 448 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail4("DEPLOYMENT_STORAGE_INVALID");
}
function createDeploymentDelivery({ session, scopeKey, root: root2, assets, applications, onChanged = () => {
}, intervalMs = 2500, runtimeNamespace = "workshop" }) {
  if (!["studio", "workshop"].includes(runtimeNamespace)) throw fail4("DEPLOYMENT_NAMESPACE_INVALID");
  let stopped = false, pending = false, scope2 = "", controller = new AbortController();
  const invalidate = () => {
    controller.abort(fail4("HOST_SESSION_EXPIRED"));
    controller = new AbortController();
    scope2 = "";
  };
  async function processTicket(raw, s, signal, clientId, directory) {
    let leaseDeadline = 0;
    let ticket = deploymentTicket(raw);
    const route = "/deployment/client-deliveries/" + ticket.id;
    const check = () => {
      signal.throwIfAborted();
      s.assertLive();
      if (scopeKey() !== scope2) throw fail4("HOST_SESSION_EXPIRED");
      if (leaseDeadline && performance.now() >= leaseDeadline) throw fail4("DEPLOYMENT_CLIENT_LEASE_EXPIRED");
    };
    check();
    const context = s.active.link.context();
    if (context.boxId && context.boxId !== ticket.boxId) throw fail4("DEPLOYMENT_TARGET_DENIED");
    const issued = { ...ticket }, claimStart = performance.now();
    ticket = deploymentTicket(await s.request(route + "/claim", "POST", { nonce: ticket.nonce, clientId }));
    const ticketKeys = ["id", "operationId", "step", "fence", "generation", "projectId", "artifactHash", "version", "baseApplicationId", "slotApplicationId", "environment", "boxId", "profile", "payloadDigest", "scopeId"];
    if (ticketKeys.some((k) => ticket[k] !== issued[k])) throw fail4("DEPLOYMENT_TICKET_CHANGED");
    leaseDeadline = claimStart + 45e3;
    check();
    const initial = { ...ticket };
    const renew = async () => {
      const started = performance.now();
      const next = deploymentTicket(await s.request(route + "/claim", "POST", { nonce: ticket.nonce, clientId }));
      leaseDeadline = started + 45e3;
      check();
      if (ticketKeys.some((k) => next[k] !== initial[k])) throw fail4("DEPLOYMENT_TICKET_CHANGED");
      ticket = next;
    };
    const acknowledgement = (state) => ({ nonce: ticket.nonce, clientId, state, artifactHash: ticket.artifactHash, slotApplicationId: ticket.slotApplicationId, operationId: ticket.operationId, step: ticket.step, fence: ticket.fence, generation: ticket.generation, payloadDigest: ticket.payloadDigest });
    try {
      const payload = await s.request(route + "/payload");
      check();
      const standard = payload.format === standardFormat;
      if (payload.format !== void 0 && !standard || deploymentPayloadDigest(payload) !== ticket.payloadDigest || payload.applicationId !== (standard ? ticket.baseApplicationId : ticket.slotApplicationId) || payload.artifactHash !== ticket.artifactHash || payload.version !== ticket.version || payload.runtimeNamespace !== runtimeNamespace) throw fail4("DEPLOYMENT_PAYLOAD_MISMATCH");
      const d = payload.deployment;
      for (const key of ["profile", "operationId", "generation", "baseApplicationId", "slotApplicationId", "boxId", "environment"]) if (d?.[key] !== ticket[key]) throw fail4("DEPLOYMENT_PAYLOAD_MISMATCH");
      if (standard && (runtimeNamespace !== "studio" || ticket.profile !== "wanx-expert-app-v1" || !ticket.scopeId || d.scopeId !== ticket.scopeId || d.schemaVersion !== 1 || stable(payload.runtimeContract) !== stable(standardContract) || payload.manifest?.applicationId !== ticket.baseApplicationId || payload.manifest?.version !== ticket.version || payload.name !== payload.manifest?.name || Object.keys(payload).sort().join() !== ["format", "applicationId", "name", "version", "artifactHash", "manifest", "packageSha256", "packageBase64", "runtimeNamespace", "runtimeContract", "deployment"].sort().join() || !/^[a-f0-9]{64}$/.test(payload.packageSha256) || typeof payload.packageBase64 !== "string" || payload.packageBase64.length > Math.ceil(STANDARD_MAX_COMPRESSED_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.packageBase64) || payload.packageBase64.length % 4 !== 0)) throw fail4("DEPLOYMENT_PAYLOAD_MISMATCH");
      const stage = path3.join(directory, ticket.id);
      await ownedDirectory(stage);
      const packageDirectory = path3.join(stage, "package");
      await rm2(packageDirectory, { recursive: true, force: true });
      check();
      const binding = { ...d, fence: ticket.fence, artifactHash: ticket.artifactHash, ...standard ? { ticketId: ticket.id, payloadDigest: ticket.payloadDigest } : {} };
      let standardInput;
      if (standard) {
        const bytes = Buffer.from(payload.packageBase64, "base64");
        if (!bytes.length || bytes.length > STANDARD_MAX_COMPRESSED_BYTES || bytes.toString("base64") !== payload.packageBase64 || createHash2("sha256").update(bytes).digest("hex") !== payload.packageSha256 || typeof applications.validateStandardDeployment !== "function" || typeof applications.installStandardDeployment !== "function") throw fail4("DEPLOYMENT_PAYLOAD_MISMATCH");
        const archivePath = path3.join(stage, "package.zip"), temporary = archivePath + "." + randomUUID2() + ".tmp";
        try {
          await writeFile3(temporary, bytes, { flag: "wx", mode: 384 });
          check();
          await rename2(temporary, archivePath);
        } finally {
          await rm2(temporary, { force: true });
        }
        standardInput = { archivePath, manifest: payload.manifest, binding, artifactHash: ticket.artifactHash, packageSha256: payload.packageSha256, assertSession: check };
        const validated = await applications.validateStandardDeployment(standardInput, { signal });
        check();
        if (validated?.validated !== true || validated.applicationId !== ticket.slotApplicationId || validated.packageApplicationId !== ticket.baseApplicationId || validated.artifactHash !== ticket.artifactHash || validated.packageSha256 !== payload.packageSha256) throw fail4("DEPLOYMENT_PAYLOAD_MISMATCH");
      } else {
        await writeMiniappPackage(payload, packageDirectory, { assets });
        check();
        const actual = JSON.parse(await readFile3(path3.join(packageDirectory, "miniapp.runtime.json"), "utf8"));
        if (actual.artifactHash !== ticket.artifactHash || actual.runtimeNamespace !== runtimeNamespace || stable(actual.deployment) !== stable(d)) throw fail4("DEPLOYMENT_PAYLOAD_MISMATCH");
      }
      await save(path3.join(stage, "journal.json"), { operationId: ticket.operationId, generation: ticket.generation, fence: ticket.fence, payloadDigest: ticket.payloadDigest, state: "prepared" });
      let state = "prepared";
      if (ticket.step === "activate") {
        await renew();
        check();
        if (standard) await applications.installStandardDeployment(standardInput, { signal });
        else await applications.installDeployment({ sourceDir: packageDirectory, binding, assertSession: check }, { signal });
        check();
        const installed = (await applications.listInstalled()).find((value) => value.applicationId === ticket.slotApplicationId);
        check();
        if (!installed?.deployment || installed.deployment.operationId !== ticket.operationId || installed.deployment.generation !== ticket.generation || installed.deployment.artifactHash !== ticket.artifactHash) throw fail4("INSTALLED_ARTIFACT_MISMATCH");
        if (standard) {
          const record = JSON.parse(await readFile3(path3.join(installed.installPath, ".wanx-install.json"), "utf8")), original = JSON.parse(await readFile3(path3.join(installed.installPath, "application.manifest.json"), "utf8")), bytes = await readFile3(path3.join(installed.installPath, ".wanx-standard-package.zip"));
          check();
          if (record.applicationId !== ticket.slotApplicationId || record.packageApplicationId !== ticket.baseApplicationId || record.descriptor?.manifest?.applicationId !== ticket.baseApplicationId || record.descriptor?.sha256 !== payload.packageSha256 || record.standardDeployment?.format !== standardFormat || record.standardDeployment?.runtimeNamespace !== runtimeNamespace || stable(record.deployment) !== stable(binding) || original.applicationId !== ticket.baseApplicationId || original.version !== ticket.version || createHash2("sha256").update(bytes).digest("hex") !== payload.packageSha256) throw fail4("INSTALLED_ARTIFACT_MISMATCH");
        } else {
          const record = JSON.parse(await readFile3(path3.join(installed.installPath, "miniapp.runtime.json"), "utf8"));
          check();
          if (record.applicationId !== ticket.slotApplicationId || record.artifactHash !== ticket.artifactHash || record.runtimeNamespace !== runtimeNamespace || stable(record.deployment) !== stable(d)) throw fail4("INSTALLED_ARTIFACT_MISMATCH");
        }
        state = "active";
        await save(path3.join(stage, "journal.json"), { operationId: ticket.operationId, generation: ticket.generation, fence: ticket.fence, payloadDigest: ticket.payloadDigest, state });
      }
      await renew();
      check();
      await s.request(route + "/ack", "POST", acknowledgement(state));
      check();
      if (state === "active") {
        await onChanged();
        check();
        await applications.launch(ticket.slotApplicationId);
        check();
      }
    } catch (error) {
      try {
        check();
        await s.request(route + "/ack", "POST", { ...acknowledgement("failed"), errorCode: "CLIENT_UNAVAILABLE" });
      } catch {
      }
      throw error;
    }
  }
  async function tick() {
    if (stopped || pending) return;
    const key = scopeKey();
    if (scope2 && scope2 !== key) invalidate();
    scope2 = key;
    const signal = controller.signal;
    pending = true;
    try {
      const s = await session();
      signal.throwIfAborted();
      s.assertLive();
      if (scopeKey() !== key) return;
      const directory = path3.join(root2, createHash2("sha256").update(key).digest("hex"));
      await ownedDirectory(directory);
      const clientFile = path3.join(directory, "client.json");
      let clientId;
      try {
        clientId = JSON.parse(await readFile3(clientFile, "utf8")).clientId;
        if (typeof clientId !== "string" || !id(clientId)) throw fail4("DEPLOYMENT_STORAGE_INVALID");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        clientId = randomUUID2().replaceAll("-", "");
        await save(clientFile, { clientId });
      }
      const result = await s.request("/deployment/client-deliveries");
      signal.throwIfAborted();
      s.assertLive();
      if (!result || !Array.isArray(result.items) || result.items.length > 100) throw fail4("DEPLOYMENT_TICKET_INVALID");
      for (const ticket of result.items) {
        try {
          await processTicket(ticket, s, signal, clientId, directory);
        } catch (error) {
          signal.throwIfAborted();
          s.assertLive();
        }
      }
    } catch {
    } finally {
      pending = false;
    }
  }
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return { tick, invalidate, close() {
    stopped = true;
    clearInterval(timer);
    controller.abort();
  } };
}

// ../builder/integration/host-entry.mjs
var fail5 = (code) => Object.assign(new Error(code), { code });
var projectId = (id2) => typeof id2 === "string" && /^[a-f0-9]{32}$/.test(id2);
var scope = (context) => JSON.stringify([context.accountId, context.boxId, context.user.id]);
var connectionScope = (context) => context && ["accountId", "clientId", "boxId"].every((key) => typeof context[key] === "string" && context[key]) ? JSON.stringify([context.accountId, context.clientId, context.boxId]) : "";
function projectSummary(p) {
  const states = {
    discovery: ["\u6B63\u5728\u68B3\u7406\u9700\u6C42", "\u7EE7\u7EED\u8BA8\u8BBA"],
    confirmed: ["\u7B49\u5F85\u786E\u8BA4", "\u7EE7\u7EED\u6838\u5BF9\u65B9\u6848"],
    building: ["\u5F00\u53D1\u4E2D", "\u67E5\u770B\u8FDB\u5C55"],
    waiting: ["\u7B49\u5F85\u56DE\u7B54", "\u56DE\u7B54\u95EE\u9898"],
    preview: ["\u6709\u65B0\u7248\u672C\u53EF\u8BD5\u7528", "\u6253\u5F00\u4EA7\u54C1"],
    adopted: ["\u6301\u7EED\u6539\u8FDB", "\u6253\u5F00\u4EA7\u54C1"],
    accepted: ["\u5DF2\u6709\u91C7\u7528\u7248\u672C", "\u7EE7\u7EED\u6539\u8FDB"],
    installed: ["\u5DF2\u5B89\u88C5", "\u7EE7\u7EED\u5F00\u53D1"],
    failed: ["\u5F00\u53D1\u672A\u5B8C\u6210", "\u67E5\u770B\u539F\u56E0"],
    interrupted: ["\u4EFB\u52A1\u5DF2\u4E2D\u65AD", "\u67E5\u770B\u539F\u56E0"],
    cancelled: ["\u5DF2\u505C\u6B62", "\u7EE7\u7EED\u5F00\u53D1"]
  };
  let [label, action] = states[p.stage] || ["\u7EE7\u7EED\u5F00\u53D1", "\u6253\u5F00\u9879\u76EE"];
  let attention = { waiting: "\u6709\u4E00\u4E2A\u5F00\u53D1\u95EE\u9898\u9700\u8981\u4F60\u56DE\u7B54", preview: "\u65B0\u6210\u679C\u5DF2\u751F\u6210\uFF0C\u8BD5\u7528\u540E\u53EF\u9009\u62E9\u91C7\u7528", adopted: "\u5DF2\u91C7\u7528\uFF0C\u53EF\u7EE7\u7EED\u6539\u8FDB\u6216\u5BFC\u51FA", accepted: "\u5DF2\u6709\u91C7\u7528\u7248\u672C\uFF0C\u53EF\u7EE7\u7EED\u6539\u8FDB\u6216\u5BFC\u51FA", failed: "\u5F00\u53D1\u9047\u5230\u95EE\u9898\uFF0C\u8BF7\u67E5\u770B\u539F\u56E0", interrupted: "\u4E0A\u6B21\u5F00\u53D1\u5DF2\u4E2D\u65AD\uFF0C\u53EF\u4EE5\u67E5\u770B\u8BB0\u5F55\u540E\u7EE7\u7EED" }[p.stage] || "";
  if (p.preparation?.phase === "intake") {
    label = "\u6784\u5EFA\u51C6\u5907";
    action = "\u7EE7\u7EED\u914D\u7F6E";
  }
  const adoptedHash = p.versioning?.adoptedHash || p.acceptance?.artifactHash || null;
  const adopted = p.artifacts?.find((a) => a.hash === adoptedHash);
  const s = p.solution;
  const ready = p.readiness?.ready ?? (s && ["audience", "workflow", "inputs", "outputs"].every((k) => s[k]?.trim()) && s.acceptance?.length && s.dependencies?.every((d) => ["manual", "defer"].includes(p.decisions?.[d.id]?.choice)));
  if (p.stage === "discovery" && ready && !p.preparation) {
    label = "\u65B9\u6848\u5F85\u786E\u8BA4";
    action = "\u67E5\u770B\u65B9\u6848";
    attention = "\u9700\u6C42\u65B9\u6848\u5DF2\u6574\u7406\u597D\uFF0C\u8BF7\u67E5\u770B\u5E76\u786E\u8BA4";
  }
  return {
    id: p.id,
    appId: p.appId,
    name: p.name,
    goal: p.originalGoal,
    stage: p.stage,
    versions: (p.versions || p.artifacts?.slice().reverse() || []).map((v) => Object.fromEntries(["hash", "version", "createdAt", "baseHash", "summary", "status", "restoredFrom"].map((k) => [k, v[k]]))),
    label,
    action,
    attention,
    preparationPhase: p.preparation?.phase || null,
    updatedAt: p.updatedAt,
    adoptedArtifactHash: adopted?.hash || null,
    adoptedTaskId: adopted?.taskId || null,
    adoptedVersion: adopted?.version || null,
    iterationState: p.versioning?.iteration?.state || null,
    deletedAt: p.deletedAt || null,
    nameMode: p.nameMode || "manual",
    latestTaskId: p.tasks?.at(-1)?.id || null,
    latestArtifactHash: p.artifacts?.at(-1)?.hash || null,
    acceptedArtifactHash: p.acceptance?.artifactHash || null,
    installedVersion: p.installed?.version || null,
    latestVersion: p.artifacts?.at(-1)?.version || null
  };
}
function createStudioEntry({ createConnection, applications, assets, openWorkspace, workspacePlacement, chooseExport = async () => {
  throw fail5("STUDIO_EXPORT_UNAVAILABLE");
}, deploymentRoot, onDeploymentChanged, deploymentIntervalMs = 2500, deploymentConnection }) {
  let destination = null;
  let closed = false, authorizationRevision = 0, delivery, authorized, unsubscribe, unsubscribeConnection, observedConnection = "";
  function clearDelivery() {
    unsubscribe?.();
    unsubscribe = null;
    authorized = null;
    delivery?.invalidate();
  }
  function close() {
    if (closed) return;
    closed = true;
    authorizationRevision++;
    destination = null;
    unsubscribeConnection?.();
    unsubscribeConnection = null;
    clearDelivery();
    delivery?.close();
  }
  async function enableDelivery(s, revision) {
    if (!deploymentRoot || !applications.installDeployment) return;
    const capability = await s.request("/deployment/capabilities");
    if (closed || revision !== authorizationRevision) throw fail5("HOST_SESSION_EXPIRED");
    s.assertLive();
    if (capability?.available !== true || capability.schemaVersion !== 1 || !Array.isArray(capability.operations) || !capability.operations.includes("deploy")) return;
    authorized = s;
    const invalidated = () => {
      if (authorized === s) {
        authorizationRevision++;
        clearDelivery();
      }
    };
    const off = s.active.link.onInvalidated?.(invalidated) || s.active.link.subscribe?.(() => {
      try {
        s.assertLive();
      } catch {
        invalidated();
      }
    });
    if (authorized !== s) {
      off?.();
      throw fail5("HOST_SESSION_EXPIRED");
    }
    unsubscribe = off;
    delivery ||= createDeploymentDelivery({
      runtimeNamespace: "studio",
      root: deploymentRoot,
      assets,
      applications,
      onChanged: onDeploymentChanged,
      intervalMs: deploymentIntervalMs,
      scopeKey: () => authorized?.key || "",
      session: async () => {
        if (!authorized || closed) throw fail5("HOST_SESSION_EXPIRED");
        authorized.assertLive();
        return authorized;
      }
    });
    void delivery.tick();
  }
  const exports = /* @__PURE__ */ new Map();
  async function authorize(expectedConnection) {
    const revision = ++authorizationRevision;
    clearDelivery();
    const s = await session();
    if (expectedConnection && connectionScope(s.active.link.context()) !== expectedConnection) throw fail5("HOST_SESSION_EXPIRED");
    await s.request("/context");
    s.assertLive();
    if (closed || revision !== authorizationRevision) throw fail5("HOST_SESSION_EXPIRED");
    await enableDelivery(s, revision);
    return s.assertLive;
  }
  function connectionChanged() {
    if (closed) return;
    let next = "";
    try {
      next = connectionScope(deploymentConnection.getContext());
    } catch {
    }
    if (next === observedConnection) return;
    observedConnection = next;
    authorizationRevision++;
    clearDelivery();
    if (next) void authorize(next).catch(() => {
    });
  }
  async function session() {
    if (closed) throw fail5("HOST_SESSION_EXPIRED");
    const connection = await createConnection("ai.wanx.studio");
    if (closed) throw fail5("HOST_SESSION_EXPIRED");
    const key = scope(connection.context());
    const assertLive = () => {
      if (closed) throw fail5("HOST_SESSION_EXPIRED");
      if (scope(connection.context()) !== key) throw fail5("STUDIO_CONTEXT_CHANGED");
    };
    async function request(route, method = "GET", body) {
      assertLive();
      const response = await connection.request({
        path: "/api/app-studio" + route,
        method,
        signal: AbortSignal.timeout(route === "/preflight" ? 6e4 : route.startsWith("/_client/launch") || route.endsWith("/intake") || route.endsWith("/capabilities/check") ? 24e4 : 6e4),
        ...body ? { headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) } : {}
      });
      assertLive();
      let raw = response.body;
      if (raw?.[Symbol.asyncIterator]) {
        const chunks = [];
        let size = 0;
        for await (const chunk of raw) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) throw fail5("STUDIO_RESPONSE_TOO_LARGE");
          chunks.push(chunk);
        }
        raw = Buffer.concat(chunks);
      }
      assertLive();
      if ((response.status === 404 || response.status === 503) && !route.includes("/context") && !route.includes("/intake") && !route.includes("/capabilities")) throw fail5("STUDIO_UNAVAILABLE");
      try {
        const value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : typeof raw === "string" ? raw : JSON.stringify(raw));
        const accepted = response.status === 202 && method === "POST" && /^\/(?:deployment\/operations(?:\/[a-f0-9]{32}\/resume)?|deployment\/directory-releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/submit|projects\/[a-f0-9]{32}\/deployment\/submit)$/.test(route);
        if (response.status !== 200 && !accepted) {
          const code = value.code || value.detail?.code;
          throw fail5(typeof code === "string" && /^[A-Z_]{4,80}$/.test(code) ? code : "STUDIO_REQUEST_FAILED");
        }
        return value;
      } catch (error) {
        if (error.code) throw error;
        throw fail5("STUDIO_RESPONSE_INVALID");
      }
    }
    return { key, request, assertLive, active: { link: connection } };
  }
  const preview = createProjectPreview(session);
  async function openIn(s, id2) {
    s.assertLive();
    const target = { projectId: id2, navigationId: randomUUID3(), scope: s.key, assertLive: s.assertLive };
    destination = target;
    try {
      if (openWorkspace) await openWorkspace({ protocolVersion: 2, projectId: id2 });
      else await applications.launch("ai.wanx.studio");
    } catch (error) {
      if (destination === target) destination = null;
      throw error;
    }
    s.assertLive();
    if (!openWorkspace) applications.activate?.("ai.wanx.studio");
    return { projectId: id2 };
  }
  if (deploymentRoot && deploymentConnection) {
    unsubscribeConnection = deploymentConnection.subscribe(connectionChanged);
    queueMicrotask(connectionChanged);
  }
  return Object.freeze({
    close,
    ...preview,
    async runtimeModel(input) {
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      const s = await session();
      try {
        return await s.request("/_client/projects/" + input.projectId + "/runtime-model");
      } catch (e) {
        if (e.code === "STUDIO_UNAVAILABLE") throw fail5("RUNTIME_MODEL_UPDATE_REQUIRED");
        throw e;
      }
    },
    async runtimeModelSave(input) {
      if (!projectId(input?.projectId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.operationId !== "string" || input.modelId !== null && (typeof input.modelId !== "string" || input.modelId.length > 128)) throw fail5("STUDIO_REQUEST_DENIED");
      const s = await session();
      return s.request("/_client/projects/" + input.projectId + "/runtime-model", "PUT", { operationId: input.operationId, expectedRevision: input.expectedRevision, modelId: input.modelId });
    },
    authorize,
    async launchSuggest(input) {
      const s = await session();
      return s.request("/_client/launch/suggest", "POST", { text: input?.text });
    },
    async launchSources(input) {
      const s = await session();
      if (!["warehouses", "storage", "references"].includes(input?.kind)) throw fail5("CONTEXT_REFERENCE_INVALID");
      return s.request("/_client/launch/sources?kind=" + input.kind + "&parent=" + encodeURIComponent(input.parent || "") + "&spaceId=" + encodeURIComponent(input.spaceId || "personal"));
    },
    async launchConfigure(input) {
      const s = await session();
      if (input?.projectId && !projectId(input.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      return s.request("/_client/launch/configure", "POST", input);
    },
    async launchStart(input) {
      const s = await session();
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      const p = await s.request("/_client/launch/" + input.projectId + "/start", "POST", {});
      await openIn(s, p.id);
      return p;
    },
    async placement(input) {
      if (!workspacePlacement) throw fail5("HOST_BRIDGE_UPDATE_REQUIRED");
      return workspacePlacement(input);
    },
    async enginesList() {
      return (await session()).request("/engines");
    },
    async enginesCheck(input) {
      if (input?.engineId !== "codex") throw fail5("ENGINE_NOT_ADAPTED");
      return (await session()).request("/engines/check", "POST", { engineId: input.engineId });
    },
    async enginesDefault(input) {
      if (input?.engineId !== "codex") throw fail5("ENGINE_NOT_ADAPTED");
      return (await session()).request("/engines/default", "PUT", { engineId: input.engineId });
    },
    async intakeOpen(input = {}) {
      const s = await session();
      if (input.projectId) {
        if (!projectId(input.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
        return s.request("/projects/" + input.projectId);
      }
      if (input.goal) {
        if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 12e3 || typeof input.operationId !== "string") throw fail5("STUDIO_CREATE_INVALID");
        return s.request("/projects", "POST", { name: "\u5F85\u547D\u540D\u9879\u76EE", goal: input.goal.trim(), intake: true, operationId: input.operationId });
      }
      const [context, catalog] = await Promise.all([s.request("/context"), s.request("/capabilities")]);
      if (context.features?.taskPreparation !== 1) throw fail5("HOST_BRIDGE_UPDATE_REQUIRED");
      return { context, catalog };
    },
    async intakeSend(input) {
      const s = await session();
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      return s.request("/projects/" + input.projectId + "/intake", "POST", { operationId: input.operationId, text: input.text });
    },
    async intakeState(input) {
      const s = await session();
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      return s.request("/projects/" + input.projectId + "/intake");
    },
    async intakeEvents(input) {
      const s = await session();
      if (!projectId(input?.projectId) || !Number.isSafeInteger(input.after || 0) || (input.after || 0) < 0) throw fail5("STUDIO_PROJECT_INVALID");
      return s.request("/projects/" + input.projectId + "/intake/events?after=" + (input.after || 0));
    },
    async contextSources(input) {
      const s = await session();
      if (!["space", "xingtu"].includes(input?.kind) || input.parent && !(input.kind === "xingtu" ? /^offset:[0-9]{1,7}$/ : /^[A-Za-z0-9_-]{1,128}$/).test(input.parent)) throw fail5("CONTEXT_REFERENCE_INVALID");
      return s.request("/context/sources?kind=" + input.kind + "&parent=" + encodeURIComponent(input.parent || ""));
    },
    async contextSelect(input) {
      const s = await session();
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      return s.request("/projects/" + input.projectId + "/context", "PUT", { operationId: input.operationId, expectedRevision: input.expectedRevision, references: input.references });
    },
    async capabilitiesList() {
      const s = await session();
      return s.request("/capabilities");
    },
    async capabilitiesState(input) {
      const s = await session();
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      return s.request("/projects/" + input.projectId + "/capabilities");
    },
    async capabilitiesDecide(input) {
      const s = await session();
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      return s.request("/projects/" + input.projectId + "/capabilities/decisions", "POST", { operationId: input.operationId, gapId: input.gapId, detail: input.detail });
    },
    async capabilitiesCheck(input) {
      const s = await session();
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      return s.request("/projects/" + input.projectId + "/capabilities/check", "POST", { operationId: input.operationId });
    },
    async intakeHandoff(input) {
      const s = await session();
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      const p = await s.request("/projects/" + input.projectId + "/intake/handoff", "POST", { operationId: input.operationId, expectedRevision: input.expectedRevision });
      await openIn(s, p.id);
      return p;
    },
    async overview() {
      const s = await session();
      const [result, context] = await Promise.all([s.request("/projects?includeDeleted=true"), s.request("/context")]);
      s.assertLive();
      return { protocolVersion: 2, projects: result.projects.map(projectSummary), modelAvailable: context.modelAvailable };
    },
    async create(input) {
      if (!input || typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 12e3 || typeof input.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(input.operationId)) throw fail5("STUDIO_CREATE_INVALID");
      const s = await session(), goal = input.goal.trim();
      const p = await s.request("/projects", "POST", { goal, name: goal.slice(0, 20), operationId: input.operationId });
      return openIn(s, p.id);
    },
    async workspace(input = {}) {
      if (input.protocolVersion !== 2) throw fail5("HOST_BRIDGE_UPDATE_REQUIRED");
      const s = await session();
      const c = await s.request("/context");
      if (!openWorkspace && !c.modelAvailable) throw fail5("MODEL_NOT_CONFIGURED");
      if (!openWorkspace) await s.request("/preflight");
      return openIn(s, null);
    },
    async metadata(input) {
      if (!projectId(input?.projectId) || !["rename", "auto-name", "delete", "restore"].includes(input.action) || typeof input.operationId !== "string") throw fail5("STUDIO_PROJECT_INVALID");
      const s = await session();
      return s.request("/projects/" + input.projectId + "/metadata", "PUT", { operationId: input.operationId, action: input.action, name: input.name || "" });
    },
    async export(input) {
      const s = await session();
      const key = s.key + JSON.stringify(input);
      if (exports.has(key)) return exports.get(key);
      const job = exportStudioPackage({ input, request: s.request, assertLive: s.assertLive, assets, chooseExport }).finally(() => exports.delete(key));
      exports.set(key, job);
      return job;
    },
    async open(input) {
      if (input?.protocolVersion !== void 0 && input.protocolVersion !== 2) throw fail5("HOST_BRIDGE_UPDATE_REQUIRED");
      if (!projectId(input?.projectId)) throw fail5("STUDIO_PROJECT_INVALID");
      const s = await session();
      await s.request("/projects/" + input.projectId);
      return openIn(s, input.projectId);
    },
    navigation(connection) {
      if (!destination || destination.scope !== scope(connection.context())) return { projectId: null };
      try {
        destination.assertLive();
      } catch {
        destination = null;
        return { projectId: null };
      }
      const { projectId: projectId2, navigationId } = destination;
      destination = null;
      return { projectId: projectId2, navigationId, protocolVersion: 2 };
    }
  });
}

// ../builder/integration/bundled-workbench.mjs
import { mkdir as mkdir3, mkdtemp as mkdtemp2, readFile as readFile4, readdir as readdir2, rm as rm3, writeFile as writeFile4 } from "node:fs/promises";
import { tmpdir } from "node:os";
import path4 from "node:path";
async function installBundledWorkbench(installer, sourceDir, { signal } = {}) {
  const bundled = JSON.parse(await readFile4(path4.join(sourceDir, "application.manifest.json"), "utf8"));
  const installed = (await installer.list()).find((record) => record.applicationId === bundled.applicationId);
  if (installed?.version === bundled.version) return;
  const staging = await mkdtemp2(path4.join(tmpdir(), "wanx-studio-bundle-"));
  async function copyDirectory(source, target) {
    signal?.throwIfAborted();
    await mkdir3(target);
    for (const entry of await readdir2(source, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const from = path4.join(source, entry.name), to = path4.join(target, entry.name);
      if (entry.isDirectory()) await copyDirectory(from, to);
      else if (entry.isFile()) await writeFile4(to, await readFile4(from), { flag: "wx" });
      else throw new Error("STUDIO_BUNDLE_FILE_INVALID");
    }
  }
  try {
    const directory = path4.join(staging, "workbench");
    await copyDirectory(sourceDir, directory);
    signal?.throwIfAborted();
    await installer.install({ sourceDir: directory }, { signal });
  } finally {
    await rm3(staging, { recursive: true, force: true });
  }
}

// ../builder/integration/host-control.mjs
var import_preview_navigation = __toESM(require_preview_navigation(), 1);
var STUDIO_ID = "ai.wanx.studio";
function createStudioControl({ applications, assets, onChanged = async () => {
}, navigation = () => ({ projectId: null }), returnToClient = async () => {
  throw new Error("STUDIO_RETURN_UNAVAILABLE");
} }) {
  const inFlight = /* @__PURE__ */ new Map();
  const fail6 = (code) => Object.assign(new Error(code), { code, status: 409 });
  return async function control({ operation, body, connection, assertLive }) {
    assertLive();
    if (operation === "navigation") return navigation(connection);
    if (operation === "return") {
      if (body?.protocolVersion !== 2 || !["projects", "models", "connectors", "skills", "environment"].includes(body.destination)) throw fail6("STUDIO_DESTINATION_DENIED");
      await returnToClient(body.destination);
      assertLive();
      return { protocolVersion: 2 };
    }
    if (operation === "projectChanged") {
      if (body?.protocolVersion !== 2 || !/^[a-f0-9]{32}$/.test(body.projectId)) throw fail6("STUDIO_PROJECT_INVALID");
      const response = await connection.request({ path: "/api/app-studio/projects/" + body.projectId, method: "GET" });
      if (response.status !== 200) throw fail6("STUDIO_PROJECT_INVALID");
      assertLive();
      await onChanged();
      return { protocolVersion: 2 };
    }
    if (operation === "open") {
      if (typeof body.applicationId !== "string" || body.applicationId.length > 64 || !/^(?:ai\.wanx\.selfmade\.[a-f0-9]{32}|dev\.wanx\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.(?:[a-f0-9]{8}|a[a-f0-9]{8}))?)$/.test(body.applicationId)) throw fail6("STUDIO_APP_ID_DENIED");
      return applications.launch(body.applicationId);
    }
    if (operation !== "install" || !body || Object.keys(body).some((k) => !["projectId", "artifactHash"].includes(k)) || !/^[a-f0-9]{32}$/.test(body.projectId) || !/^[a-f0-9]{64}$/.test(body.artifactHash)) throw fail6("STUDIO_REQUEST_DENIED");
    const context = connection.context();
    const key = JSON.stringify([context.accountId, context.boxId, context.user.id, body.projectId, body.artifactHash]);
    if (inFlight.has(key)) return inFlight.get(key);
    const job = (async () => {
      const response = await connection.request({ path: `/api/app-studio/projects/${body.projectId}/install/${body.artifactHash}`, method: "GET" });
      const decode = async (r) => {
        let value = r.body;
        if (value?.[Symbol.asyncIterator]) {
          const chunks = [];
          let size = 0;
          for await (const chunk of value) {
            size += chunk.length;
            if (size > Math.ceil(STANDARD_MAX_COMPRESSED_BYTES / 3) * 4 + 1024 * 1024) throw fail6("STUDIO_RESPONSE_TOO_LARGE");
            chunks.push(chunk);
          }
          value = Buffer.concat(chunks);
        }
        return JSON.parse(Buffer.isBuffer(value) ? value.toString() : typeof value === "string" ? value : JSON.stringify(value));
      };
      const payload = await decode(response);
      if (response.status !== 200) throw fail6(payload.code || "USER_ACCEPTANCE_REQUIRED");
      assertLive();
      if (payload.artifactHash !== body.artifactHash) throw fail6("INSTALLED_ARTIFACT_MISMATCH");
      const standardBytes = payload.packageBase64 ? Buffer.from(payload.packageBase64, "base64") : null;
      const standardHash = standardBytes ? createHash3("sha256").update(standardBytes).digest("hex") : null;
      if (standardBytes && payload.packageSha256 && payload.packageSha256 !== standardHash) throw fail6("STANDARD_PACKAGE_HASH_MISMATCH");
      const restore = payload.restore !== void 0;
      if (restore && (!standardBytes || !payload.packageSha256 || standardBytes.toString("base64") !== payload.packageBase64 || !payload.restore || Object.keys(payload.restore).sort().join() !== "artifactHash,schemaVersion,source" || payload.restore.schemaVersion !== 1 || payload.restore.source !== "restore" || payload.restore.artifactHash !== payload.artifactHash || typeof applications.restoreStandardPackage !== "function")) throw fail6("STUDIO_RESTORE_DENIED");
      const installed = await applications.listInstalled();
      let current = installed.find((a) => a.applicationId === payload.applicationId);
      assertLive();
      if (!restore && current?.version === payload.version) {
        if (standardBytes) {
          const descriptor = current.descriptor;
          if (!descriptor || descriptor.sha256 !== standardHash || descriptor.applicationId !== payload.applicationId || descriptor.version !== payload.version) throw fail6("INSTALLED_ARTIFACT_MISMATCH");
        } else {
          const record = JSON.parse(await readFile5(path5.join(current.installPath, "miniapp.runtime.json"), "utf8"));
          if (record.artifactHash !== payload.artifactHash) throw fail6("INSTALLED_ARTIFACT_MISMATCH");
        }
      } else {
        const directory = await mkdtemp3(path5.join(os2.tmpdir(), "wanx-selfmade-install-"));
        try {
          if (standardBytes) {
            const archive = path5.join(directory, "application.zip");
            await writeFile5(archive, standardBytes);
            assertLive();
            current = restore ? await applications.restoreStandardPackage({ archivePath: archive, artifactHash: standardHash, manifest: payload.manifest, assertSession: assertLive }) : await applications.install({ archivePath: archive, standardArtifactHash: standardHash, manifest: payload.manifest });
          } else {
            await writeMiniappPackage(payload, directory, { assets });
            assertLive();
            current = await applications.install({ sourceDir: directory });
          }
          assertLive();
        } finally {
          await rm4(directory, { recursive: true, force: true });
        }
      }
      const receipt = { operationId: randomUUID4(), artifactHash: payload.artifactHash, applicationId: payload.applicationId, version: payload.version };
      const acknowledged = await connection.request({ path: `/api/app-studio/projects/${body.projectId}/installed`, method: "POST", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(receipt)) });
      if (acknowledged.status !== 200) throw fail6("INSTALL_RECEIPT_NOT_COMMITTED");
      assertLive();
      await onChanged();
      return { applicationId: payload.applicationId, version: payload.version, state: "installed" };
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  };
}
var export_installPreviewNavigationGuard = import_preview_navigation.installPreviewNavigationGuard;
export {
  STUDIO_ID,
  createStudioControl,
  createStudioEntry,
  installBundledWorkbench,
  export_installPreviewNavigationGuard as installPreviewNavigationGuard
};
