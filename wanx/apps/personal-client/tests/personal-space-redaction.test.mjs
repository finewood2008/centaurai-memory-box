import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPersonalSpace } from "../shell/personal-space.mjs";

const hash = data => createHash("sha256").update(data).digest("hex");
const itemId = "a".repeat(32), parent = "b".repeat(32);

async function fixture(t, { content = "邮箱 test@example.invalid；项目 海棠-42", before, failCommit = false } = {}) {
  const bytes = Buffer.from(content);
  let entry = { id: itemId, parent, space_id: "personal", kind: "file", name: "项目资料.txt", size: bytes.length, digest: hash(bytes), version: 1 };
  let state = { phase: "ready", account: { phase: "authenticated", accountId: "owner" }, connection: { deviceId: "box" } };
  let saved = null;
  const uploads = new Map(), files = new Map(), requests = [], listeners = new Set();
  const response = body => ({ status: 200, body: Buffer.from(JSON.stringify(body)) });
  const client = {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async applicationConnection() {
      const captured = state;
      function context() { if (state !== captured) throw new Error("NETWORK_CHANGED"); }
      return { context, async request(input) {
        requests.push(input);
        await before?.(input);
        context();
        const route = new URL(input.path, "http://space.test");
        const parts = route.pathname.split("/");
        if (parts[3] === "files" && parts[4] === itemId) {
          if (!parts[5]) return response(entry);
          const offset = Number(route.searchParams.get("offset")), length = Number(route.searchParams.get("length"));
          const chunk = bytes.subarray(offset, offset + length);
          return { status: 200, body: chunk, headers: { "x-content-sha256": hash(chunk) } };
        }
        assert.equal(parts[3], "uploads");
        if (!parts[4]) {
          const inputData = JSON.parse(input.body);
          assert.equal(inputData.parent, parent);
          assert.equal(inputData.space_id, "personal");
          const upload = { ...inputData, offset: 0, state: "pending", parts: [] };
          uploads.set(upload.id, upload);
          return response(upload);
        }
        const upload = uploads.get(parts[4]);
        if (input.method === "DELETE") { if (!files.has(parts[4])) uploads.delete(parts[4]); return { status: 204 }; }
        assert.ok(upload);
        if (input.method === "PUT") {
          assert.equal(input.headers["x-content-sha256"], hash(input.body));
          assert.equal(Number(route.searchParams.get("offset")), upload.offset);
          upload.parts.push(input.body);
          upload.offset += input.body.length;
          return response({ offset: upload.offset });
        }
        if (failCommit) return { status: 507, body: Buffer.from('{"detail":{"code":"SPACE_DISK_FULL"}}') };
        if (files.has(upload.id)) return response(files.get(upload.id));
        const output = Buffer.concat(upload.parts);
        assert.equal(output.length, upload.size);
        assert.equal(JSON.parse(input.body).digest, hash(output));
        const file = { id: upload.id, kind: "file", digest: hash(output), name: upload.name, parent: upload.parent };
        files.set(upload.id, file);
        return response(file);
      } };
    },
  };
  const options = { client, store: { load: async () => [], save: async () => {} }, serviceURL: "https://account.test",
    redactionStore: { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } } };
  let service = await createPersonalSpace(options);
  t.after(() => service.close());
  return { get service() { return service; }, requests, uploads, files, bytes,
    async restart() { await service.close(); service = await createPersonalSpace(options); },
    changeEntry(changes) { entry = { ...entry, ...changes }; },
    switchAccount(accountId) { state = { ...state, account: { phase: "authenticated", accountId } }; listeners.forEach(listener => listener()); },
    redact() { const { scope, dataContextId } = service.snapshot(); return service.operation("redact", { id: itemId, space_id: "personal", scope, dataContextId }); } };
}

test("saved Space rules survive restart, reject stale writes and stay with the active account", async t => {
  const f = await fixture(t);
  const rules = await f.service.operation("redaction-rules");
  const draft = { ...rules, customRules: [{ name: "项目代号", value: "海棠-42" }] };
  const saved = await f.service.operation("save-redaction-rules", draft);
  await assert.rejects(f.service.operation("save-redaction-rules", draft), { code: "SPACE_REDACTION_RULES_CONFLICT" });
  await f.restart();
  assert.deepEqual(await f.service.operation("redaction-rules"), saved);
  f.switchAccount("other");
  assert.deepEqual((await f.service.operation("redaction-rules")).customRules, []);
  await assert.rejects(f.service.operation("save-redaction-rules", saved), { code: "SPACE_CONTEXT_CHANGED" });
  f.switchAccount("owner");
  assert.deepEqual(await f.service.operation("redaction-rules"), saved);
});

test("Space writes only the masked bytes as a sibling of the source", async t => {
  const f = await fixture(t);
  const rules = await f.service.operation("redaction-rules");
  await f.service.operation("save-redaction-rules", { ...rules, customRules: [{ name: "项目代号", value: "海棠-42" }] });
  const { file, matches } = await f.redact();
  assert.equal(matches, 2);
  assert.equal(file.name, "项目资料-脱敏.txt");
  assert.equal(file.parent, parent);
  assert.equal(f.files.size, 1);
  assert.notEqual(file.id, itemId);
  assert.equal(Buffer.concat(f.uploads.get(file.id).parts).toString(), "邮箱 ****；项目 ****");
  assert.equal(f.bytes.toString(), "邮箱 test@example.invalid；项目 海棠-42");
});

test("no hits or non-files never create an upload", async t => {
  const f = await fixture(t, { content: "公开资料" });
  assert.deepEqual(await f.redact(), { file: null, matches: 0 });
  f.changeEntry({ kind: "folder" });
  await assert.rejects(f.redact(), { code: "SPACE_REDACTION_UNSUPPORTED" });
  assert.equal(f.requests.some(request => request.method !== "GET"), false);
});

test("Space discards an unfinished copy after commit failure", async t => {
  const f = await fixture(t, { failCommit: true });
  await assert.rejects(f.redact(), { code: "SPACE_DISK_FULL" });
  assert.equal(f.files.size, 0);
  assert.equal(f.uploads.size, 0);
});

test("a source change at upload time stops the copy before commit", async t => {
  const f = await fixture(t, { before: input => { if (input.method === "PUT") f.changeEntry({ version: 2 }); } });
  await assert.rejects(f.redact(), { code: "SPACE_REMOTE_FILE_CHANGED" });
  assert.equal(f.uploads.size, 0);
  assert.equal(f.requests.some(request => request.path.endsWith("/complete")), false);
});

test("switching accounts while reading the file never writes to either account", async t => {
  const f = await fixture(t, { before: input => { if (input.path.includes("/content")) f.switchAccount("other"); } });
  await assert.rejects(f.redact(), { code: "SPACE_CONTEXT_CHANGED" });
  assert.equal(f.requests.some(request => request.method !== "GET"), false);
});

test("a retry cancels an interrupted upload after restarting in the same account and space", async t => {
  let interrupt = true;
  const f = await fixture(t, { before: input => {
    if (interrupt && input.method === "PUT") { interrupt = false; f.switchAccount("other"); }
  } });
  await assert.rejects(f.redact(), { code: "SPACE_CONTEXT_CHANGED" });
  const [pendingId] = f.uploads.keys();
  assert.ok(pendingId);
  assert.equal(f.requests.some(request => request.method === "DELETE"), false);
  await f.restart();
  f.switchAccount("owner");
  const { file } = await f.redact();
  assert.equal(f.uploads.has(pendingId), false);
  assert.equal(f.files.size, 1);
  assert.ok(f.files.has(file.id));
});
