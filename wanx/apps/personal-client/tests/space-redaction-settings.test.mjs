import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../local-ui/renderer/space-redaction-settings.js", import.meta.url), "utf8");
const initialRules = {
  owner: "owner-a", revision: 2,
  builtins: [{ id: "email", label: "电子邮件", enabled: true }],
  customRules: [{ name: "研究客户", value: "旧客户编号" }],
};

function harness(request) {
  const window = {};
  const calls = [];
  vm.runInNewContext(source, { window });
  const controller = window.createSpaceRedactionSettings({
    request: (action, input) => {
      calls.push({ action, input: input && structuredClone(input) });
      return request(action, input);
    },
    escapeHTML: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
  });
  const listeners = new Map();
  const host = {
    innerHTML: "",
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  controller.sync("account-a");
  controller.mount(host);
  const click = (redactionAction, index) => listeners.get("click")({
    target: { closest: () => ({ dataset: { redactionAction, index } }) }, stopPropagation() {},
  });
  const input = (redactionField, index, change) => listeners.get("input")({
    target: { dataset: { redactionField, index }, ...change },
  });
  const submit = () => listeners.get("submit")({ preventDefault() {}, stopPropagation() {} });
  return { controller, host, calls, click, input, submit };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test("Space settings saves builtin toggles and exact custom literals with the loaded owner and revision", async () => {
  const ui = harness(async (action, input) => action === "space.redaction-rules"
    ? initialRules : { ...input, revision: 3, builtins: [{ ...input.builtins[0], label: "电子邮件" }] });
  assert.match(ui.host.innerHTML, /空间脱敏规则/);
  assert.deepEqual(ui.calls, []);

  ui.click("toggle");
  await settled();
  ui.click("remove", 0);
  ui.click("add");
  ui.input("name", 0, { value: " 编号 " });
  ui.input("value", 0, { value: ' <A="1"> ' });
  ui.input("builtin", 0, { checked: false });
  ui.submit();
  await settled();

  assert.deepEqual(ui.calls, [
    { action: "space.redaction-rules", input: undefined },
    { action: "space.save-redaction-rules", input: {
      owner: "owner-a", revision: 2, builtins: [{ id: "email", enabled: false }],
      customRules: [{ name: "编号", value: ' <A="1"> ' }],
    } },
  ]);
  assert.match(ui.host.innerHTML, /空间脱敏规则已保存/);
  assert.match(ui.host.innerHTML, /&lt;A=&quot;1&quot;/);
  assert.doesNotMatch(ui.host.innerHTML, /旧客户编号|<A="1">/);
});

test("Space settings discards a rules response after the active owner changes", async () => {
  let finish;
  const ui = harness(() => new Promise(resolve => { finish = resolve; }));
  ui.click("toggle");
  assert.match(ui.host.innerHTML, /正在读取规则/);
  ui.controller.sync("account-b");
  finish(initialRules);
  await settled();
  assert.match(ui.host.innerHTML, /管理规则/);
  assert.doesNotMatch(ui.host.innerHTML, /旧客户编号|正在读取规则|保存规则/);
});
