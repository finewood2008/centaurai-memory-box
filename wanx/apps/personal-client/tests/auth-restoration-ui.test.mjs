import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const index = new URL("../build/app/local-ui/renderer/index.html", import.meta.url);
const html = await readFile(index, "utf8");
const source = (await Promise.all([...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(match => match[1]).filter(src => src !== "./device-setup.bundle.js")
  .map(src => readFile(new URL(src, index), "utf8")))).join("\n");
const state = (phase, reason = null) => ({ route: "auth", phase, account: { phase, reason } });

async function harness(initialPhase, options = {}) {
  const events = new Map(), calls = [];
  let current = state(initialPhase, options.reason), onState, form, markup = "";
  // Model actual form replacement and retention, including the submit's initial
  // disabled attribute, so a later render cannot silently re-enable an old form.
  const app = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      const auth = value.match(/<form\b[^>]*data-form="auth"[^>]*>([\s\S]*?)<\/form>/);
      if (!auth) { form = null; return; }
      const button = auth[1].match(/<button\b([^>]*type="submit"[^>]*)>([\s\S]*?)<\/button>/);
      const submit = {
        disabled: /\bdisabled\b/.test(button[1]),
        innerHTML: button[2], classList: { toggle() {} }, setAttribute() {},
        get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ""); },
      };
      const authNotice = {};
      const savedLogins = { hidden: true }, savedLogin = { value: "", innerHTML: "", disabled: false };
      form = {
        dataset: { form: "auth", mode: value.match(/data-mode="([^"]+)"/)[1] },
        elements: { username: { name: "username", value: "13800138000" }, password: { name: "password", value: "password" }, remember: { checked: true }, savedLogin },
        contains: () => false, addEventListener() {},
        querySelector: selector => selector === 'button[type="submit"]' ? submit : selector === '[data-auth-notice]' ? authNotice : selector === '[data-saved-logins]' ? savedLogins : null,
        replaceWith: retained => { form = retained; },
      };
    },
    querySelector: selector => selector === '[data-form="auth"]' ? form : null,
    addEventListener: (name, fn) => events.set(name, fn),
  };
  vm.runInNewContext(source, {
    queueMicrotask,
    window: { addEventListener() {}, wanxClient: {
      getLocalState: async () => current,
      onLocalState: listener => { onState = listener; },
      listRememberedLogins: async () => options.list ? options.list() : { items: [] },
      getRememberedLogin: async phone => options.get ? options.get(phone) : { remember: true },
      action: async (name, input) => { calls.push([name, input]); return { ok: true, state: current }; },
    } },
    document: { body: { dataset: {}, append() {}, classList: { toggle() {} } }, createElement: () => ({ dataset: {}, setAttribute() {} }),
      addEventListener() {}, querySelector: selector => selector === "#app" ? app : null },
    FormData: class { constructor(node) { return Object.entries(node.elements)
      .map(([name, input]) => [name, name === "remember" ? input.checked ? "on" : "" : input.value]); } },
    Date, setTimeout, clearTimeout, setInterval() {}, clearInterval() {}, TextEncoder,
  });
  await new Promise(resolve => setImmediate(resolve));
  return {
    app, calls, form: () => form, submitButton: () => form.querySelector('button[type="submit"]'),
    publish(phase, reason) { current = state(phase, reason); onState(current); },
    select(phone) { form.elements.savedLogin.value = phone; return events.get("change")({ target: { name: "savedLogin", value: phone, dataset: {} } }); },
    forget() { form.elements.remember.checked = false; return events.get("change")({ target: { name: "remember", checked: false, dataset: {} } }); },
    input(name, value) { const target = form.elements[name]; target.value = value; events.get("input")({ target }); },
    submit() { return events.get("submit")({ preventDefault() {}, target: form }); },
  };
}

test("restoring an account disables the initial login form without a local login request", async () => {
  const h = await harness("authenticating");
  assert.equal(h.submitButton().disabled, true);
  assert.match(h.submitButton().textContent, /正在登录|正在恢复/);
  assert.deepEqual(h.calls, []);
});

test("login omits local device security and offers saved accounts without exposing passwords in markup", async () => {
  const phone = "13800138000", password = "saved-secret";
  const h = await harness("signed_out", {
    list: async () => ({ items: [{ phone }, { phone: "13900139000" }] }),
    get: async () => ({ phone, password, remember: true }),
  });
  assert.doesNotMatch(h.app.innerHTML, /本地设备安全|data-action="device-trust-open"/);
  assert.equal(h.form().querySelector('[data-saved-logins]').hidden, false);
  assert.match(h.form().elements.savedLogin.innerHTML, /13800138000/);
  assert.match(h.form().elements.savedLogin.innerHTML, /13900139000/);
  assert.equal(h.form().elements.savedLogin.value, phone);
  assert.equal(h.form().elements.password.value, password);
  assert.doesNotMatch(h.app.innerHTML + h.form().elements.savedLogin.innerHTML, /saved-secret/);
});

test("selecting a saved account fills its password; choosing another account clears both fields", async () => {
  const h = await harness("signed_out", {
    list: async () => ({ items: [{ phone: "13800138000" }, { phone: "13900139000" }] }),
    get: async phone => ({ phone: phone || "13800138000", password: phone === "13900139000" ? "second-password" : "first-password", remember: true }),
  });
  await h.select("13900139000");
  assert.equal(h.form().elements.username.value, "13900139000");
  assert.equal(h.form().elements.password.value, "second-password");
  await h.submit();
  assert.equal(h.calls[0][1].username, "13900139000");
  assert.equal(h.calls[0][1].password, "second-password");
  await h.select("");
  assert.equal(h.form().elements.username.value, "");
  assert.equal(h.form().elements.password.value, "");
});

test("editing the phone clears the previous account password and a late account selection cannot overwrite typing", async () => {
  let resolve;
  const h = await harness("signed_out", {
    list: async () => ({ items: [{ phone: "13800138000" }, { phone: "13900139000" }] }),
    get: async phone => phone ? new Promise(done => { resolve = done; }) : { phone: "13800138000", password: "first-password", remember: true },
  });
  h.input("username", "13700137000");
  assert.equal(h.form().elements.password.value, "");
  assert.equal(h.form().elements.savedLogin.value, "");
  const pending = h.select("13900139000");
  h.input("password", "manually-entered");
  resolve({ phone: "13900139000", password: "late-password", remember: true });
  await pending;
  assert.equal(h.form().elements.password.value, "manually-entered");
});

test("a later saved-account selection wins even if password responses arrive out of order", async () => {
  const pending = new Map();
  const h = await harness("signed_out", {
    list: async () => ({ items: [{ phone: "13800138000" }, { phone: "13900139000" }] }),
    get: async phone => phone ? new Promise(done => pending.set(phone, done)) : { remember: true },
  });
  const first = h.select("13800138000"), second = h.select("13900139000");
  pending.get("13900139000")({ phone: "13900139000", password: "second-password", remember: true });
  await second;
  pending.get("13800138000")({ phone: "13800138000", password: "first-password", remember: true });
  await first;
  assert.equal(h.form().elements.username.value, "13900139000");
  assert.equal(h.form().elements.password.value, "second-password");
});

test("forgetting a selected account prevents a delayed password read from enabling remember again", async () => {
  let resolve;
  const h = await harness("signed_out", {
    list: async () => ({ items: [{ phone: "13800138000" }] }),
    get: async phone => phone ? new Promise(done => { resolve = done; }) : { remember: true },
  });
  const pending = h.select("13800138000");
  await h.forget();
  resolve({ phone: "13800138000", password: "forgotten-password", remember: true });
  await pending;
  assert.equal(h.form().elements.remember.checked, false);
  assert.equal(h.form().elements.password.value, "");
  assert.equal(h.calls[0][0], "auth.forget-login");
  assert.equal(h.calls[0][1].phone, "13800138000");
});

test("native form submission during account restoration cannot start another login", async () => {
  const h = await harness("authenticating");
  await h.submit();
  assert.deepEqual(h.calls, []);
});

test("retained login form stays disabled while restoring and permits retry after restoration fails", async () => {
  const h = await harness("signed_out"), original = h.form();
  assert.equal(h.submitButton().disabled, false);
  h.publish("authenticating");
  assert.equal(h.form(), original);
  assert.equal(h.submitButton().disabled, true);
  assert.match(h.submitButton().textContent, /正在登录|正在恢复/);
  h.publish("authenticating");
  assert.equal(h.form(), original);
  assert.equal(h.submitButton().disabled, true);
  await h.submit();
  assert.deepEqual(h.calls, []);
  h.publish("signed_out");
  assert.equal(h.form(), original);
  assert.equal(h.submitButton().disabled, false);
  assert.equal(h.submitButton().textContent, "登录并进入");
  await h.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [["auth.login", {
    username: "13800138000", password: "password", remember: true,
  }]]);
});

for (const [reason, message] of [
  ["AUTH_CLIENT_REPLACED", "账号已在其他客户端登录，当前客户端已下线，请重新登录。"],
  ["AUTH_CLIENT_RETIRED", "账号保留的客户端数量已达上限，当前客户端已下线，请重新登录。"],
  ["AUTH_CLIENT_REAUTH_REQUIRED", "当前在线状态需要重新验证，请重新登录。"],
]) test(`${reason} is shown on restored and live signed-out UI without erasing input`, async () => {
  const h = await harness("signed_out", { reason });
  assert.equal(h.form().querySelector('[data-auth-notice]').textContent, message);
  assert.equal(h.form().querySelector('[data-auth-notice]').hidden, false);
  const original = h.form();
  original.elements.username.value = "13900139000";
  h.publish("signed_out", reason);
  assert.equal(h.form(), original);
  assert.equal(h.form().elements.username.value, "13900139000");
  assert.equal(h.form().querySelector('[data-auth-notice]').textContent, message);
  h.publish("signed_out", null);
  assert.equal(h.form().querySelector('[data-auth-notice]').textContent, "");
  assert.deepEqual(h.calls, []);
});

test("unknown signed-out reasons do not become forced-session notices", async () => {
  for (const reason of ["toString", "untrusted-server-text"]) {
    const h = await harness("signed_out", { reason });
    assert.equal(h.form().querySelector('[data-auth-notice]').textContent, "");
    assert.equal(h.form().querySelector('[data-auth-notice]').hidden, true);
  }
});
