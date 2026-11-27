import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("managed worker retires a scoped engine and waits for the replacement API's first bootstrap", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "memobox-unified-worker-"));
  const source = path.join(root, "source"), home = path.join(root, "home");
  const service = path.join(home, "memory-service"), configPath = path.join(home, "config.yaml");
  const descriptor = path.join(home, "wanx-memobox-runtime.json"), databasePath = path.join(service, "memory.sqlite");
  const readyProbe = path.join(root, "ready-probe");
  await mkdir(service, { recursive: true });
  await writeFile(databasePath, "synthetic-database-placeholder");
  let retired = 0;
  const old = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-engine");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/admin/wanx-storage") return res.end(JSON.stringify({ dataPath: service, sourceProfile: "codex-desktop" }));
    assert.equal(req.url, "/api/v1/admin/shutdown");
    assert.equal(req.method, "POST");
    retired++;
    res.writeHead(202); res.end("{}");
    old.close(async () => {
      await writeFile(path.join(service, "runtime.json"), JSON.stringify({ pid: 0 }));
      await writeFile(path.join(service, "service.lock"), JSON.stringify({ pid: 0 }));
    });
  });
  await new Promise(resolve => old.listen(0, "127.0.0.1", resolve));
  const engineUrl = `http://127.0.0.1:${old.address().port}`;
  const staleApi = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/app/bootstrap") return res.end("{}");
    res.writeHead(503); res.end("{}");
  });
  await new Promise(resolve => staleApi.listen(0, "127.0.0.1", resolve));
  await writeFile(configPath, JSON.stringify({ storage: { mode: "local", backend: "sqlite", endpoint: engineUrl, sqlitePath: databasePath, token: "fixture-engine" } }));
  await writeFile(path.join(service, "runtime.json"), JSON.stringify({ pid: process.pid, status: "ready", endpoint: engineUrl, configPath, sqlitePath: databasePath }));
  await writeFile(path.join(service, "service.lock"), JSON.stringify({ pid: process.pid }));
  await writeFile(descriptor, JSON.stringify({ baseUrl: `http://127.0.0.1:${staleApi.address().port}`, localToken: "old-fixture-api", memory: { baseUrl: engineUrl } }));
  async function moduleFile(rel, content) { const p = path.join(source, rel); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, content); }
  await moduleFile("package.json", JSON.stringify({ type: "module" }));
  await moduleFile("Memory/dist/src/config/index.js", `import {readFileSync} from 'node:fs'; export function loadMemmyConfig(file){return {config:JSON.parse(readFileSync(file,'utf8'))}}`);
  await moduleFile("Memory/dist/src/server/index.js", `
import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2);const get=k=>args[args.indexOf(k)+1];const configPath=get('--config'),sqlitePath=get('--db');
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('wanx-storage')?{dataPath:path.dirname(sqlitePath)}:{ok:true,storage:{ready:true}}))});
server.listen(Number(get('--port')),'127.0.0.1',()=>{const pid=process.pid;const endpoint='http://127.0.0.1:'+server.address().port;const dir=path.join(path.dirname(configPath),'memory-service');writeFileSync(path.join(dir,'service.lock'),JSON.stringify({pid}));writeFileSync(path.join(dir,'runtime.json'),JSON.stringify({pid,status:'ready',endpoint,configPath,sqlitePath}))});
process.once('SIGTERM',()=>server.close(()=>process.exit(0)));
`);
  await moduleFile("App/backend/dist/src/adapters/outbound/memory-client/index.js", `export const createHttpMemoryClient=()=>({});`);
  await moduleFile("App/backend/dist/src/index.js", `
import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';
export async function createLocalBackend(options) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/app/bootstrap') {
      setTimeout(() => res.end('{}'), 2500);
      return;
    }
    if (req.headers['x-memmy-local-token'] === 'new-fixture-api') writeFileSync(${JSON.stringify(readyProbe)}, 'ready');
    res.end(JSON.stringify({ok:true,storage:{ready:true}}));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  writeFileSync(options.runtimeConfigPath, JSON.stringify({baseUrl:'http://127.0.0.1:'+server.address().port,localToken:'new-fixture-api',memory:{baseUrl:options.memoryBaseUrl}}));
  return { close: () => new Promise(done => {server.close(done);server.closeAllConnections()}) };
}
`);
  const workerFile = fileURLToPath(new URL("../shell/local-memory-worker.mjs", import.meta.url));
  const child = spawn(process.execPath, [workerFile, source, home, descriptor, path.join(root, "api.sqlite")], {
    env: { ...process.env, MEMMY_UNIFY_AGENT_SOURCES: "1" }, stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "", exited = false;
  child.stderr.on("data", chunk => { errors += chunk.toString(); });
  const closed = new Promise(resolve => child.once("exit", code => { exited = true; resolve(code); }));
  t.after(async () => {
    child.kill("SIGTERM"); await closed;
    const record = JSON.parse(await readFile(path.join(service, "runtime.json"), "utf8"));
    if (record.pid && record.pid !== process.pid && record.configPath === configPath) process.kill(record.pid, "SIGTERM");
    old.close(); staleApi.close();
    await rm(root, { recursive: true, force: true });
  });
  let configured;
  let ready = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !exited) {
    configured = JSON.parse(await readFile(descriptor, "utf8"));
    if (await readFile(readyProbe, "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
    }) === "ready") {
      ready = true;
      break;
    }
    await delay(50);
  }
  assert.equal(retired, 1);
  assert.equal(configured.localToken, "new-fixture-api", errors);
  assert.equal(configured.memory.baseUrl, engineUrl);
  assert.equal(ready, true, errors);
  const healthy = await fetch(new URL("/api/v1/health", configured.baseUrl));
  assert.equal((await healthy.json()).storage.ready, true);
});
