import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createHostClient } from "../host-sdk/index.cjs";

const root = "/api/semantica/warehouses/10000000-0000-4000-8000-000000000001";
const workbench = root + "/workbench/ontologies";

async function fixture(t, edition) {
  const {createApplicationSession} = await import(`../../${edition}/app-host/session.mjs`);
  const {createDashboardGateway} = await import(`../../${edition}/octop/gateway.mjs`);
  const seen = [];
  const box = http.createServer((req, res) => {
    seen.push({ path: req.url, origin: req.headers.origin });
    // Match the Bridge's existing service-only workbench Origin boundary.
    res.setHeader("content-type", "application/json");
    const denied = (req.url.startsWith(root + "/workbench/") || req.url.startsWith('/api/semantica/modeling/') || req.url.startsWith(root+'/modeling/')) && req.headers.origin;
    res.statusCode = denied ? 403 : 200;
    res.end(JSON.stringify(denied ? { code: "SEMANTICA_RESOURCE_FORBIDDEN" } : { items: [] }));
  });
  box.listen(0, "127.0.0.1");
  await once(box, "listening");
  const targetURL = `http://127.0.0.1:${box.address().port}`;
  const gateway = await createDashboardGateway({ targetURL });
  const session = await createApplicationSession({
    hostApplicationId: "wanx-host", applicationId: "centaurai.wanx.starlink", installPath: "/synthetic/starlink",
    createConnection: async () => ({
      context: () => ({ boxId: "synthetic-box", user: { id: 2 }, connection: "ready" }),
      request: input => gateway.request(input), subscribe: () => () => {},
    }),
  });
  const client = createHostClient({ baseURL: session.environment.WANX_HOST_BASE_URL, token: session.environment.WANX_HOST_TOKEN });
  t.after(async () => {
    client.close(); await session.close(); await gateway.close();
    box.closeAllConnections(); await new Promise(resolve => box.close(resolve));
  });
  return { gateway, client, seen, targetURL };
}

test('personal Starlink onboarding and ontology modeling use the service-only main transport', async t => {
  const f = await fixture(t, 'personal-client');
  for (const [method, path] of [
    ['GET', '/api/semantica/modeling/onboarding'], ['GET', '/api/semantica/modeling/warehouses'],
    ['POST', '/api/semantica/modeling/onboarding'], ['POST', '/api/semantica/modeling/onboarding/profile/warehouse'],
    ['GET', root+'/modeling/suggestion-context'], ['POST', root+'/modeling/answer-confirmations'],
    ['POST', root+'/modeling/answer-suggestions'], ['GET', root+'/modeling/answer-suggestions/proposal'],
    ['GET', root+'/modeling/answer-suggestions/proposal/rules'], ['POST', root+'/modeling/rule-previews'],
    ['POST', root+'/modeling/rule-previews/preview/publish'],
  ]) {
    const response = await f.client.request(path, {method, ...(method==='POST'?{body:{operation_id:'synthetic-operation'}}:{})});
    assert.equal(response.status,200,path); assert.equal(f.seen.at(-1).origin,undefined,path);
  }
  for (const path of ['/api/semantica/modeling/onboarding',root+'/modeling/suggestion-context']) {
    assert.equal(await browserRequest(f.gateway.url+path,{origin:f.gateway.origin,'x-wanx-native-request':'true'}),403);
    assert.equal(f.seen.at(-1).origin,f.targetURL);
  }
  for (const [method,path] of [['DELETE','/api/semantica/modeling/onboarding'],['POST','/api/semantica/modeling/warehouses'],
    ['GET','/api/semantica/modeling/../onboarding'],['GET',root+'/modeling/%73uggestion-context']]) {
    await f.gateway.request({method,path}); assert.equal(f.seen.at(-1).origin,f.targetURL,path);
  }
});

function browserRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
}

for (const edition of ["personal-client", "team-client"]) {
test(`${edition}: Starlink main-owned Host requests can reach the service-only workbench`, async t => {
  const f = await fixture(t, edition);
  for (const method of ["GET", "POST", "PUT", "PATCH"]) {
    const response = await f.client.request(workbench + "?limit=20", {
      method, ...(method === "GET" ? {} : { body: { _native_operation_id: "synthetic-operation" } }),
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal(f.seen.at(-1).origin, undefined);
  }
  await f.client.request(root + "/documents");
  assert.equal(f.seen.at(-1).origin, f.targetURL);
});

test(`${edition}: browser workbench requests retain Origin and cannot claim the main-owned exception`, async t => {
  const f = await fixture(t, edition);
  assert.equal(await browserRequest(f.gateway.url + workbench, {
    origin: f.gateway.origin, "x-wanx-native-request": "true",
  }), 403);
  assert.equal(f.seen.at(-1).origin, f.targetURL);
  const before = f.seen.length;
  assert.equal(await browserRequest(f.gateway.url + workbench, { origin: "https://untrusted.invalid" }), 403);
  assert.equal(f.seen.length, before);
});

test(`${edition}: only canonical scoped workbench paths and supported methods omit synthetic Origin`, async t => {
  const f = await fixture(t, edition);
  for (const path of [
    "/api/semantica/workbench/ontologies",
    root + "/workbench-other/ontologies",
    root + "/workbench/../settings",
    root + "/workbench/%6fntologies",
    root.replace("10000000", "not-a-uuid") + "/workbench/ontologies",
    root + "/owner/graph",
  ]) {
    await f.gateway.request({ path });
    assert.equal(f.seen.at(-1).origin, f.targetURL, path);
  }
  await f.gateway.request({ path: workbench, method: "DELETE" });
  assert.equal(f.seen.at(-1).origin, f.targetURL);
});
}
