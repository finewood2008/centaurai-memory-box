import { mkdtemp, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createBoxCloudTransport, createMyAiCloudRoutes } from "../shell/my-ai-cloud-route.mjs";
import { cloudCliOptions } from "../shell/my-ai-cloud-protocol.mjs";

test("cloud catalogue and explicit invocation use only box-managed cloud rows", async () => {
  const rows = [{provider_name:"ollama",model:"qwen",input:["text"]},{provider_name:"admin-managed-p",model:"cloud",input:["text"]}];
  const calls = [];
  const transport = createBoxCloudTransport({applicationConnection:async()=>({
    request:async req => {
      calls.push(req);
      return { status:200,body:JSON.stringify(req.method === "GET" ? {capabilities:{memory_summary:{models:rows}}} : {text:"OK",model:"cloud"}) };
    },close() {},
  })});
  const [model,...others] = await transport.catalog(undefined,()=>{});
  assert.deepEqual(others,[]);
  assert.equal(model.ref,"admin-managed-p/cloud");
  const turn = {messages:[{role:"user",content:"OK?"}],maxTokens:20};
  await assert.rejects(transport.complete({ref:"ollama/qwen"},turn,undefined,()=>{}));
  await transport.complete(model,turn,undefined,()=>{});
  assert.equal(calls.length,2);
  assert.equal(JSON.parse(calls[1].body).model_ref,model.ref);
});

test("switching applies to new launches, disconnect revokes old leases, failures never fall back",async t=>{
  let saved = {}, scope="first", generation=0;
  const model={ref:"admin-managed-p/cloud",model:"cloud",name:"Cloud"};
  const service=createMyAiCloudRoutes({context:()=>({owner:"user",box:"box",scope}),store:{load:async()=>saved,save:async d=>{saved=d;}},
    transport:{catalog:async()=>[model],complete:async()=>{generation++;return {model:"cloud",text:"OK"};}}});
  t.after(()=>service.close());
  const check=()=>{};
  await service.action("select","codex_cli",model.ref,check);
  const first=await service.launch("codex_cli",check);
  assert.equal(await service.launch("claude_code",check),undefined);
  const ask=token=>fetch("http://127.0.0.1:"+first.port+"/v1/responses",{method:"POST",
    headers:{authorization:"Bearer "+token},body:JSON.stringify({input:"Hi"})});
  assert.equal((await ask("bad")).status,401);
  await service.action("select","codex_cli",null,check);
  assert.equal(await service.launch("codex_cli",check),undefined);
  assert.deepEqual(cloudCliOptions(undefined),{args:[],env:{}});
  assert.equal((await (await ask(first.token)).json()).output[0].content[0].text,"OK");
  await service.action("select","codex_cli",model.ref,check);
  scope=null;service.sync();
  await assert.rejects(service.launch("codex_cli",check));
  scope="second";service.sync();
  assert.equal((await ask(first.token)).status,401);
  assert.equal(generation,1);
});


test("desktop gateway advertises the selected model, reports inference, and invalidates its credential on restore",async t => {
  const directory = await mkdtemp(path.join(tmpdir(),"codex-gateway-test-"));
  const model = {ref:"admin-managed-a/cloud",model:"cloud",name:"Cloud"};
  let scope = "one";
  const check=()=>{};
  const service = createMyAiCloudRoutes({desktopGatewayDir:directory,context:()=>({owner:"pilot",box:"box",scope}),
    transport:{catalog:async()=>[model],complete:async()=>({model:"cloud",text:"89"})}});
  t.after(async()=>{ service.close(); await rm(directory,{recursive:true,force:true}); });
  const select = ref => service.action("select","codex",ref,check);
  const {gateway} = await select(model.ref);
  assert.equal((await stat(gateway.helper)).mode & 0o777,0o700);
  const headers = {authorization:"Bearer "+execFileSync(gateway.helper,{encoding:"utf8"}).trim()};
  const models = await (await fetch(gateway.base+"/models?client_version=0.171.0",{headers})).json();
  assert.equal(models.models[0].slug,model.model);
  assert.equal((await service.action("status","codex",null,check)).gateway.receivedAt,null);
  const ask = model => fetch(gateway.base+"/responses",{method:"POST",headers,body:JSON.stringify({model,input:"137-48?"})});
  assert.equal((await ask("other")).status,400);
  assert.equal((await (await ask(model.model)).json()).output[0].content[0].text,"89");
  assert.ok((await service.action("status","codex",null,check)).gateway.receivedAt);
  assert.equal((await select(null)).selected,null);
  assert.equal((await ask(model.model)).status,401);
  await assert.rejects(stat(gateway.helper));
  const second=await select(model.ref);
  assert.equal(second.gateway.helper,gateway.helper);
  assert.equal((await ask(model.model)).status,401);
  scope="two";
  assert.equal((await service.action("status","codex",null,check)).selected,null);
});
