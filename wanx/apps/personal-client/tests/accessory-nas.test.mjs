import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isAttachedVolume, nasRequest, spaceVolumeRequest } from "../shell/accessory-nas.mjs";

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
    assert.deepEqual(await nasRequest(f.context, "volume-status", {}), { configured:false, volumes:[], waiting:[] });
    assert.equal(f.subscriptions(), 0);
  }
  await assert.rejects(spaceVolumeRequest(f.context, { op: "folder", volume: "usb-a" }), /当前账号和盒子还没有接入授权目录/);
  assert.equal(f.subscriptions(), 0);
});

test("the storage accessory cannot list or write Space folders", () => {
  for (const operation of ["folders", "space", "system-storage"]) {
    assert.throws(() => nasRequest({}, operation, {}), /无效的硬盘操作/);
  }
});

test("the accessory worker gives storage windows only their own API", async t => {
  const f = await fixture(t);
  const viewKey = "test-storage-view";
  const worker = fork(new URL("../resources/accessory-preview/server.mjs", import.meta.url), {
    silent:true,
    env:{PATH:process.env.PATH, PORT:"0", RECORDING_MODULE_PROFILE:"accessories",
      RECORDING_VIEW_KEY:viewKey, RECORDING_ACCESSORY_DATA:f.context.app.getPath()},
  });
  t.after(async () => {
    if (worker.exitCode === null) {
      const exited = once(worker, "exit");
      worker.kill();
      await exited;
    }
  });
  const [line] = await once(worker.stdout, "data", {signal:AbortSignal.timeout(5000)});
  const base = line.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base);
  const headers = {"x-recording-view":viewKey, "x-recording-agent":"storage", "content-type":"application/json"};
  const blocked = await fetch(base + "/api/space", {headers});
  assert.equal(blocked.status, 403);
  worker.on("message", message => {
    if (message.type === "nas-request") worker.send({type:"nas-result", id:message.id, result:{configured:true}});
  });
  const allowed = await fetch(base + "/api/nas/volume-status", {method:"POST", headers, body:"{}"});
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), {configured:true});
  const recording = await fetch(base + "/api/space", {headers:{...headers, "x-recording-agent":"disk"}});
  assert.equal(recording.status, 200);
});

test("the manager names an attached volume for Space using the current user's configuration", async t => {
  const f = await fixture(t);
  const volume = {id:"id@8-1", uuid:"id", name:"硬盘", filesystem:"ntfs", size:1000, free:400, readOnly:false};
  const waiting = [{name:"另一块硬盘", size:1000}];
  const server = createServer((req, res) => {
    assert.equal(req.url, "/space/volumes");
    assert.equal(req.headers.authorization, "Bearer " + "b".repeat(48));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({volumes:[volume], waiting}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await f.save({ ...f.config, port:server.address().port, spaceReadToken:"b".repeat(48) });
  const read = () => nasRequest(f.context, "volume-status", {});
  const rename = (id, name) => nasRequest(f.context, "volume-name", {volume:id, name});
  assert.deepEqual((await read()).waiting, waiting);
  await assert.rejects(rename("other", "工作硬盘"), /在线硬盘/);
  await assert.rejects(rename(volume.id, "坏\u202e名字"), /在线硬盘/);
  assert.deepEqual(await rename(volume.id, " 工作硬盘 "), {ok:true});
  assert.deepEqual((await read()).volumes, [{
    id:volume.id, name:"工作硬盘", label:"硬盘", filesystem:"ntfs", size:1000, free:400, readOnly:false, canRename:true,
  }]);
  volume.id = "id@8-3";
  assert.deepEqual(await spaceVolumeRequest(f.context, {op:"volumes"}), [{id:volume.id, name:"工作硬盘"}]);
  assert.equal(await isAttachedVolume(f.context, "personal"), false);
  assert.equal(await isAttachedVolume(f.context, "missing@8-2"), false);
  assert.equal(await isAttachedVolume(f.context, volume.id), true);
  await rename(volume.id, "");
  assert.equal((await read()).volumes[0].name, "硬盘");
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
