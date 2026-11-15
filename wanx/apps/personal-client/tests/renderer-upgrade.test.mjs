import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { assertApplicationCompatibility } from "../applications/compatibility.mjs";

const source = (await Promise.all(["discovery-selection.js", "wallet.bundle.js", "personal-space.js", "app-media.js", "store-carousel.js", "support.js", "data-view.js", "studio-product.js", "workshop.js", "renderer.js"].map(name => readFile(new URL(`../local-ui/renderer/${name}`, import.meta.url), "utf8")))).join("\n");
const client = { current: { productVersion: "0.1.4", buildId: "dev-abc123", distributionClass: "development", platform: "darwin", arch: "arm64" }, phase: "development" };
const release = { payload: { releaseId: "box-v2", version: "2.0.0", releaseNotes: "修复稳定性" } };
const plan = { planId: "plan-1", deviceId: "box-1", releaseId: "box-v2", release, planDigest: "a".repeat(64), expiresAt: new Date(Date.now() + 600000).toISOString(), impact: { serviceInterruption: true, dataMigration: false }, dataPolicy: "backward-compatible" };
function state(box = {}) {
  return { route: "applications", phase: "ready", account: { accountId: "account-1" }, activeDeviceId: "box-1", devices: [{ deviceId: "box-1", displayName: "我的盒子" }, { deviceId: "box-2", displayName: "第二台盒子" }], network: { enabled: true, phase: "ready" }, applications: [], upgrades: { client, box: { deviceId: "box-1", canUpgrade: true, phase: "unknown", ...box } } };
}
async function harness(initial = state(), onAction = async () => {}, timers = null) {
  let current = structuredClone(initial), listener, navigate;
  const events = new Map(), calls = [];
  const app = { innerHTML: "", querySelector: () => null, addEventListener: (name, fn) => events.set(name, fn) };
  const window = { wanxClient: {
    getLocalState: async () => current, onLocalState: fn => { listener = fn; }, onNavigate: fn => { navigate = fn; },
    action: async (action, input) => {
      calls.push({ action, input: structuredClone(input) });
      const override = await onAction(action, input, current);
      if (override) return override;
      return { ok: true, value: action === "market.list" ? { items: [] } : undefined, state: structuredClone(current) };
    },
  } };
  vm.runInNewContext(source, { window, document: { body:{dataset:{},append(){}},createElement:()=>({dataset:{},setAttribute(){}}),addEventListener() {}, querySelector: selector => selector === "#app" ? app : null }, Date, TextEncoder,
    setTimeout: timers ? (callback, delay) => { if (delay !== 5000) return setTimeout(callback, delay); const id = Symbol(); timers.set(id, callback); return id; } : setTimeout,
    clearTimeout: timers ? id => { if (typeof id === "symbol") timers.delete(id); else clearTimeout(id); } : clearTimeout,
    setInterval: () => null, clearInterval: () => {}, queueMicrotask,
  });
  await new Promise(resolve => setImmediate(resolve));
  const click = (action, data = {}) => events.get("click")({ target: { closest: () => ({ dataset: { action, ...data } }) } });
  await click("show-settings");
  return { app, calls, click, navigate: value => navigate(value), key: value => events.get("keydown")({ key: value }), update(next) { current = structuredClone(next); listener(current); } };
}

test("settings retain client build identity without exposing box versions", async () => {
  const h = await harness();
  assert.match(h.app.innerHTML, /记忆盒子.*v0\.1\.4/);
  assert.match(h.app.innerHTML, /dev-abc123/);
  assert.doesNotMatch(h.app.innerHTML, /版本待核验|盒端版本|data-detail-id="updates-box"|data-action="updates-box-|已是.*最新|data-action="updates-client-install"/);
});


for (const phase of ["blocked", "up_to_date"]) {
  test(`client ${phase} without an available release clearly reports the latest version`, async () => {
    const initial = state();
    initial.upgrades.client = { ...client, phase, reason: phase === "blocked" ? "RELEASE_UNAVAILABLE" : null };
    const h = await harness(initial);
    assert.match(h.app.innerHTML, /当前已是最新版本/);
    assert.match(h.app.innerHTML, /data-action="updates-client-check"/);
    assert.doesNotMatch(h.app.innerHTML, /RELEASE_UNAVAILABLE|此更新暂不可用|暂时没有适用更新|data-action="updates-client-(?:download|install)"/);
  });
}

test("a missing release does not hide a required client update or another blocker", async () => {
  for (const gate of [{ requirement: { required: true, minimumVersion: "2.0.0" } }, { blockers: ["UPDATE_EDITION_MISMATCH"] }]) {
    const initial = state();
    initial.upgrades.client = { ...client, phase: "blocked", reason: "RELEASE_UNAVAILABLE", ...gate };
    const h = await harness(initial);
    assert.doesNotMatch(h.app.innerHTML, /当前已是最新版本/);
    assert.match(h.app.innerHTML, /此更新暂不可用/);
    assert.match(h.app.innerHTML, gate.requirement ? /需要更新记忆盒子至/ : /UPDATE_EDITION_MISMATCH/);
  }
});

test("client OTA conflicts identify the affected application and give interface guidance", async () => {
  const initial = state();
  initial.upgrades.client = { ...client, phase: "blocked", reason: "DEPENDENCY_CONFLICT", blockers: [{
    code: "DEPENDENCY_CONFLICT", applicationId: "example.application", applicationName: "测试应用",
    version: "2.3.4", reasonCode: "HOST_PROTOCOL_INCOMPATIBLE", message: "private-server-detail",
  }] };
  const h = await harness(initial);
  assert.match(h.app.innerHTML, /测试应用（example\.application）/);
  assert.match(h.app.innerHTML, /已安装版本 2\.3\.4/);
  assert.match(h.app.innerHTML, /应用接口不兼容/);
  assert.match(h.app.innerHTML, /请先安装兼容的应用版本，再检查记忆盒子更新/);
  assert.doesNotMatch(h.app.innerHTML, /private-server-detail|data-action="updates-client-(?:download|install)"/);
});

test("client OTA unknown application metadata gives specific, escaped guidance", async () => {
  const initial = state();
  initial.upgrades.client = { ...client, phase: "blocked", blockers: [{
    code: "DEPENDENCY_CONFLICT", applicationId: "example.application", applicationName: '<img src=x onerror="alert(1)">',
    version: "1.0.0", reasonCode: "APPLICATION_CONTRACT_UNSUPPORTED", message: "private-server-detail",
  }] };
  const h = await harness(initial);
  assert.match(h.app.innerHTML, /无法核验应用/);
  assert.match(h.app.innerHTML, /example\.application/);
  assert.match(h.app.innerHTML, /已安装版本 1\.0\.0/);
  assert.match(h.app.innerHTML, /请先更新或重新安装此应用，再检查记忆盒子更新/);
  assert.match(h.app.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(h.app.innerHTML, /<img src=x|private-server-detail/);
});

test("legacy or unknown application OTA conflicts retain local generic guidance", async () => {
  for (const patch of [{}, { reasonCode: "UNRECOGNIZED_COMPATIBILITY_RULE" }, { applicationId: "../../invalid", reasonCode: "HOST_PROTOCOL_INCOMPATIBLE" }]) {
    const initial = state();
    initial.upgrades.client = { ...client, phase: "blocked", blockers: [{ code: "DEPENDENCY_CONFLICT",
      applicationId: "example.application", version: "1.0.0", message: "private-server-detail", ...patch }] };
    const h = await harness(initial);
    assert.match(h.app.innerHTML, /当前应用与目标版本不兼容，请保留现有版本并等待兼容更新/);
    assert.doesNotMatch(h.app.innerHTML, /private-server-detail/);
  }
});

test("settings and boxes hide box versions and security management without reading box updates", async () => {
  for (const profileId of [undefined, "local-profile"]) {
    const initial = state({ phase: "executing", reason: "CONTRACT_UNSUPPORTED",
      inventory: { observedAt: new Date().toISOString(), updaterVersion: "box-updater-build", components: {
        wanx: { installedVersion: "box-running-build", runningVersion: "box-running-build", evidenceStatus: "verified", health: "healthy" },
      } },
      currentRelease: { version: "9.8.7", components: ["wanx"] },
      candidate: { status: "available", release },
      operation: { operationId: "box-update-task", state: "downloading", allowedActions: ["status", "cancel"] },
    });
    initial.dataIdentity = { profileId, phase: "unlocked" };
    const timers = new Map();
    const h = await harness(initial, async () => {}, timers);
    for (const action of ["show-settings", "show-boxes", "show-profile", "show-settings"]) {
      await h.click(action);
      assert.doesNotMatch(h.app.innerHTML, /box-version-summary|盒端记忆盒子|盒端版本|box-running-build|box-updater-build|box-update-task|data-detail-id="updates-box"|data-action="(?:updates-box-|show-box-version|device-trust-open)|管理可信设备|打开安全管理|aria-label="本地设备安全"/);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.size, 0, "retired box update surfaces must not schedule polling");
    assert.equal(h.calls.some(call => /^updates\.box\.(?:check|status)$/.test(call.action)), false);
  }
});

for (const [phase, code, guidance] of [
  ["development", "UPDATE_DEVELOPMENT_BUILD", /这是开发构建，请使用正式发行包/],
  ["unavailable", "UPDATE_NOT_CONFIGURED", /当前未配置正式更新/],
  ["unavailable", "UPDATE_INSTALL_LOCATION_UNSUPPORTED", /当前安装位置不支持应用内更新/],
  ["idle", "ACCOUNT_LOGIN_REQUIRED", /请先登录云账号，再检查更新/],
  ["blocked", "UPDATE_EDITION_MISMATCH", /此更新包与当前客户端版本类型不一致/],
]) {
  test(`client update check remains actionable in ${phase} (${code}) and explains its local gate`, async () => {
    const initial = state();
    initial.account.phase = "authenticated";
    initial.upgrades.client = { ...client, current: { ...client.current, channel: "stable-studio" }, phase, reason: code };
    const h = await harness(initial, async action => action === "updates.client.check" ? { ok: false, code } : undefined);
    const button = h.app.innerHTML.match(/<button[^>]*data-action="updates-client-check"[^>]*>[^<]*<\/button>/)?.[0];
    assert.ok(button, "version settings must offer a client update check");
    assert.doesNotMatch(button, /disabled/);
    await h.click("updates-client-check");
    assert.equal(h.calls.filter(call => call.action === "updates.client.check").length, 1);
    assert.match(h.app.innerHTML, guidance);
    assert.doesNotMatch(h.app.innerHTML, /data-action="updates-client-(?:download|install)"|最近检查未发现适用更新/);
  });
}

test("client restart installation requires confirmation and an unchanged downloaded release", async () => {
  const initial = state();
  initial.upgrades.client = { ...client, phase: "downloaded", candidate: { releaseId: "client-v2", productVersion: "2.0.0", requiresRestart: true } };
  const h = await harness(initial);
  await h.click("updates-client-install");
  assert.match(h.app.innerHTML, /role="alertdialog"/);
  assert.equal(h.calls.filter(call => call.action === "updates.client.install").length, 0);
  await h.click("market-confirm");
  assert.deepEqual(h.calls.find(call => call.action === "updates.client.install").input, { confirmed: true });
  await h.click("updates-client-install");
  h.update({ ...initial, upgrades: { ...initial.upgrades, client: { ...initial.upgrades.client, candidate: { releaseId: "client-v3", productVersion: "3.0.0" } } } });
  assert.doesNotMatch(h.app.innerHTML, /role="alertdialog"/);
  await h.click("market-confirm");
  assert.equal(h.calls.filter(call => call.action === "updates.client.install").length, 1);
});

test("download progress uses actual bytes and an unknown total remains indeterminate", async () => {
  const initial = state();
  initial.upgrades.client = { ...client, phase: "downloading", progress: { transferred: 1024, total: null } };
  const h = await harness(initial);
  assert.match(h.app.innerHTML, /1 KB · 总大小待确认/);
  assert.doesNotMatch(h.app.innerHTML, /progress aria-label="客户端下载进度" max=/);
});

test("box preflight does not execute before confirmation and switching boxes discards its plan", async () => {
  const initial = state({ phase: "available", candidate: { status: "available", release } });
  const h = await harness(initial, async (action, input, current) => {
    if (action === "updates.box.plan") current.upgrades.box = { ...current.upgrades.box, phase: "planned", plan };
  });
  await h.click("updates-box-plan");
  assert.match(h.app.innerHTML, /确认更新盒子/);
  assert.equal(h.calls.filter(call => call.action === "updates.box.execute").length, 0);
  h.update({ ...initial, activeDeviceId: "box-2" });
  assert.doesNotMatch(h.app.innerHTML, /role="alertdialog"/);
  await h.click("market-confirm");
  assert.equal(h.calls.filter(call => call.action === "updates.box.execute").length, 0);
  assert.doesNotMatch(h.app.innerHTML, /data-action="updates-box-plan"/);
});

test("box confirmation dispatches only the fixed plan and selected device", async () => {
  const h = await harness(state({ phase: "available", candidate: { status: "available", release } }), async (action, input, current) => {
    if (action === "updates.box.plan") current.upgrades.box = { ...current.upgrades.box, phase: "planned", plan };
  });
  await h.click("updates-box-plan");
  await h.click("market-confirm");
  assert.deepEqual(h.calls.find(call => call.action === "updates.box.execute").input, { deviceId: "box-1", planId: "plan-1", confirmed: true });
});

test("retired box update controls stay hidden and members cannot dispatch privileged updates", async () => {
  const h = await harness(state({ canUpgrade: false, phase: "available", candidate: { status: "available", release }, operation: { operationId: "op-1", state: "failed", allowedActions: ["resume", "cancel"] } }));
  assert.doesNotMatch(h.app.innerHTML, /data-detail-id="updates-box"/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="updates-box-(?:plan|resume|cancel)"/);
  for (const action of ["updates-box-plan", "updates-box-resume", "updates-box-cancel"]) await h.click(action);
  assert.equal(h.calls.some(call => /^updates\.box\.(?:plan|resume|cancel|execute)$/.test(call.action)), false);
});

test("application compatibility errors distinguish client mismatch from box updates", async () => {
  for (const [code, message] of [["CLIENT_VERSION_INCOMPATIBLE", /与当前记忆盒子版本不兼容.*检查记忆盒子和应用更新/], ["BACKEND_CONTRACT_INCOMPATIBLE", /联系盒主更新/]]) {
    const initial = state();
    initial.applications = [{ applicationId: "app-1", name: "测试应用", version: "1.0.0" }];
    const h = await harness(initial, action => { if (action === "applications.request-open") throw new Error(code); });
    await h.click("show-applications");
    await h.click("applications-tab", { tab: "local" });
    await h.click("applications-launch", { applicationId: "app-1" });
    assert.match(h.app.innerHTML, message);
    assert.doesNotMatch(h.app.innerHTML, /暂时无法完成应用市场操作/);
  }
});

test("opening an app above its old client upper bound shows success", async () => {
  const manifest = { protocolVersion: 2, compatibility: {
    backendProductId: "wanx", clientRange: ">=0.1.4 <1.0.0", hostProtocolRange: ">=1.0.0 <2.0.0",
    backendContracts: [], requiredExperts: [], localDataSchema: { readRange: ">=1.0.0 <2.0.0", writeVersion: "1.0.0" },
  } };
  const initial = state();
  initial.upgrades.client = { ...client, current: { ...client.current, productVersion: "1.0.1" } };
  initial.applications = [{ applicationId: "app-1", name: "测试应用", version: "0.1.0" }];
  const h = await harness(initial, async action => {
    if (action === "applications.request-open") await assertApplicationCompatibility(manifest, {
      getCompatibilityContext: () => ({ clientVersion: "1.0.1", hostProtocol: 1 }), phase: "import",
    });
  });
  await h.click("show-applications");
  await h.click("applications-tab", { tab: "local" });
  await h.click("applications-launch", { applicationId: "app-1" });
  assert.match(h.app.innerHTML, /已打开/);
  assert.doesNotMatch(h.app.innerHTML, /与当前记忆盒子版本不兼容|暂时无法完成应用市场操作|请先在设置中更新记忆盒子|请先升级记忆盒子/);
});

for (const reason of ["client_version", "CLIENT_VERSION_INCOMPATIBLE"]) {
  test(`client incompatibility candidate ${reason} gives neutral compatibility guidance`, async () => {
    const h = await harness(state(), action => action === "market.list" ? { ok: true, value: { items: [{ applicationId: "app-1", name: "测试应用" }] } }
      : action === "market.candidate" ? { ok: true, value: { status: "incompatible", reason } } : undefined);
    await h.click("show-applications");
    assert.match(h.app.innerHTML, /与当前记忆盒子版本不兼容.*检查记忆盒子和应用更新/);
    assert.match(h.app.innerHTML, /联系管理员确认适配版本/);
    assert.doesNotMatch(h.app.innerHTML, /请先在设置中更新记忆盒子|请先升级记忆盒子|data-action="market-install"/);
  });
}

test("unknown assistant, authorization and data compatibility keep existing content with a useful next step", async () => {
  for (const [code, message] of [["EXPERT_VERSION_UNKNOWN", /现有内容已保留/], ["APP_AUTHORIZATION_UNVERIFIED", /重新登录后重试/], ["APPLICATION_DATA_COMPATIBILITY_UNKNOWN", /保留当前数据.*不要删除数据/]]) {
    const initial = state();
    initial.applications = [{ applicationId: "app-1", name: "测试应用", version: "1.0.0" }];
    const h = await harness(initial, action => { if (action === "applications.request-open") throw new Error(code); });
    await h.click("show-applications");
    await h.click("applications-tab", { tab: "local" });
    await h.click("applications-launch", { applicationId: "app-1" });
    assert.match(h.app.innerHTML, message);
    assert.doesNotMatch(h.app.innerHTML, /暂时无法完成应用市场操作/);
  }
});

test("market dependency reasons explain preparation without offering an incompatible install", async () => {
  for (const [reason, message] of [["backend_contract", /联系盒主更新/], ["backend_evidence_stale", /连接盒子并刷新/], ["expert_not_ready", /联系盒主完成准备/], ["expert_version_unknown", /现有内容已保留/]]) {
    const h = await harness(state(), action => action === "market.list" ? { ok: true, value: { items: [{ applicationId: "app-1", name: "测试应用" }] } } : action === "market.candidate" ? { ok: true, value: { status: "incompatible", reason } } : undefined);
    await h.click("show-applications");
    assert.match(h.app.innerHTML, message);
    assert.doesNotMatch(h.app.innerHTML, /data-action="market-install"/);
  }
});


function requiredClientState(phase = "available") {
  const value = state();
  value.account.phase = "authenticated";
  value.upgrades.client = {
    ...client, current: { ...client.current, distributionClass: "formal", productVersion: "1.0.0" }, phase,
    requirement: { required: true, minimumVersion: "2.0.0", releaseId: "client-required-v2" },
    candidate: { releaseId: "client-v2", productVersion: "2.0.0", requiresRestart: true },
  };
  return value;
}

test("required client update blocks business navigation while retaining settings and diagnostics", async () => {
  const h = await harness(requiredClientState());
  assert.match(h.app.innerHTML, /<h2>设置<\/h2>/);
  assert.match(h.app.innerHTML, /需要更新记忆盒子至 v2\.0\.0/);
  await h.click("show-applications");
  assert.match(h.app.innerHTML, /<h2>需要更新记忆盒子<\/h2>/);
  assert.match(h.app.innerHTML, /data-action="updates-client-download"/);
  assert.match(h.app.innerHTML, /已打开的应用不会被强制关闭/);
  for (const action of ["show-ai-dialogue", "show-space", "applications-launch", "notifications-open", "pending-confirm"]) {
    await h.click(action, { applicationId: "example.app", id: "message-1" });
    assert.match(h.app.innerHTML, /<h2>需要更新记忆盒子<\/h2>/);
  }
  assert.equal(h.calls.some(call => ["applications.request-open", "applications.confirm-open", "notifications.open"].includes(call.action)), false);
  h.navigate("ai-dialogue");
  assert.match(h.app.innerHTML, /<h2>需要更新记忆盒子<\/h2>/);
  await h.click("show-settings");
  assert.match(h.app.innerHTML, /<h2>设置<\/h2>/);
  await h.click("show-boxes");
  assert.match(h.app.innerHTML, /<h2>我的设备 <span/);
  assert.match(h.app.innerHTML, /data-action="show-client-update"/);
  await h.click("show-client-update");
  assert.match(h.app.innerHTML, /data-action="desktop-quit"/);
  await h.click("desktop-quit");
  assert.equal(h.calls.some(call => call.action === "desktop.quit"), true);
});

test("cancelling required installation never dismisses the requirement or installs automatically", async () => {
  const h = await harness(requiredClientState("downloaded"));
  await h.click("show-applications");
  assert.equal(h.calls.some(call => call.action === "updates.client.install"), false);
  await h.click("updates-client-install");
  assert.match(h.app.innerHTML, /role="alertdialog"/);
  await h.click("market-cancel");
  assert.doesNotMatch(h.app.innerHTML, /role="alertdialog"/);
  assert.match(h.app.innerHTML, /<h2>需要更新记忆盒子<\/h2>/);
  await h.click("updates-client-install");
  await h.key("Escape");
  assert.doesNotMatch(h.app.innerHTML, /role="alertdialog"/);
  assert.match(h.app.innerHTML, /<h2>需要更新记忆盒子<\/h2>/);
  assert.equal(h.calls.some(call => call.action === "updates.client.install"), false);
  await h.click("updates-client-install");
  await h.click("market-confirm");
  assert.deepEqual(h.calls.find(call => call.action === "updates.client.install").input, { confirmed: true });
});

test("failed checks keep required update recovery actions and clearing the requirement restores navigation", async () => {
  const initial = requiredClientState("failed");
  initial.upgrades.client.candidate = null;
  initial.upgrades.client.reason = "UPDATE_REQUEST_FAILED";
  const h = await harness(initial);
  await h.click("show-applications");
  assert.match(h.app.innerHTML, /<h2>需要更新记忆盒子<\/h2>/);
  assert.match(h.app.innerHTML, /暂时无法连接更新服务/);
  assert.match(h.app.innerHTML, /data-action="updates-client-check"/);
  assert.match(h.app.innerHTML, /data-action="show-boxes"/);
  await h.click("updates-client-check");
  assert.equal(h.calls.filter(call => call.action === "updates.client.check").length, 1);
  assert.equal(h.calls.some(call => call.action === "updates.client.download"), false);
  h.update({ ...initial, upgrades: { ...initial.upgrades, client: { ...initial.upgrades.client, requirement: null, phase: "up_to_date", reason: null } } });
  assert.doesNotMatch(h.app.innerHTML, /<h2>需要更新记忆盒子<\/h2>|data-action="show-client-update"/);
  assert.match(h.app.innerHTML, /<h2>AI 应用 <span/);
});

test("required update preserves account login and reappears after signing in", async () => {
  const initial = requiredClientState();
  const signedOut = { ...initial, route: "auth", phase: "signed_out", account: { phase: "signed_out" } };
  const h = await harness(initial, async action => action === "auth.logout" ? { ok: true, state: signedOut } : undefined);
  await h.click("show-client-update");
  await h.click("logout");
  assert.match(h.app.innerHTML, /data-form="auth"/);
  assert.doesNotMatch(h.app.innerHTML, /<h2>需要更新记忆盒子<\/h2>/);
  h.update(initial);
  assert.match(h.app.innerHTML, /<h2>需要更新记忆盒子<\/h2>/);
});

test("My Apps offers addable applications and gives an added app one installed card", async () => {
  const operations = [];
  const officeId = "centaurai.wanx.template.office-assistant";
  const office = {
    applicationId: officeId, name: "小办·办公专家", description: "专家旧描述",
    entrypoint: "local-expert.cjs", installationSource: "local", version: "0.1.1",
  };
  const logo = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>').toString("base64");
  const h = await harness(state(), async (action, input, current) => {
    if (action !== "expert-apps") return;
    operations.push(structuredClone(input));
    if (input.action === "catalog") {
      return { ok: true, value: {
        mode: "local-development", installed: current.applications.some(app => app.applicationId === officeId) ? ["office"] : [],
        pilots: [{ id: "office", name: "小办·办公专家", logo }, { id: "ai-crm", name: "AI CRM", logo: "https://example.invalid/remote-logo.svg" }],
        experts: [{ id: "role", name: "参谋 <img src=x>", description: "协作角色" }],
      } };
    }
    if (input.action === "install") {
      current.applications = [office];
      return { ok: true, value: { applicationId: officeId, installed: true }, state: structuredClone(current) };
    }
    return { ok: true, value: { opened: true } };
  });

  await h.click("show-applications");
  await h.click("applications-tab", { tab: "local" });
  await new Promise(resolve => setImmediate(resolve));
  const tabs = [...h.app.innerHTML.matchAll(/data-action="applications-tab" data-tab="([^"]+)"[^>]*>([^<]+)<\/button>/g)];
  assert.deepEqual(tabs.map(([, id, label]) => [id, label]), [
    ["wanx", "应用市场"], ["local", "我的应用"], ["workshop", "应用工坊"],
  ]);
  assert.match(h.app.innerHTML, /id="applications-panel-local"/);
  assert.match(h.app.innerHTML, /aria-label="可添加的应用"/);
  assert.match(h.app.innerHTML, /小办/);
  assert.match(h.app.innerHTML, /AI CRM/);
  assert.match(h.app.innerHTML, /本机预览/);
  assert.match(h.app.innerHTML, /会议纪要/);
  assert.match(h.app.innerHTML, /客户跟进/);
  assert.ok(h.app.innerHTML.includes(logo));
  assert.doesNotMatch(h.app.innerHTML, /专家|参谋|<img src=x>|remote-logo\.svg/);
  assert.match(h.app.innerHTML, /工坊演示/);

  await h.click("expert-app-install", { id: "office" });
  assert.equal(h.app.innerHTML.split(`data-application="${officeId}"`).length - 1, 1);
  assert.doesNotMatch(h.app.innerHTML, /data-expert-app="office"/);
  assert.match(h.app.innerHTML, /data-action="applications-launch" data-application-id="centaurai\.wanx\.template\.office-assistant"/);
  await h.click("applications-launch", { applicationId: officeId });
  assert.ok(h.calls.some(call => call.action === "applications.request-open" && call.input.applicationId === officeId));
  await h.click("expert-app-workshop", { id: "ai-crm" });
  assert.match(h.app.innerHTML, /aria-label="可添加的应用"/);
  assert.deepEqual(operations.filter(input => input.action !== "catalog").map(input => input.action), ["install", "workshop"]);

  assert.match(h.app.innerHTML, /我的应用/);
  assert.match(h.app.innerHTML, /工坊演示/);
  assert.doesNotMatch(h.app.innerHTML, /专家|可定制|用工坊修改/);
  await h.click("store-details", { applicationId: officeId });
  assert.match(h.app.innerHTML, /class="app-detail-section featured-detail"/);
  assert.match(h.app.innerHTML, /成果示例/);
  await h.click("expert-installed-workshop", { applicationId: officeId });
  assert.deepEqual(operations.at(-1), { action: "workshop-installed", input: { applicationId: officeId } });
});

test("an unavailable addable catalog leaves existing applications available in My Apps", async () => {
  const installed = { applicationId: "local.example", name: "已安装测试应用", installationSource: "local", version: "1.0.0" };
  const h = await harness({ ...state(), applications: [installed] }, async action => action === "expert-apps"
    ? { ok: true, value: { mode: "unavailable", pilots: [], installed: [] } }
    : undefined);
  await h.click("show-applications");
  await h.click("applications-tab", { tab: "local" });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.app.innerHTML, /已安装测试应用/);
  assert.doesNotMatch(h.app.innerHTML, /data-tab="experts"|data-action="expert-app-install"/);
});

test("My Apps keeps installed application actions when the client has no addable catalog", async () => {
  const applicationId = "centaurai.wanx.template.office-assistant";
  const installed = {
    applicationId, name: "已有本地应用", entrypoint: "local-expert.cjs",
    installationSource: "local", version: "1.0.0", previous: "0.9.0",
  };
  const h = await harness({ ...state(), applications: [installed] }, async action => action === "expert-apps"
    ? { ok: false, code: "UNKNOWN_CLIENT_ACTION" }
    : undefined);
  await h.click("show-applications");
  await h.click("applications-tab", { tab: "local" });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.app.innerHTML, /已有本地应用/);
  assert.doesNotMatch(h.app.innerHTML, /可添加的应用|工坊演示|data-action="expert-app/);
  assert.match(h.app.innerHTML, /data-action="applications-launch"/);
  assert.match(h.app.innerHTML, /data-action="local-uninstall"/);
  assert.match(h.app.innerHTML, /data-action="local-rollback"/);
  await h.click("applications-launch", { applicationId });
  assert.ok(h.calls.some(call => call.action === "applications.request-open" && call.input.applicationId === applicationId));
  await h.click("store-details", { applicationId });
  assert.match(h.app.innerHTML, /data-application-detail="centaurai\.wanx\.template\.office-assistant"/);
  assert.doesNotMatch(h.app.innerHTML, /工坊演示|featured-detail/);
  await h.click("store-back");
  await h.click("applications-tab", { tab: "wanx" });
  await h.click("applications-tab", { tab: "local" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call.action === "expert-apps").length, 1);
});
