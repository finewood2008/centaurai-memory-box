import test from "node:test";
import assert from "node:assert/strict";
import { acceptsMediaGrant, isMediaAsrStream } from "../app-host/media-grant.mjs";

test("only explicit media-service routes receive the grant", () => {
  const base = "/api/services/wanx.media/v1";
  for (const path of ["/capabilities","/asr/sessions","/grant/self","/delegations","/delegations/a1","/jobs","/jobs/a-b_1","/jobs/42/input?offset=42","/jobs/42/result"])
    assert.ok(acceptsMediaGrant(base + path));
  for (const path of ["/api/services/wanx.homeai/v1/jobs",base + "/jobs/../other",base + "/jobs/%2e%2e",
    base + "/jobs/id/result/anything", base + "/asr/sessions/anything/stream",base + "/grants","https://other.invalid" + base + "/jobs"])
    assert.equal(acceptsMediaGrant(path),false);
});

test("summary grants are scoped to the exact media routes", () => {
  const base = "/api/services/wanx.media/v1";
  const id = "a".repeat(32);
  for (const path of [
    "/summaries", "/summary-templates", "/summary-templates/default",
    "/summary-templates/builtin-default", "/summary-templates/" + id,
  ]) {
    assert.equal(acceptsMediaGrant(base + path), true);
    assert.equal(isMediaAsrStream(base + path), false);
  }
  for (const path of [
    "/api/services/wanx.homeai/v1/summary-templates",
    base + "/summaries/" + id,
    base + "/summary-templates/" + id + "/extra",
    base + "/summary-templates/" + id.toUpperCase(),
    base + "/summary-templates/" + id.slice(1),
    base + "/summary-templates/%2e%2e",
    base + "/summary-templates-default",
  ]) {
    assert.equal(acceptsMediaGrant(path), false);
  }
});

test("the Host and Dashboard forward a scoped grant only to the selected media endpoint", async t => {
  const { createServer } = await import("node:http");
  const { createApplicationSession } = await import("../app-host/session.mjs");
  const { createDashboardGateway } = await import("../octop/gateway.mjs");
  const { fromEnvironment } = await import("../host-sdk/index.cjs");
  const received = [];
  const target = createServer((req, res) => {
    received.push(req.headers["x-media-grant"]);
    req.resume(); res.writeHead(200, {"content-type":"application/json"}).end("{}");
  });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  const gateway = await createDashboardGateway({targetURL:"http://127.0.0.1:"+target.address().port});
  const session = await createApplicationSession({hostApplicationId:"test-host",applicationId:"homeai",
    installPath:process.cwd(),createConnection:()=>({context:()=>({connection:"ready",boxId:"fixture",user:{id:1}}),
    request:options=>gateway.request(options)})});
  const client = fromEnvironment(session.environment);
  t.after(async()=>{client.close(); await session.close(); await gateway.close();
    await new Promise(resolve=>target.close(resolve));});
  const base = "/api/services/wanx.media/v1";
  const template = base + "/summary-templates/" + "a".repeat(32);
  const requests = [
    ["GET", base + "/capabilities", "fixture"],
    ["POST", base + "/summaries", "fixture"],
    ["GET", base + "/summary-templates", "fixture"],
    ["POST", base + "/summary-templates", "fixture"],
    ["GET", base + "/summary-templates/builtin-default", "fixture"],
    ["GET", base + "/summary-templates/default", "fixture"],
    ["PUT", base + "/summary-templates/default", "fixture"],
    ["PUT", template, "fixture"],
    ["DELETE", template, "fixture"],
    ["GET", template + "/extra", undefined],
    ["GET", "/api/services/wanx.homeai/v1/summary-templates", undefined],
  ];
  for (const [method, endpoint] of requests) {
    const reply=await client.request(endpoint,{method,headers:{"X-Media-Grant":"fixture"}});
    assert.equal(reply.status,200);
    await reply.json();
  }
  assert.deepEqual(received, requests.map(([, , expected]) => expected));
});


test("Host streams ASR to the exact path with no URL credentials", { timeout: 5000 }, async t => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { WebSocketServer } = await import("ws");
  const { createApplicationSession } = await import("../app-host/session.mjs");
  const { createDashboardGateway } = await import("../octop/gateway.mjs");
  const { fromEnvironment } = await import("../host-sdk/index.cjs");
  const createPath = "/api/services/wanx.media/v1/asr/sessions";
  const streamPath = createPath + "/" + "a".repeat(32) + "/stream";
  const ticket = "b".repeat(43);
  assert.ok(isMediaAsrStream(streamPath));
  assert.equal(isMediaAsrStream(streamPath + "?ticket=forbidden"), false);
  let observedPost, observedUpgrade;
  const box = createServer((req, res) => {
    observedPost = [req.method, req.url, req.headers["x-media-grant"]];
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ streamPath, ticket }));
  });
  const sockets = new WebSocketServer({ server: box });
  sockets.on("connection", (socket, req) => {
    observedUpgrade = [req.url, req.headers["sec-websocket-protocol"], req.headers["x-media-grant"]];
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  box.listen(0, "127.0.0.1");
  await once(box, "listening");
  const gateway = await createDashboardGateway({
    targetURL: "http://127.0.0.1:" + box.address().port,
    session: { getToken: () => "platform-session", close() {} },
  });
  const session = await createApplicationSession({
    hostApplicationId: "test-host",
    applicationId: "homeai",
    installPath: process.cwd(),
    createConnection: () => ({
      context: () => ({ connection: "ready", boxId: "fixture", user: { id: 1 } }),
      request: input => gateway.request(input),
      openStream: input => gateway.openWebSocket(input),
    }),
  });
  const client = fromEnvironment(session.environment);
  t.after(async () => {
    client.close();
    await session.close();
    await gateway.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    box.closeAllConnections();
    await new Promise(resolve => box.close(resolve));
  });
  const response = await client.request(createPath, {
    method: "POST", headers: { "X-Media-Grant": "asr-fixture" },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(observedPost, ["POST", createPath, "asr-fixture"]);
  const sessionInfo = await response.json();
  const protocols = ["wanx.asr.v1", "wanx.asr.ticket." + sessionInfo.ticket];
  const socket = await client.openStream(sessionInfo.streamPath, { protocols });
  await once(socket, "open");
  assert.equal(socket.protocol, "wanx.asr.v1");
  assert.deepEqual(observedUpgrade, [streamPath, protocols.join(","), undefined]);
  const reply = once(socket, "message");
  const pcm = Buffer.alloc(3200);
  socket.send(pcm);
  assert.deepEqual(await reply, [pcm, true]);
});

test("recording Host consent survives pending delivery and worker receives only the Host session", async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createHash, randomBytes } = await import('node:crypto');
  const { recordingSession } = await import('../shell/accessory-media-session.mjs');
  const { fromEnvironment } = await import('../host-sdk/index.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-host-consent-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const ctx = {boxId:'box', accountId:'user', clientId:'client', user:{id:7}, connection:'ready', dataIdentity:{profileId:'space'}};
  const secret = randomBytes(24).toString('hex');
  let prompts = 0;
  const received = [];
  const owner = {
    app:{getPath:()=>root,getAppPath:()=>process.cwd()},
    client:{snapshot:()=>({phase:'ready'}), applicationConnection:() => ({
      context:()=>ctx, request:async req => {
        received.push(req.headers['x-media-grant']);
        const valid = req.headers['x-media-grant'] === secret;
        return {status:valid ? 200 : 403, headers:{'content-type':'application/json'}, body:Buffer.from(JSON.stringify({
          instance:'disc-instance',processingLocation:'box',capabilities:[{id:'audio.transcribe',configured:true}],
        }))};
      },
    })},
    dialog:{showMessageBox:async()=>{prompts++;return {response:0};}},
    safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},
  };
  assert.equal(await recordingSession(owner,false),null);
  await assert.rejects(recordingSession(owner,true), {code:'MEDIA_GRANT_PENDING'});
  await assert.rejects(recordingSession(owner,false), {code:'MEDIA_GRANT_PENDING'});
  assert.equal(prompts,1);
  const scope=createHash('sha256').update(JSON.stringify(['box','user','space'])).digest('hex');
  const request=JSON.parse(await fs.readFile(path.join(root,'accessories',scope,'recording-media-request.json'),'utf8'));
  assert.equal(request.userId,'7');
  assert.equal(request.spaceId,'personal');
  assert.match(request.instance,/^memobox-recording-[0-9a-f]{32}$/);
  assert.deepEqual(request.capabilities,['audio.transcribe','audio.transcribe.streaming']);
  const packageFile=path.join(root,'accessories',scope,'recording-media-grant.json');
  await fs.writeFile(packageFile,JSON.stringify({instance:'disc-instance',grant:secret}),{mode:0o600});
  const active=await recordingSession(owner,false);
  t.after(()=>active.session.close());
  assert.equal(JSON.stringify(active.env).includes(secret),false);
  assert.equal(active.env.MEMOBOX_MEDIA_INSTANCE,'disc-instance');
  const sdk=fromEnvironment(active.env); t.after(()=>sdk.close());
  await sdk.request('/api/services/wanx.media/v1/capabilities');
  await sdk.request('/api/services/wanx.homeai/v1/jobs').catch(()=>{});
  assert.deepEqual(received.slice(-2),[secret,undefined]);
  const reused=await recordingSession(owner,false);await reused.session.close();
  assert.equal(prompts,1);
  assert.equal(await fs.stat(packageFile).catch(()=>null),null);
  ctx.accountId='other';
  assert.equal(await recordingSession(owner,false),null);
});
