import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SemanticaService } from "../shell/service.mjs";
const response = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

test('conversation file binding is atomic and cannot be changed or removed on retry',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'conversation-upload-'));
  try{
    const filename=path.join(directory,'material.txt');await writeFile(filename,'synthetic material');
    let begin,failFirst=true;
    const remote=setup(async(endpoint,options)=>{
      if(endpoint.endsWith('/imports')){if(begin)assert.deepEqual(options.body,begin);else begin=structuredClone(options.body);
        if(failFirst){failFirst=false;throw Error('network');}return response({document:{id:'bound-doc'}});}
      throw Error('unexpected endpoint');
    });
    const service=new SemanticaService({host:remote.host,selectFiles:async()=>[filename]});
    const [file]=await service.call('select-files',{warehouseId:'warehouse'});
    const input={warehouseId:'warehouse',handle:file.handle,conversationId:'conversation',intentId:'intent',expectedIntentRevision:1};
    await assert.rejects(service.call('upload',input));
    assert.equal(begin.conversation_id,'conversation');assert.equal(begin.intent_id,'intent');assert.equal(begin.expected_intent_revision,1);
    await assert.rejects(service.call('upload',{warehouseId:'warehouse',handle:file.handle}),{code:'MODELING_OPERATION_CONFLICT'});
    await assert.rejects(service.call('upload',{...input,intentId:'other'}),{code:'MODELING_OPERATION_CONFLICT'});
    assert.equal((await service.call('upload',input)).document.id,'bound-doc');
  }finally{await rm(directory,{recursive:true,force:true});}
});
function setup(handler) {
  let invalid;
  const host = {
    context: async () => ({
      boxId: "real-lease",
      user: { id: 7, username: "test" },
      connection: "ready",
    }),
    onSessionInvalidated: (fn) => ((invalid = fn), () => {}),
    close() {},
    request: handler,
  };
  return { host, revoke: () => invalid() };
}

test("warehouse migration commands are unavailable to the desktop client", async () => {
  const service = new SemanticaService({ host: setup(() => { throw Error("unexpected request"); }).host });
  for (const action of ["export-warehouse", "import-migration", "select-migration", "transfers", "transfer", "save-migration"]) {
    await assert.rejects(service.call(action, { warehouseId: "warehouse-a" }), { code: "SEMANTICA_OPERATION_NOT_ALLOWED" });
  }
});

test("citation text is requested by warehouse, document, version and range", async () => {
  const seen = [];
  const service = new SemanticaService({host:setup(async (endpoint, options) => {
    seen.push({endpoint, method:options.method});
    return response({document_id:"source", version_id:"earlier", start:12, text:"original citation"});
  }).host});
  try {
    const input = {warehouseId:"warehouse-a", id:"source", versionId:"earlier", start:12};
    assert.equal((await service.call("document-text", input)).version_id, "earlier");
    await assert.rejects(service.call("document-text", {...input, versionId:"../latest"}), {code:"INVALID_RESOURCE"});
    await assert.rejects(service.call("document-text", {...input, start:-1}), {code:"INVALID_RESOURCE"});
    await assert.rejects(service.call("document-text", {...input, warehouseId:undefined}), {code:"INVALID_RESOURCE"});
    await assert.rejects(service.call("document-text", {...input, end:11}), {code:"INVALID_RESOURCE"});
    await assert.rejects(service.call("document-text", {...input, end:65549}), {code:"INVALID_RESOURCE"});
    await service.call("document-text", {...input, end:20});
    const url = "/api/semantica/warehouses/warehouse-a/documents/source/text?version_id=earlier&start=12";
    assert.deepEqual(seen, [{endpoint:url, method:"GET"}, {endpoint:url+"&end=20", method:"GET"}]);
  } finally {
    service.close();
  }
});

test("failed import diagnostics only expose the selected warehouse's error", async () => {
  const seen = [];
  const remote = setup(async endpoint => {
    seen.push(endpoint);
    return response({items: [
      {kind: "import", warehouse_id: "other", state: "failed", error: "other private error"},
      {kind: "import", warehouse_id: "warehouse-a", state: "failed", error: "graph rebuild failed"},
    ]});
  });
  const service = new SemanticaService({host: remote.host});
  assert.deepEqual(await service.call("warehouse-import-status", {warehouseId: "warehouse-a"}), {error: "graph rebuild failed"});
  assert.deepEqual(seen, ["/api/semantica/warehouses/transfers"]);
  assert.deepEqual(await service.call("warehouse-import-status", {warehouseId: "missing"}), {error: null});
  service.close();
});

test("one native key grants all public knowledge capabilities and preserves explicit legacy grants", async () => {
  const requests = [];
  const remote = setup(async (endpoint, options) => {
    requests.push({ endpoint, body: options.body });
    return response({ key: { scopes: options.body.scopes } });
  });
  const service = new SemanticaService({ host: remote.host });
  await service.call("create-key", { warehouseId: "warehouse-a", name: "合成调用方", days: 30, operationId: "unified-key" });
  assert.deepEqual(requests[0].body.scopes, ["documents", "evidence", "graph", "reasoning", "search"]);
  assert.equal(requests[0].endpoint, "/api/semantica/warehouses/warehouse-a/keys");
  await service.call("create-key", { warehouseId: "warehouse-a", name: "旧版调用方", scopes: ["search"], days: 1, operationId: "legacy-key" });
  assert.deepEqual(requests[1].body.scopes, ["search"]);
});

test("retired MCP discovery is rejected without contacting the server", async () => {
  const requests = [];
  const remote = setup(async endpoint => { requests.push(endpoint); return response({}); });
  const service = new SemanticaService({host: remote.host});
  await assert.rejects(service.call("mcp-connection-info"));
  assert.deepEqual(requests, []);
  service.close();
});

test("launch invalidation clears selections and rejects a late successful response", async () => {
  let resolve;
  const remote = setup(() => new Promise((r) => (resolve = r)));
  const service = new SemanticaService({ host: remote.host });
  const read = service.api("/documents");
  remote.revoke();
  resolve(response({ items: [{ name: "old-account" }] }));
  await assert.rejects(read, { code: "HOST_SESSION_EXPIRED" });
  assert.equal(service.files.size, 0);
  await assert.rejects(service.call("documents"), {
    code: "HOST_SESSION_EXPIRED",
  });
});

test("main process streams chunks, reuses the operation on explicit retry and reconciles an uncertain commit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "semantica-upload-"));
  try {
    const filename = path.join(directory, "合成材料.txt"),
      data = Buffer.alloc(2 * 1024 * 1024 + 27, 0x61);
    await writeFile(filename, data);
    let begin = null,
      offset = 0,
      commit = 0;
    const chunks = [];
    const remote = setup(async (endpoint, options) => {
      assert.ok(endpoint.startsWith("/api/semantica/"));
      const body = options?.body;
      if (endpoint.endsWith("/imports")) {
        if (begin) assert.equal(body.operation_id, begin.operation_id);
        else begin = body;
        return response({ upload_handle: "a".repeat(32), offset });
      }
      if (options?.method === "PATCH") {
        assert.equal(body.offset, offset);
        const bytes = Buffer.from(body.content_base64, "base64");
        assert.ok(bytes.length <= 1024 * 1024);
        chunks.push(bytes);
        offset += bytes.length;
        return response({ offset });
      }
      if (endpoint.endsWith("/commit")) {
        commit++;
        throw new Error("synthetic lost response");
      }
      if (endpoint.includes("/operations/"))
        return response({
          status: "committed",
          document: { id: "document-real" },
          job: { id: "job-real" },
        });
      throw new Error("unexpected endpoint");
    });
    const service = new SemanticaService({
      host: remote.host,
      selectFiles: async () => [filename],
    });
    const [selected] = await service.call("select-files");
    assert.equal(selected.path, undefined);
    const result = await service.call("upload", { handle: selected.handle });
    assert.equal(result.document.id, "document-real");
    assert.equal(commit, 1);
    assert.deepEqual(Buffer.concat(chunks), data);
    assert.equal(begin.sha256, createHash("sha256").update(data).digest("hex"));
    await service.call("upload", { handle: selected.handle });
    assert.equal(commit, 1);
    service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unavailable backend is surfaced as an upgrade or service error, never a synthetic result", async () => {
  const remote = setup(async () => new Response("not found", { status: 404 }));
  const service = new SemanticaService({ host: remote.host });
  await assert.rejects(service.call("documents"), {
    code: "SEMANTICA_UPGRADE_REQUIRED",
  });
  service.close();
});

test("original download verifies every chunk and keeps the destination on integrity failure", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "semantica-download-"),
  );
  try {
    const output = path.join(directory, "source.txt"),
      data = Buffer.alloc(1024 * 1024 + 31, 0x62);
    const digest = createHash("sha256").update(data).digest("hex");
    let corrupt = false,
      reads = 0;
    const remote = setup(async (endpoint) => {
      if (!endpoint.includes("/blob?"))
        return response({ document: { original_name: "source.txt" } });
      const query = new URL(endpoint, "http://localhost").searchParams,
        offset = Number(query.get("offset"));
      if (offset) {
        assert.equal(query.get("expected_origin_revision"), "3");
        assert.equal(query.get("expected_sha256"), digest);
      }
      const bytes = Buffer.from(data.subarray(offset, offset + 1024 * 1024));
      if (corrupt) bytes[0] ^= 1;
      reads++;
      return response({
        offset,
        length: bytes.length,
        total_bytes: data.length,
        origin_revision: 3,
        sha256: digest,
        content_base64: bytes.toString("base64"),
      });
    });
    const service = new SemanticaService({
      host: remote.host,
      selectSave: async () => output,
    });
    assert.deepEqual(await service.call("download", { id: "test-doc" }), {
      saved: true,
    });
    assert.equal(reads, 2);
    assert.deepEqual(await readFile(output), data);
    corrupt = true;
    await assert.rejects(service.call("download", { id: "test-doc" }), {
      code: "SEMANTICA_DOWNLOAD_HASH_MISMATCH",
    });
    assert.deepEqual(await readFile(output), data);
    assert.deepEqual(await readdir(directory), ["source.txt"]);
    service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('each request and selected file keep their warehouse across concurrent calls', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'xingtu-scope-'));
  try {
    const file=path.join(dir,'合成.txt');await writeFile(file,'synthetic');
    const seen=[];
    const remote=setup(async endpoint=>{seen.push(endpoint);return response({items:[],total:0});});
    const service=new SemanticaService({host:remote.host,selectFiles:async()=>[file]});
    await Promise.all([service.call('documents',{warehouseId:'warehouse-a'}),service.call('graph',{warehouseId:'warehouse-b'})]);
    assert.deepEqual(seen.sort(),['/api/semantica/warehouses/warehouse-a/documents?limit=100&offset=0','/api/semantica/warehouses/warehouse-b/owner/graph?limit=120']);
    const [selected]=await service.call('select-files',{warehouseId:'warehouse-a'});
    await assert.rejects(service.call('upload',{warehouseId:'warehouse-b',handle:selected.handle}),{code:'SEMANTICA_FILE_SELECTION_EXPIRED'});
    service.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('clearing sends the short-lived intent and typed warehouse name together',async()=>{
  let seen;
  const remote=setup(async(endpoint,options)=>{seen={endpoint,body:options.body};return response({state:'clearing'});});
  const service=new SemanticaService({host:remote.host});
  await service.call('clear-warehouse',{warehouseId:'warehouse-a',operationId:'op-a',token:'synthetic-intent',typedName:'合成仓'});
  assert.equal(seen.endpoint,'/api/semantica/warehouses/warehouse-a/clear');
  assert.deepEqual(seen.body,{operation_id:'op-a',confirmation_token:'synthetic-intent',typed_name:'合成仓'});
  service.close();
});

test('deletion uses a separate confirmation route and expires only the target warehouse file selections',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'xingtu-delete-'));
  try {
    const file=path.join(dir,'合成.txt');await writeFile(file,'synthetic');
    const seen=[];
    const remote=setup(async(endpoint,options)=>{seen.push({endpoint,body:options.body});return response({state:'deleting'});});
    const service=new SemanticaService({host:remote.host,selectFiles:async()=>[file]});
    const [target]=await service.call('select-files',{warehouseId:'warehouse-a'});
    const [retained]=await service.call('select-files',{warehouseId:'warehouse-b'});
    await service.call('prepare-delete',{warehouseId:'warehouse-a',operationId:'prepare-a'});
    await service.call('delete-warehouse',{warehouseId:'warehouse-a',operationId:'delete-a',token:'synthetic-delete-intent',typedName:'合成仓'});
    assert.deepEqual(seen,[
      {endpoint:'/api/semantica/warehouses/warehouse-a/delete/prepare',body:{operation_id:'prepare-a'}},
      {endpoint:'/api/semantica/warehouses/warehouse-a/delete',body:{operation_id:'delete-a',confirmation_token:'synthetic-delete-intent',typed_name:'合成仓'}},
    ]);
    assert.equal(service.files.has(target.handle),false);
    assert.equal(service.files.has(retained.handle),true);
    service.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('initialization does not read the default warehouse and scoped failures preserve the Host session', async () => {
  const seen = [];
  const remote = setup(async endpoint => {
    seen.push(endpoint);
    if (endpoint === '/api/semantica/warehouses') return response({items:[{id:'busy',state:'clear_failed'},{id:'active',state:'active'}]});
    if (endpoint === '/api/semantica/warehouses/runtime') return response({local_only:true});
    if (endpoint === '/api/semantica/status' || endpoint === '/api/semantica/capabilities') return response({});
    if (endpoint.includes('/warehouses/active/')) return response({nodes:[],edges:[]});
    return new Response(JSON.stringify({code:'WAREHOUSE_BUSY',message:'此仓清理未完成'}),{status:409});
  });
  const service = new SemanticaService({host:remote.host});
  const initial = await service.initialize();
  assert.equal(initial.identity.connection,'ready');
  assert.equal(initial.warehouses.items.length,2);
  assert.equal(initial.retrieval,null);
  assert(!seen.includes('/api/semantica/retrieval/status'));
  await assert.rejects(service.call('graph',{warehouseId:'busy'}),{code:'WAREHOUSE_BUSY',publicMessage:'此仓清理未完成'});
  assert.deepEqual(await service.call('graph',{warehouseId:'active'}),{nodes:[],edges:[]});
  assert.equal(service.invalid,false);
  service.close();
});

test('Skill picker aborts on warehouse or session change before posting bytes',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'starlink-skill-'));
  try{const file=path.join(dir,'synthetic.zip');await writeFile(file,'synthetic');
    for(const change of ['warehouse','session']){
      let resolve,posts=0;const remote=setup(async()=>{posts++;return response({});});
      const service=new SemanticaService({host:remote.host,selectSkill:()=>new Promise(r=>resolve=r)});
      const pending=service.call('import-skill',{warehouseId:'test-a'});
      if(change==='warehouse')await service.call('select-warehouse',{warehouseId:'test-b'});else remote.revoke();
      resolve([file]);await assert.rejects(pending,{code:change==='warehouse'?'WAREHOUSE_CHANGED':'HOST_SESSION_EXPIRED'});assert.equal(posts,0);service.close();
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Skill commands require a warehouse and removed reasoning command is unavailable',async()=>{
 const remote=setup(async()=>response({}));const service=new SemanticaService({host:remote.host});
 await assert.rejects(service.call('skills'),{code:'INVALID_RESOURCE'});
 await assert.rejects(service.call('reasoning',{warehouseId:'a',operation:'prepare'}),{code:'SEMANTICA_OPERATION_NOT_ALLOWED'});
 service.close();
});
