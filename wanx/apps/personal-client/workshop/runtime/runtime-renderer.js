"use strict";
(() => {
  // core/haowen-picker.mjs
  function haowenPicker(request, mode) {
    return new Promise((resolve, reject) => {
      const shade = document.createElement("div");
      shade.className = "shade modal-shade";
      const panel = document.createElement("section");
      panel.className = "picker modal";
      panel.style.cssText = "max-height:85vh;overflow:auto;max-width:720px;width:90vw";
      shade.append(panel);
      document.body.append(shade);
      const selected = /* @__PURE__ */ new Map(), node = (tag, text) => {
        const n = document.createElement(tag);
        if (text) n.textContent = text;
        return n;
      };
      const button = (label, fn) => {
        const b = node("button", label);
        b.type = "button";
        b.onclick = () => Promise.resolve(fn()).catch(error2);
        return b;
      };
      const error2 = (e) => {
        panel.querySelector("[role=alert]")?.remove();
        const p = node("p", "\u672A\u5B8C\u6210\uFF1A" + String(e.message || e));
        p.setAttribute("role", "alert");
        panel.append(p);
      };
      const done = (value) => {
        shade.remove();
        resolve(value);
      };
      async function browse(parent = "") {
        panel.replaceChildren(node("h2", mode === "knowledge" ? "\u914D\u7F6E\u597D\u95EE\u77E5\u8BC6\u5E93" : "\u914D\u7F6E\u76D2\u5B50\u6587\u4EF6\u7A7A\u95F4"), node("p", "\u9009\u62E9\u6574\u4E2A\u7A7A\u95F4\u3001\u76EE\u5F55\u6216\u5355\u4E2A\u6587\u4EF6\u3002\u4EC5\u5728\u5F53\u524D\u5E94\u7528\u548C\u5F53\u524D\u8FD0\u884C\u73AF\u5883\u751F\u6548\uFF1B\u4FDD\u5B58\u5E94\u7528\u8BBE\u7F6E\u540E\u4F7F\u7528\u3002"));
        const result = await request({ action: "catalog", kind: mode, parent });
        if (parent) panel.append(button("\u8FD4\u56DE\u7A7A\u95F4\u5217\u8868", () => browse("")));
        for (const f of result.items) {
          const kind = mode === "knowledge" ? "knowledge" : f.scopeKind || f.kind;
          const label = node("label");
          label.style.cssText = "display:flex;gap:12px;align-items:center;margin:12px 0";
          const box = node("input");
          box.type = "checkbox";
          const key = kind + ":" + f.id;
          box.checked = selected.has(key);
          box.onchange = () => box.checked ? selected.set(key, { kind, id: f.id }) : selected.delete(key);
          label.append(box, node("span", f.name));
          if (mode !== "knowledge" && f.kind === "folder") label.append(button("\u8FDB\u5165\u76EE\u5F55", () => browse(f.id)));
          panel.append(label);
        }
        panel.append(button("\u53D6\u6D88", () => done([])), button("\u9009\u62E9\u8D44\u6599\u8303\u56F4", async () => done(await request({ action: "select", sources: [...selected.values()] }))));
      }
      const fields = { wecom: ["bot_id", "secret"], feishu: ["app_id", "app_secret", "encrypt_key", "verification_token"], dingtalk: ["client_id", "client_secret"], weixin: ["bot_uin", "token"] }, names = { wecom: "\u4F01\u4E1A\u5FAE\u4FE1", feishu: "\u98DE\u4E66", dingtalk: "\u9489\u9489", weixin: "\u5FAE\u4FE1" };
      async function edit(id = "", kind = "wecom") {
        const detail = id ? await request({ action: "channel-detail", id }) : { name: "", kind, values: {}, configured: [] };
        panel.replaceChildren(node("h2", "\u914D\u7F6E" + names[detail.kind] + "\u901A\u9053"), node("p", "\u673A\u5668\u4EBA\u51ED\u636E\u4FDD\u5B58\u5728\u4E07\u8C61\u76D2\u7AEF\u901A\u9053\u670D\u52A1\u4E2D\u3002\u6B64\u5904\u4FDD\u5B58\u8FDE\u63A5\u4FE1\u606F\u540E\uFF0C\u8FD8\u9700\u5728\u597D\u95EE\u8BBE\u7F6E\u4E2D\u4FDD\u5B58\u5141\u8BB8\u540D\u5355\u3001\u8D44\u6599\u8303\u56F4\u4E0E\u539F\u6587\u4EF6\u53D1\u9001\u6743\u9650\u3002"));
        const name = node("input");
        name.setAttribute("aria-label", "\u901A\u9053\u540D\u79F0");
        name.placeholder = "\u901A\u9053\u540D\u79F0";
        name.value = detail.name;
        panel.append(name);
        const inputs = {};
        for (const f of fields[detail.kind]) {
          const label = node("label", f + (detail.configured.includes(f) ? "\uFF08\u5DF2\u914D\u7F6E\uFF0C\u7559\u7A7A\u4FDD\u6301\uFF09" : "")), input = node("input");
          input.setAttribute("aria-label", f);
          input.type = ["secret", "app_secret", "client_secret", "encrypt_key", "verification_token", "token"].includes(f) ? "password" : "text";
          input.autocomplete = "off";
          input.value = detail.values[f] || "";
          label.append(input);
          label.style.cssText = "display:block;margin:16px 0";
          panel.append(label);
          inputs[f] = input;
        }
        panel.append(button("\u8FD4\u56DE", channels), button("\u4FDD\u5B58\u901A\u9053", async () => {
          await request({ action: "channel-save", id, kind: detail.kind, name: name.value, values: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])) });
          await channels();
        }));
      }
      async function channels() {
        const result = await request({ action: "channels" });
        panel.replaceChildren(node("h2", "\u597D\u95EE \xB7 \u6807\u51C6\u901A\u9053\u8FDE\u63A5"), node("p", "\u8FDE\u63A5\u6210\u529F\u4E0D\u7B49\u4E8E\u5F00\u653E\u4F7F\u7528\u3002\u6BCF\u6761\u901A\u9053\u9ED8\u8BA4\u62D2\u7EDD\u8BBF\u95EE\uFF1B\u8BF7\u5728\u597D\u95EE\u8BBE\u7F6E\u4E2D\u914D\u7F6E\u767D\u540D\u5355\u548C\u8D44\u6599\u8303\u56F4\u540E\u542F\u7528\u3002"));
        for (const r of result.items) {
          const row = node("div");
          row.style.cssText = "padding:16px 0;border-bottom:1px solid #ddd";
          row.append(node("strong", r.name + " \xB7 " + names[r.kind]), node("p", r.runtime?.connected ? "\u5DF2\u8FDE\u63A5" : r.enabled ? "\u6B63\u5728\u8FDE\u63A5\uFF0F\u8FDE\u63A5\u5F02\u5E38" : "\u5DF2\u505C\u7528"), button("\u4FEE\u6539\u8FDE\u63A5", () => edit(r.id)), button(r.enabled ? "\u65AD\u5F00\u8FDE\u63A5" : "\u8FDE\u63A5", async () => {
            await request({ action: "channel-toggle", id: r.id, enabled: !r.enabled });
            await channels();
          }));
          panel.append(row);
        }
        const select = node("select");
        select.setAttribute("aria-label", "\u901A\u9053\u7C7B\u578B");
        for (const k of result.kinds) {
          const option = node("option", names[k]);
          option.value = k;
          select.append(option);
        }
        panel.append(select, button("\u6DFB\u52A0\u901A\u9053", () => edit("", select.value)), button("\u5B8C\u6210", () => done(true)));
      }
      Promise.resolve(mode === "channels" ? channels() : browse()).catch((e) => {
        shade.remove();
        reject(e);
      });
    });
  }

  // shell/runtime-renderer.mjs
  var host = window.miniappHost;
  var frame = document.querySelector("iframe");
  var error = document.getElementById("error");
  async function picker(knowledge = false) {
    return new Promise((resolve, reject) => {
      const shade = document.createElement("div");
      shade.className = "shade";
      const panel = document.createElement("div");
      panel.className = "picker";
      shade.append(panel);
      document.body.append(shade);
      const selected = /* @__PURE__ */ new Set();
      const text = (tag, value) => {
        const node = document.createElement(tag);
        node.textContent = value;
        return node;
      };
      async function render(parent = "") {
        panel.replaceChildren(text("h2", knowledge ? "\u9009\u62E9\u661F\u56FE\u77E5\u8BC6\u5E93" : "\u9009\u62E9\u53C2\u8003\u8D44\u6599"), text("p", "\u4EC5\u5141\u8BB8\u5F53\u524D\u5E94\u7528\u8BFB\u53D6\u4F60\u660E\u786E\u9009\u62E9\u7684\u6765\u6E90\uFF1B\u590D\u5236\u5E94\u7528\u4E0D\u4F1A\u590D\u5236\u6388\u6743\u3002"));
        try {
          const list = knowledge ? await host.knowledgeList() : await host.list(parent);
          if (parent) {
            const back = text("button", "\u8FD4\u56DE\u6839\u76EE\u5F55");
            back.onclick = () => render("");
            panel.append(back);
          }
          for (const file of list.items) {
            const row = document.createElement("label");
            if (file.kind === "folder") {
              const button = text("button", "\u25B1 " + file.name);
              button.onclick = () => render(file.id);
              row.append(button);
            } else {
              const box = document.createElement("input");
              box.type = "checkbox";
              box.disabled = !knowledge && !/\.(txt|md|csv|json)$/i.test(file.name);
              box.checked = selected.has(file.id);
              box.onchange = () => box.checked ? selected.add(file.id) : selected.delete(file.id);
              row.append(box, text("span", file.name));
            }
            panel.append(row);
          }
          const actions = document.createElement("div");
          actions.className = "actions";
          const cancel = text("button", "\u53D6\u6D88");
          cancel.onclick = () => {
            shade.remove();
            resolve([]);
          };
          const ok = text("button", "\u9009\u62E9\u8D44\u6599");
          ok.className = "primary";
          ok.onclick = async () => {
            try {
              const result = knowledge ? await host.knowledgeSelect([...selected]) : await host.select([...selected]);
              shade.remove();
              resolve(result);
            } catch (e) {
              panel.append(text("p", "\u9009\u62E9\u672A\u5B8C\u6210\uFF1A" + e.message));
            }
          };
          actions.append(cancel, ok);
          panel.append(actions);
        } catch (e) {
          shade.remove();
          reject(e);
        }
      }
      void render();
    });
  }
  host.load().then(() => {
    frame.onload = () => {
      const channel = new MessageChannel();
      let pending = 0;
      channel.port1.onmessage = async ({ data: m }) => {
        if (!m || !Number.isSafeInteger(m.id) || pending >= 4) return;
        pending++;
        try {
          const result = m.method === "haowen.select" ? await haowenPicker(host.haowenNative, m.params?.kind) : m.method === "haowen.channels" ? await haowenPicker(host.haowenNative, "channels") : m.method === "files.select" ? await picker() : m.method === "knowledge.select" ? await picker(true) : await host.invoke(m.method, m.params || {});
          channel.port1.postMessage({ id: m.id, result });
        } catch (e) {
          channel.port1.postMessage({ id: m.id, error: e.message });
        } finally {
          pending--;
        }
      };
      frame.contentWindow.postMessage({ type: "wanx:init" }, "*", [channel.port2]);
    };
    frame.src = "miniapp-frame.html";
  }).catch(() => {
    frame.remove();
    error.textContent = "\u5F53\u524D\u5E94\u7528\u4F1A\u8BDD\u4E0D\u53EF\u7528\uFF0C\u8BF7\u8FD4\u56DE\u4E07\u8C61\u91CD\u65B0\u6253\u5F00\u3002";
  });
})();
