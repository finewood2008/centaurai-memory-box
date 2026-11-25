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

test("Host supplies a stable, per-application foreground credential only on media routes", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApplicationSession } = await import("../app-host/session.mjs");
  const { createForegroundMediaGrantReader } = await import("../app-host/media-grant.mjs");
  const { fromEnvironment } = await import("../host-sdk/index.cjs");
  const directory = await mkdtemp(join(tmpdir(), "media-foreground-"));
  const read = createForegroundMediaGrantReader(directory);
  const reopened = createForegroundMediaGrantReader(directory);
  const [first, second, restored] = await Promise.all([read("recording.app"), read("other.app"), reopened("recording.app")]);
  assert.match(first, /^media_foreground_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(first, restored);

  const sent = [];
  const session = await createApplicationSession({
    hostApplicationId: "wanx", applicationId: "recording.app", installPath: directory,
    foregroundMediaGrant: () => read("recording.app"),
    createConnection: () => ({
      context: () => ({ connection: "ready" }),
      request: async ({ body, headers, path }) => {
        for await (const chunk of body) { /* consume the client request */ }
        sent.push([path, headers["x-media-grant"]]);
        return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
      },
    }),
  });
  const client = fromEnvironment(session.environment);
  t.after(async () => { client.close(); await session.close(); await rm(directory, { recursive: true, force: true }); });
  const base = "/api/services/wanx.media/v1";
  for (const [endpoint, method, grant] of [
    [base + "/capabilities", "GET"],
    [base + "/asr/sessions", "POST"],
    [base + "/summaries", "POST", second],
    [base + "/jobs", "POST", "legacy-explicit-grant"],
    [base + "/delegations", "GET"],
    [base + "/grant/self", "DELETE"],
    ["/api/services/another/v1/summaries", "POST", second],
  ]) {
    const response = await client.request(endpoint, {
      method, ...(grant ? { headers: { "X-Media-Grant": grant } } : {}),
    });
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.deepEqual(sent.map(([, grant]) => grant),
    [first, first, first, "legacy-explicit-grant", undefined, undefined, undefined]);
});

test("an open recorder remains available on box disconnect, but ends when the account changes", async t => {
  const { createApplicationSession } = await import("../app-host/session.mjs");
  const { fromEnvironment } = await import("../host-sdk/index.cjs");
  const account = { phase: "authenticated", accountId: "account", clientId: "client" };
  let snapshot = { phase: "ready", account, connection: { deviceId: "box" } };
  const session = await createApplicationSession({
    hostApplicationId: "wanx", applicationId: "centaurai.wanx.homeai", installPath: process.cwd(),
    recordingBoxState: () => snapshot,
    createConnection: () => ({
      context: () => ({ ...account, boxId: "box", connection: "ready" }),
      request: () => assert.fail("the disconnected Host forwarded to the box"),
    }),
  });
  const client = fromEnvironment(session.environment);
  t.after(async () => { client.close(); await session.close(); });
  assert.equal((await client.context()).connection, "ready");
  snapshot = { phase: "disconnected", account, connection: null };
  assert.equal((await client.context()).connection, "disconnected");
  await assert.rejects(
    client.request("/api/services/wanx.media/v1/capabilities"),
    { code: "NETWORK_NOT_READY" },
  );
  assert.doesNotThrow(session.assertLive);
  snapshot = { ...snapshot, account: { ...account, accountId: "other" } };
  assert.throws(session.assertLive, { code: "HOST_SESSION_EXPIRED" });
});

async function recordingFixture(t, { foreground = true, summaryConfigured = true } = {}) {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const {fileURLToPath} = await import('node:url');
  const { createHash, randomBytes } = await import('node:crypto');
  const { recordingSession } = await import('../shell/accessory-media-session.mjs');
  const { fromEnvironment } = await import('../host-sdk/index.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-recording-host-'));
  const sessions = [], clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const session of sessions) await session.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const ctx = {boxId:'box', accountId:'user', clientId:'client', user:{id:7}, connection:'ready', dataIdentity:{profileId:'space'}};
  const secret = randomBytes(24).toString('hex');
  const received = [];
  const capabilities = [
    {id:'audio.transcribe',configured:true},
    {id:'audio.transcribe.streaming',configured:true},
    {id:'text.summarize',configured:summaryConfigured,processingLocation:'cloud'},
  ];
  const summaryJobId = 'summary-job';
  const templateId = 'a'.repeat(32);
  let summaryInputHash;
  const owner = {
    app:{getPath:()=>root,getAppPath:()=>fileURLToPath(new URL('..', import.meta.url))},
    client:{snapshot:()=>({phase:'ready'}), applicationConnection:() => ({
      context:()=>ctx, request:async req => {
        const grant = req.headers['x-media-grant'];
        received.push({path:req.path, grant});
        const manual = grant === secret;
        const automatic = foreground && /^media_foreground_[A-Za-z0-9_-]{43}$/.test(grant);
        const valid = manual || automatic || !req.path.startsWith('/api/services/wanx.media/');
        let body = {code:'GRANT_REQUIRED'};
        if (valid) {
          const route = req.path.replace('/api/services/wanx.media/v1', '');
          if (route === '/summary-templates') {
            body = req.method === 'GET' ? {templates:[]} : {id:templateId};
          } else if (route === '/summaries') {
            const chunks = [];
            for await (const chunk of req.body) chunks.push(chunk);
            const input = Buffer.concat(chunks);
            if (input.length) {
              const payload = JSON.parse(input);
              assert.equal(payload.templateId, templateId);
              summaryInputHash = createHash('sha256').update(payload.text).digest('hex');
            }
            body = {id:summaryJobId,state:'done'};
          } else if (route === '/jobs/' + summaryJobId + '/result') {
            body = {jobId:summaryJobId,capability:'text.summarize',inputSha256:summaryInputHash,
              result:{text:'安排：周五整理文件。',model:'fixture-summary'}};
          } else {
            body = {instance:manual ? 'disc-instance' : 'foreground-' + createHash('sha256').update(grant ?? '').digest('hex').slice(0,32),
              processingLocation:'box',capabilities};
          }
        }
        return {status:valid ? 200 : 403, headers:{'content-type':'application/json'}, body:Buffer.from(JSON.stringify(body))};
      },
    })},
    dialog:{showMessageBox:async()=>assert.fail('recording asked for separate authorization')},
    safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},
  };
  return {
    ctx, received, secret,
    scopeDir() {
      const scope = createHash('sha256').update(JSON.stringify([ctx.boxId,ctx.accountId,ctx.dataIdentity.profileId])).digest('hex');
      return path.join(root,'accessories',scope);
    },
    async open() {
      const active = await recordingSession(owner);
      assert.ok(active);
      sessions.push(active.session);
      return active;
    },
    sdk(active) {
      const client = fromEnvironment(active.env);
      clients.push(client);
      return client;
    },
  };
}

test('recording uses the signed-in box session for ASR and requested cloud summaries', async t => {
  const fixture = await recordingFixture(t);
  const active = await fixture.open();
  const initialGrant = fixture.received.at(-1).grant;
  assert.match(initialGrant, /^media_foreground_[A-Za-z0-9_-]{43}$/);
  assert.match(active.env.MEMOBOX_MEDIA_INSTANCE, /^foreground-/);
  assert.equal(JSON.stringify(active.env).includes(initialGrant), false);

  const sdk = fixture.sdk(active);
  const base = '/api/services/wanx.media/v1';
  for (const endpoint of ['/jobs','/asr/sessions']) {
    const response = await sdk.request(base + endpoint, { method:'POST' });
    assert.equal(response.status, 200);
    await response.json();
    assert.deepEqual(fixture.received.at(-1), {path:base + endpoint,grant:initialGrant});
  }
  const otherService = await sdk.request('/api/services/wanx.homeai/v1/jobs');
  assert.equal(otherService.status, 200);
  await otherService.json();
  assert.equal(fixture.received.at(-1).grant, undefined);
  const worker = await import('../resources/accessory-preview/lib/media.mjs');
  const meetings = await import('../resources/accessory-preview/lib/meetings.mjs');
  const fs = await import('node:fs/promises');
  const {setTimeout:delay} = await import('node:timers/promises');
  worker.attachMedia(active.env);
  t.after(() => worker.attachMedia(null));
  assert.deepEqual(await worker.media.status(), {
    mode:'box',connected:true,granted:['audio.transcribe','audio.transcribe.streaming','text.summarize'],
    transcribe:true,live:true,summarize:true,summaryLocation:'cloud',summaryOnRequest:true,
  });
  await meetings.initStore(active.data);
  const {id} = await meetings.createMeeting({title:'合成录音'});
  const savedPath = active.data + '/meetings/' + id + '/meeting.json';
  const saved = JSON.parse(await fs.readFile(savedPath, 'utf8'));
  saved.state = 'finished';
  saved.audio.status = 'saved';
  saved.transcript = {status:'done',segments:[{i:1,text:'我们周五整理文件。',startMs:0,endMs:1000}]};
  saved.minutes.status = 'pending';
  await fs.writeFile(savedPath, JSON.stringify(saved));

  const waitForPipeline = async () => {
    for (let i = 0; i < 100 && meetings.view(id).pipelineRunning; i++) await delay(10);
    assert.equal(meetings.view(id).pipelineRunning, false);
    return meetings.view(id);
  };
  await meetings.initStore(active.data);
  assert.equal((await waitForPipeline()).minutes.status, 'waiting');
  assert.equal(fixture.received.some(r => r.path.endsWith('/summaries')), false);

  await meetings.retryStage(id, 'minutes', {instruction:'提取安排',rev:0});
  const completed = await waitForPipeline();
  assert.equal(completed.minutes.status, 'done');
  assert.equal(completed.minutes.document.text, '安排：周五整理文件。');
  assert.equal(completed.minutes.model, 'fixture-summary');
  for (const endpoint of ['/summary-templates','/summaries','/jobs/summary-job/result']) {
    assert.deepEqual(fixture.received.find(r => r.path === base + endpoint), {path:base + endpoint,grant:initialGrant});
  }
  for (const endpoint of ['/grant/self','/delegations']) {
    await assert.rejects(
      sdk.request(base + endpoint, {headers:{'X-Media-Grant':fixture.secret}}),
      {code:'MEDIA_GRANT_REQUIRED'},
    );
    assert.equal(fixture.received.some(r => r.path === base + endpoint), false);
  }

  for (const filename of ['media-consent.enc','recording-media-request.json','recording-media-grant.json']) {
    await assert.rejects(fs.stat(fixture.scopeDir() + '/' + filename), {code:'ENOENT'});
  }
  await active.session.close();
  const reopened = await fixture.open();
  assert.equal(fixture.received.at(-1).grant, initialGrant);
  assert.equal(reopened.env.MEMOBOX_MEDIA_INSTANCE, active.env.MEMOBOX_MEDIA_INSTANCE);
  assert.equal(reopened.data, active.data);

  fixture.ctx.accountId = 'other';
  fixture.ctx.user = {id:8};
  const otherAccount = await fixture.open();
  assert.notEqual(fixture.received.at(-1).grant, initialGrant);
  assert.notEqual(otherAccount.data, active.data);
});

test('recording keeps ASR ready when the box has no configured summary model', async t => {
  const fixture = await recordingFixture(t, {summaryConfigured:false});
  const active = await fixture.open();
  const worker = await import('../resources/accessory-preview/lib/media.mjs');
  worker.attachMedia(active.env);
  t.after(() => worker.attachMedia(null));
  assert.equal((await worker.media.status()).transcribe, true);
  assert.equal((await worker.media.status()).summarize, false);
  await assert.rejects(worker.media.ensureTemplate('fixture', '提取安排'), {offline:true});
  assert.equal(fixture.received.some(r => r.path.endsWith('/summary-templates')), false);
});

test('recording reuses a previously delivered grant and its project directory', async t => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const {createHash} = await import('node:crypto');
  const fixture = await recordingFixture(t, {foreground:false});
  const scope = fixture.scopeDir();
  await fs.mkdir(scope,{recursive:true});
  const packageFile = path.join(scope,'recording-media-grant.json');
  await fs.writeFile(packageFile, JSON.stringify({instance:'disc-instance',grant:fixture.secret}),{mode:0o600});
  const active = await fixture.open();
  assert.equal(fixture.received.at(-1).grant, fixture.secret);
  assert.equal(JSON.stringify(active.env).includes(fixture.secret), false);
  assert.equal(active.env.MEMOBOX_MEDIA_INSTANCE, 'disc-instance');
  assert.equal(active.env.MEMOBOX_MEDIA_SUMMARY_ON_REQUEST, undefined);
  assert.equal(active.data, path.join(scope,'projects',createHash('sha256').update('disc-instance').digest('hex')));
  const summary = await fixture.sdk(active).request('/api/services/wanx.media/v1/summaries', {method:'POST'});
  assert.equal(summary.status, 200);
  await summary.json();
  assert.equal(fixture.received.at(-1).grant, fixture.secret);
  await assert.rejects(fs.stat(packageFile), {code:'ENOENT'});
  await active.session.close();
  const reopened = await fixture.open();
  assert.equal(fixture.received.at(-1).grant, fixture.secret);
  assert.equal(reopened.data, active.data);
});

test('a box that rejects automatic recording media does not open a fake session', async t => {
  const fixture = await recordingFixture(t, {foreground:false});
  await assert.rejects(fixture.open(), {code:'GRANT_REQUIRED'});
  assert.equal(fixture.received.length, 1);
  assert.match(fixture.received[0].grant, /^media_foreground_[A-Za-z0-9_-]{43}$/);
});
