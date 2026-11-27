import test from "node:test";
import assert from "node:assert/strict";
import { createSpaceLinkBridge } from "../build/app/shell/space-links.mjs";

function fixture() {
  let listener, saved, account = "owner", box = "box-a", response;
  const calls = [], copies = [];
  const connection = { id: "a".repeat(32), name: "Test Agent", status: "active",
    drive: { id: "b".repeat(32), root: "c".repeat(32), directories: { memory: "d".repeat(32) } }, grants: [] };
  const client = {
    snapshot: () => ({ phase: "ready", account: { phase: account ? "authenticated" : "signed_out", accountId: account },
      connection: { deviceId: box, url: "http://100.98.0.5:8088/" } }),
    subscribe(fn) { listener = fn; return () => {}; },
    applicationConnection: async () => ({ context() {}, request: async input => {
      calls.push(input);
      const value = response ? await response(input) : input.method === "POST" ? connection : { connections: [connection], archives: [] };
      return { status: 200, body: Buffer.from(JSON.stringify(value)) };
    } }),
  };
  return { client, serviceURL: "https://consumer.test", calls, copies,
    store: { load: async () => saved, save: async v => { saved = structuredClone(v); } },
    copyText: async value => copies.push(value), agentHubOptions: { team: true },
    get saved() { return saved; },
    respond(fn) { response = fn; },
    change(nextAccount = account, nextBox = box) { account = nextAccount; box = nextBox; listener(); },
  };
}

test("owner Space lists and binds paired mounted volumes separately from agent drives", async t => {
  const f = fixture();
  const mounted = { id:"e".repeat(32), root:"f".repeat(32), kind:"volume-space", volume:"test-usb",
    name:"数据盘", storage:{path:"/run/media/user/data",available:true} };
  let approved = false;
  f.respond(async input => {
    if(input.path.endsWith("/spaces")) return [{id:"personal",name:"我的空间"}, ...(approved ? [mounted] : [])];
    if(input.path.endsWith("/spaces/mounted-volume")) {
      const body = JSON.parse(input.body);
      assert.deepEqual(body,{volume:"test-usb",name:"数据盘",mount:"/run/media/user/data"});
      approved = true;
      return mounted;
    }
    assert.fail("personal Space does not request agent drives");
  });
  const bridge = await createSpaceLinkBridge({...f,mountedVolumes:async()=>[
    {id:"test-usb@8-2",volume:"test-usb",name:"数据盘",mount:"/run/media/user/data"},
  ]});
  t.after(() => bridge.close());
  assert.deepEqual((await bridge.manage("spaces",{personalOnly:true})).map(space=>space.id),["personal",mounted.id]);
  await bridge.manage("spaces",{personalOnly:true});
  assert.equal(f.calls.filter(call=>call.path.endsWith("/spaces/mounted-volume")).length,1);
});

test("retired desktop enrollment and bearer links cannot create a local access surface", async t => {
  const f = fixture(), bridge = await createSpaceLinkBridge(f);
  t.after(() => bridge.close());
  for (const action of ["create", "list", "revoke", "agent-config", "requests", "approve", "reject", "grant"])
    await assert.rejects(bridge.manage(action, { root: "b".repeat(32), name: "untrusted" }), /SPACE_ACTION_INVALID/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.saved, undefined);
  assert.equal((await bridge.mcpDetails()).url, "http://100.98.0.5:8088/mcp/space");
  assert.equal((await bridge.mcpDetails("starlink")).url, "http://100.98.0.5:8088/mcp/starlink");
  await assert.rejects(bridge.mcpDetails("other"), /MCP_SURFACE_INVALID/);
});

test("MCP access binds the box drive to a persistent connection and keeps credentials out of renderer state", async t => {
  const f = fixture(), bridge = await createSpaceLinkBridge(f);
  t.after(() => bridge.close());
  const created = await bridge.manage("mcp-issue", { name: "Test Agent" });
  const request = f.calls.at(-1), body = JSON.parse(request.body);
  assert.equal(request.path, "/api/_client/space-mcp/connections");
  assert.equal(body.destination, "company");
  assert.equal(body.name, "Test Agent");
  assert.ok(body.credential);
  assert.equal(body.credential, f.saved.spaceMcp[0].credential);
  assert.ok(!JSON.stringify(created).includes(body.credential));
  const state = await bridge.manage("mcp-state");
  assert.equal(state.connections[0].drive.root, "c".repeat(32));
  assert.ok(!JSON.stringify(state).includes(body.credential));
  await bridge.manage("mcp-copy", { id: "a".repeat(32), kind: "config" });
  const config = JSON.parse(f.copies[0]).mcpServers["wanx-space"];
  assert.equal(config.url, "http://100.98.0.5:8088/mcp/space");
  assert.equal(config.headers.Authorization, "Bearer " + body.credential);
  f.change("other-owner");
  await assert.rejects(bridge.manage("mcp-copy", { id: "a".repeat(32), kind: "key" }), /MCP_KEY_NOT_ON_THIS_CLIENT/);
});

test("account or box switches discard delayed MCP results and logout prevents further access", async t => {
  const f = fixture(), bridge = await createSpaceLinkBridge(f);
  t.after(() => bridge.close());
  for (const switchBox of [false, true]) {
    let release;
    f.respond(() => new Promise(resolve => { release = resolve; }));
    const read = bridge.manage("mcp-state");
    await new Promise(resolve => setImmediate(resolve));
    f.change(switchBox ? "other" : "second", switchBox ? "box-b" : "box-a");
    release({ connections: [{ id: "old-account-secret" }], archives: [] });
    await assert.rejects(read, /SPACE_CONTEXT_CHANGED/);
  }
  const before = f.calls.length;
  f.change(null);
  await assert.rejects(bridge.manage("mcp-state"), /BOX_CONNECTION_REQUIRED/);
  assert.equal(f.calls.length, before);
});


test("NetBird address reset is wired through management and preserves the selected owner's keys", async t => {
  const f = fixture(), snapshot = f.client.snapshot;
  f.client.snapshot = () => { const value = snapshot(); value.connection.mode = "netbird"; return value; };
  const bridge = await createSpaceLinkBridge(f); t.after(() => bridge.close());
  await bridge.manage("mcp-issue", {name: "Test Agent"});
  const key = f.saved.spaceMcp[0].credential;
  const first = (await bridge.manage("mcp-state")).url;
  const starlink = await bridge.mcpDetails("starlink");
  assert.equal(starlink.url, new URL("/mcp/starlink", first).href);
  assert.equal(starlink.localOnly, true);
  assert.equal(starlink.configuration.mcpServers["wanx-starlink"].url, starlink.url);
  const renewed = await bridge.manage("mcp-reset-endpoint");
  assert.notEqual(renewed.url, first);
  assert.equal((await bridge.mcpDetails()).url, renewed.url);
  assert.equal((await bridge.mcpDetails("starlink")).url, new URL("/mcp/starlink", renewed.url).href);
  assert.equal(f.saved.spaceMcp[0].credential, key);
  f.change("other-owner", "box-b");
  const other = (await bridge.manage("mcp-state")).url;
  assert.notEqual(other, renewed.url); assert.notEqual(other, first);
  f.change("owner", "box-a");
  assert.equal((await bridge.manage("mcp-state")).url, renewed.url);
});
