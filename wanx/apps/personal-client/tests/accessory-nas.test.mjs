import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nasRequest, spaceVolumeRequest } from "../shell/accessory-nas.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-nas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { boxId: "box-a", accountId: "account-a", user: { id: 7 }, connection: "ready" };
  const scope = createHash("sha256").update(JSON.stringify([identity.boxId, identity.accountId, undefined])).digest("hex");
  const configFile = path.join(root, "nas-accessory", scope, "connection.json");
  let subscriptions = 0;
  const context = {
    app: { getAppPath: () => root, getPath: () => root },
    client: {
      snapshot: () => ({ phase: "ready" }),
      applicationConnection: () => ({
        context: () => identity,
        subscribe: () => { subscriptions++; return () => { subscriptions--; }; },
      }),
    },
  };
  const config = { box: identity.boxId, user: String(identity.user.id), port: 12345, token: "a".repeat(48) };
  async function save(value = config) {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify(value), { mode: 0o600 });
  }
  return { context, config, configFile, save, subscriptions: () => subscriptions };
}

test("volume polling without an accessory connection returns an empty list and closes each session", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await spaceVolumeRequest(f.context, { op: "volumes" }), []);
    assert.equal(f.subscriptions(), 0);
  }
  await assert.rejects(spaceVolumeRequest(f.context, { op: "folder", volume: "usb-a" }), /当前账号和盒子还没有接入授权目录/);
  assert.equal(f.subscriptions(), 0);
});

test("an accessory connection without space credentials has no browsable volumes", async t => {
  const f = await fixture(t);
  await f.save();
  assert.deepEqual(await spaceVolumeRequest(f.context, { op: "volumes" }), []);
  await assert.rejects(spaceVolumeRequest(f.context, { op: "folder", volume: "usb-a" }), /空间硬盘浏览尚未配置/);
  await assert.rejects(spaceVolumeRequest(f.context, { op: "text-open" }), /SPACE_TEXT_EDIT_UNAVAILABLE/);
  assert.equal(f.subscriptions(), 0);
});

test("configured volumes use their read credential while accessory requests keep their own credential", async t => {
  const f = await fixture(t);
  const volumes = [{ id: "usb-a", name: "测试硬盘" }];
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/space/volumes" ? volumes : { connected: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = { ...f.config, port: server.address().port, spaceReadToken: "b".repeat(48) };
  await f.save(config);
  assert.deepEqual(await spaceVolumeRequest(f.context, { op: "volumes" }), volumes);
  assert.deepEqual(await nasRequest(f.context, "status", {}), { connected: true });
  assert.deepEqual(calls, [
    { path: "/space/volumes", authorization: "Bearer " + config.spaceReadToken },
    { path: "/status", authorization: "Bearer " + config.token },
  ]);
  assert.equal(f.subscriptions(), 0);
});

test("volume polling still rejects mismatched identities, invalid credentials and malformed files", async t => {
  const f = await fixture(t);
  await f.save({ ...f.config, box: "box-b" });
  await assert.rejects(spaceVolumeRequest(f.context, { op: "volumes" }), /设备授权不匹配/);
  await f.save({ ...f.config, spaceReadToken: "short" });
  await assert.rejects(spaceVolumeRequest(f.context, { op: "volumes" }), /空间硬盘浏览尚未配置/);
  await writeFile(f.configFile, "{");
  await assert.rejects(spaceVolumeRequest(f.context, { op: "volumes" }), SyntaxError);
  await rm(f.configFile);
  await mkdir(f.configFile);
  await assert.rejects(spaceVolumeRequest(f.context, { op: "volumes" }), /设备连接配置无效/);
  assert.equal(f.subscriptions(), 0);
});
