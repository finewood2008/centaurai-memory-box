import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, rename, rm, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { workbenchFailure } from './workbench-errors.mjs';
import { onboardingActions, onboardingRequest, identityKey } from '../shared/onboarding-contract.mjs';
import {ontologyDialogueRequest} from '../shared/ontology-dialogue-contract.mjs';
import {conversationActions,conversationRequest,uploadBinding} from '../shared/conversation-contract.mjs';
import {starxiaotuIntentRequest,validateStarxiaotuDecision} from '../shared/starxiaotu-intent.mjs';

const fail = (code, message) =>
  Object.assign(new Error(message || code), { code, publicMessage: message });
const CHUNK = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const FORMATS = new Set([
  "txt",
  "md",
  "markdown",
  "docx",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "wav",
  "mp3",
  "m4a",
  "flac",
  "pptx",
  "xlsx",
  "xls",
  "xlsm",
]);
const resource = (value) => {
  if (typeof value !== "string" || !ID.test(value))
    throw fail("INVALID_RESOURCE");
  return encodeURIComponent(value);
};
export class SemanticaService {
  constructor({
    host,
    selectFiles,
    selectSkill,
    selectSave,
    emit = () => {},
  }) {
    this.host = host;
    this.selectFiles = selectFiles;
    this.selectSave = selectSave;
    this.selectSkill = selectSkill;
    this.emit = emit;
    this.invalid = false;
    this.warehouseGeneration = 0;
    this.context = null;
    this.localDataGateMode = null;
    this.files = new Map();
    this.controller = new AbortController();
    this.unsubscribe = host?.onSessionInvalidated(() => this.invalidate());
  }
  invalidate() {
    if (this.invalid) return;
    this.invalid = true;
    this.context = null;
    this.localDataGateMode = null;
    this.files.clear();
    this.controller.abort();
    this.emit({ type: "invalidated", code: "HOST_SESSION_EXPIRED" });
  }
  assertLive() {
    if (this.invalid) throw fail("HOST_SESSION_EXPIRED");
    if (!this.host) throw fail("WANX_HOST_REQUIRED");
  }
  async api(endpoint, { method = "GET", body, timeoutMs = 60000, workbench = false } = {}) {
    this.assertLive();
    let response;
    try {
      response = await this.host.request("/api/semantica" + endpoint, {
        method,
        body,
        signal: this.controller.signal,
        timeoutMs,
      });
    } catch (error) {
      if (this.invalid) throw fail("HOST_SESSION_EXPIRED");
      throw fail(
        error.code === "NETWORK_NOT_READY"
          ? "NETWORK_NOT_READY"
          : "SEMANTICA_CONNECTION_FAILED",
      );
    }
    this.assertLive();
    let value;
    try {
      value = await response.json();
    } catch {
      throw fail(
        response.status === 404
          ? "SEMANTICA_UPGRADE_REQUIRED"
          : "SEMANTICA_INVALID_RESPONSE",
      );
    }
    this.assertLive();
    if (!response.ok && workbench) throw workbenchFailure(value, response.status);
    if (!response.ok)
      throw fail(
        /^(?:SEMANTICA|WAREHOUSE|MIGRATION|ACCESS_KEY|MODEL|SKILL|REASONING|MCP)_[A-Z_]+$/.test(
          value.code || "",
        )
          ? value.code
          : response.status === 404
          ? "SEMANTICA_UPGRADE_REQUIRED"
          : "SEMANTICA_REQUEST_FAILED",
        /^(?:WAREHOUSE|MIGRATION|ACCESS_KEY|MODEL|SKILL|REASONING)_[A-Z_]+$/.test(value.code || "") &&
          typeof value.message === "string" &&
          value.message.length <= 200
          ? value.message
          : undefined,
      );
    return value;
  }
  async initialize() {
    this.assertLive();
    try {
      this.context = await this.host.context();
    } catch {
      throw fail("HOST_SESSION_EXPIRED");
    }
    this.assertLive();
    const [status, capabilities, warehouses, runtime] =
      await Promise.all([
        this.api("/status"),
        this.api("/capabilities"),
        this.api("/warehouses"),
        this.api("/warehouses/runtime"),
      ]);
    this.capabilities = capabilities;
    // Routing follows the verified backend response. The signed path and box
    // policy still decide authority; caller input never selects this mode.
    this.localDataGateMode = status.local_data_gate_mode === 'required' ? 'required' : null;
    return {
      identity: {
        accountId: this.context.accountId,
        dataScope: this.context.dataScope || "personal",
        boxId: this.context.boxId,
        boxName: this.context.boxName || this.context.deviceName || this.context.boxId,
        user: {
          id: this.context.user.id,
          name:
            this.context.user.display_name ||
            this.context.user.username ||
            "万象用户",
        },
        connection: this.context.connection,
      },
      status,
      capabilities,
      retrieval: null,
      warehouses,
      runtime,
    };
  }
  async choose(warehouseId, multiple = true, selectionMode = "standard") {
    this.assertLive();
    const selected = await this.selectFiles({multiple});
    this.assertLive();
    const result = [];
    for (const filePath of selected) {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      const name = path.basename(filePath),
        format = path.extname(name).slice(1).toLowerCase();
      const accepted = this.capabilities?.accepted_suffixes?.map((x) =>
        x.replace(/^\./, ""),
      ) || [...FORMATS];
      if (!accepted.includes(format))
        throw fail("SEMANTICA_FORMAT_NOT_SUPPORTED");
      if (
        info.size < 1 ||
        info.size >
          (this.capabilities?.document_max_bytes || 1024 * 1024 * 1024)
      )
        throw fail("SEMANTICA_FILE_TOO_LARGE");
      const existing = [...this.files.entries()].find(([, f]) => !f.result && f.path === filePath &&
        f.warehouseId === warehouseId && f.selectionMode === selectionMode && f.size === info.size && f.mtime === info.mtimeMs);
      const handle = existing?.[0] || randomUUID(),
        operation = randomUUID();
      if (!existing) this.files.set(handle, {
        path: filePath,
        name,
        size: info.size,
        mtime: info.mtimeMs,
        operation,
        external: randomUUID(),
        offset: 0,
        warehouseId,
        selectionMode,
      });
      if (!result.some(f => f.handle === handle)) result.push({ handle, name, size: info.size, format, source: "computer" });
    }
    this.assertLive();
    return result;
  }
  fileProblem(entry) {
    const format = path.extname(entry.name).slice(1).toLowerCase();
    const accepted = this.capabilities?.accepted_suffixes?.map(x => x.replace(/^\./, "")) || [...FORMATS];
    if (entry.kind !== "file" || entry.trashed != null) return "SPACE_NOT_FILE";
    if (!accepted.includes(format)) return "SEMANTICA_FORMAT_NOT_SUPPORTED";
    if (!Number.isSafeInteger(entry.size) || entry.size < 1) return "SPACE_EMPTY_FILE";
    if (entry.size > (this.capabilities?.document_max_bytes || 1024 ** 3)) return "SEMANTICA_FILE_TOO_LARGE";
    if (!/^[a-f0-9]{64}$/.test(entry.digest || "")) return "SPACE_CHUNK_INVALID";
    return null;
  }
  async spaceReady() {
    this.assertLive();
    if (!this.host.drive) throw fail("SPACE_UPGRADE_REQUIRED");
    await (this.spaceCapability ||= this.host.drive.overview({ signal: this.controller.signal }).catch(error => {
      this.spaceCapability = null;
      throw error;
    }));
    this.assertLive();
  }
  async spaceList(parent = "") {
    await this.spaceReady();
    const listing = await this.host.drive.list({ parent, signal: this.controller.signal });
    this.assertLive();
    return {
      parent: listing.parent,
      breadcrumbs: listing.breadcrumbs.map(({ id, name }) => ({ id, name })),
      items: listing.items.filter(e => e.trashed == null).map(e => this.describeSpaceItem(e)),
    };
  }
  describeSpaceItem(entry) {
    return {
      id: entry.id, name: entry.name, kind: entry.kind, size: entry.size, digest: entry.digest,
      format: path.extname(entry.name).slice(1).toLowerCase(),
      problem: entry.kind === "folder" ? null : this.fileProblem(entry),
    };
  }
  async chooseSpace(entries, warehouseId, selectionMode = "standard") {
    await this.spaceReady();
    if (!warehouseId || !Array.isArray(entries) || !entries.length || entries.length > 200)
      throw fail("INVALID_RESOURCE");
    // Stage selections before publishing any handles so one failed stat is atomic.
    const selected = [];
    for (const selection of entries) {
      const entry = await this.host.drive.stat(selection.id, { signal: this.controller.signal });
      this.assertLive();
      const problem = this.fileProblem(entry);
      if (problem) throw fail(problem);
      if (entry.digest !== selection.digest) throw fail("SPACE_REMOTE_FILE_CHANGED");
      selected.push(entry);
    }
    const result = [];
    for (const entry of selected) {
      const existing = [...this.files.entries()].find(([, f]) =>
        f.source === "space" && !f.result && f.warehouseId === warehouseId && f.selectionMode === selectionMode && f.id === entry.id && f.digest === entry.digest);
      const handle = existing?.[0] || randomUUID();
      const operation = randomUUID();
      if (!existing) this.files.set(handle, {
        source: "space", id: entry.id, name: entry.name, size: entry.size,
        digest: entry.digest, mtime: entry.modified, warehouseId, selectionMode,
        operation, offset: 0,
        external: "wanx-space:" + createHash("sha256").update(JSON.stringify([
          this.context?.accountId, this.context?.user?.id, this.context?.boxId,
        ])).digest("hex") + ":" + entry.id + ":" + entry.digest + ":" + operation,
      });
      if (!result.some(f => f.handle === handle)) result.push({
        handle, name: entry.name, size: entry.size, source: "space", spaceId: entry.id,
        format: path.extname(entry.name).slice(1).toLowerCase(),
      });
    }
    return result;
  }
  async validateFile(file) {
    this.assertLive();
    if (file.source === "space") {
      const entry = await this.host.drive.stat(file.id, { signal: this.controller.signal });
      this.assertLive();
      if (entry.kind !== "file" || entry.trashed != null || entry.size !== file.size ||
          entry.digest !== file.digest || entry.modified !== file.mtime || entry.name !== file.name)
        throw fail("SPACE_REMOTE_FILE_CHANGED");
    } else {
      const info = await stat(file.path);
      this.assertLive();
      if (info.size !== file.size || info.mtimeMs !== file.mtime) throw fail("SEMANTICA_LOCAL_FILE_CHANGED");
    }
  }
  async *fileChunks(file, offset) {
    if (file.source !== "space") {
      yield* createReadStream(file.path, { start: offset, highWaterMark: CHUNK });
      return;
    }
    // Drain even a fully uploaded retry to verify the source's complete digest.
    let seen = 0;
    const hash = createHash("sha256");
    for await (const chunk of this.host.drive.read(file.id, { signal: this.controller.signal })) {
      this.assertLive();
      hash.update(chunk);
      if (seen + chunk.length > file.size) throw fail("SPACE_REMOTE_FILE_CHANGED");
      let cursor = Math.min(chunk.length, Math.max(0, offset - seen));
      seen += chunk.length;
      while (cursor < chunk.length) {
        const end = Math.min(chunk.length, cursor + CHUNK);
        yield Buffer.from(chunk.buffer, chunk.byteOffset + cursor, end - cursor);
        cursor = end;
      }
    }
    if (seen !== file.size || hash.digest("hex") !== file.digest) throw fail("SPACE_REMOTE_FILE_CHANGED");
  }
  async upload(handle, warehouseId, binding = null) {
    this.assertLive();
    const file = this.files.get(handle);
    if (!file) throw fail("SEMANTICA_FILE_SELECTION_EXPIRED");
    if (file.warehouseId !== warehouseId)
      throw fail("SEMANTICA_FILE_SELECTION_EXPIRED");
    if(binding&&!warehouseId)throw fail('INVALID_RESOURCE');
    if(Object.hasOwn(file,'uploadBinding')&&JSON.stringify(file.uploadBinding)!==JSON.stringify(binding))
      throw fail('MODELING_OPERATION_CONFLICT');
    file.uploadBinding=binding;
    const prefix = warehouseId
      ? "/warehouses/" + resource(warehouseId)
      : "";
    const api = (endpoint, options) => this.api(prefix + endpoint, options);
    if (file.result) return file.result;
    await this.validateFile(file);
    let digest = file.digest;
    if (file.source !== "space") {
      const hash = createHash("sha256");
      for await (const data of createReadStream(file.path, { highWaterMark: CHUNK })) {
        this.assertLive();
        hash.update(data);
      }
      digest = hash.digest("hex");
    }
    this.emit({
      type: "upload",
      handle,
      state: "uploading",
      offset: 0,
      size: file.size,
    });
    const begun = await api("/imports", {
      method: "POST",
      body: {
        operation_id: file.operation,
        external_document_id: file.external,
        filename: file.name,
        size_bytes: file.size,
        sha256: digest,
        ...(binding || { source_review_required: true }),
      },
    });
    if (begun.document) {
      file.result = begun;
      return begun;
    }
    const uploadHandle = begun.upload_handle;
    resource(uploadHandle);
    let offset = Number(begun.offset ?? begun.received_bytes ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
      throw fail("SEMANTICA_INVALID_RESPONSE");
    if (offset < file.size || file.source === "space") {
      for await (const data of this.fileChunks(file, offset)) {
        this.assertLive();
        await api("/imports/" + uploadHandle, {
          method: "PATCH",
          body: {
            operation_id: file.operation,
            offset,
            content_base64: data.toString("base64"),
          },
        });
        offset += data.length;
        file.offset = offset;
        this.emit({
          type: "upload",
          handle,
          state: "uploading",
          offset,
          size: file.size,
        });
      }
    }
    await this.validateFile(file);
    let result;
    try {
      result = await api("/imports/" + uploadHandle + "/commit", {
        method: "POST",
        body: { operation_id: file.operation },
      });
    } catch (error) {
      this.assertLive();
      const reconciled = await api(
        "/operations/" + resource(file.operation),
      ).catch(() => null);
      if (reconciled?.status === "committed" && reconciled.result?.document)
        result = reconciled.result;
      else if (reconciled?.status === "committed" && reconciled.document)
        result = reconciled;
      else throw error;
    }
    file.result = result;
    this.emit({
      type: "upload",
      handle,
      state: "received",
      offset: file.size,
      size: file.size,
      documentId: result.document?.id,
    });
    return result;
  }
  async download(input) {
    const id = resource(input.id);
    this.assertLive();
    const prefix = input.warehouseId
      ? "/warehouses/" + resource(input.warehouseId)
      : "";
    const detail = await this.api(prefix + "/documents/" + id);
    const filename = path.basename(String(detail.document.original_name));
    const output = await this.selectSave(filename);
    if (!output) return { canceled: true };
    this.assertLive();
    const temporary = output + ".semantica-" + randomUUID() + ".tmp";
    const stream = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let offset = 0,
      total = null,
      revision = null,
      digest = null;
    try {
      while (total === null || offset < total) {
        const query = new URLSearchParams({
          offset: String(offset),
          length: String(CHUNK),
        });
        if (revision !== null) {
          query.set("expected_origin_revision", String(revision));
          query.set("expected_sha256", digest);
        }
        const chunk = await this.api(
          prefix + "/documents/" + id + "/blob?" + query,
        );
        if (total === null) {
          total = chunk.total_bytes;
          revision = chunk.origin_revision;
          digest = chunk.sha256;
          if (
            !Number.isSafeInteger(total) ||
            total < 0 ||
            total > 1024 * 1024 * 1024 ||
            !/^[a-f0-9]{64}$/.test(digest)
          )
            throw fail("SEMANTICA_INVALID_RESPONSE");
        }
        const bytes = Buffer.from(chunk.content_base64, "base64");
        if (
          chunk.offset !== offset ||
          chunk.total_bytes !== total ||
          chunk.sha256 !== digest ||
          bytes.length !== chunk.length ||
          bytes.length > CHUNK ||
          offset + bytes.length > total ||
          (!bytes.length && offset < total)
        )
          throw fail("SEMANTICA_INVALID_RESPONSE");
        hash.update(bytes);
        await stream.writeFile(bytes);
        offset += bytes.length;
      }
      this.assertLive();
      await stream.close();
      if (hash.digest("hex") !== digest)
        throw fail("SEMANTICA_DOWNLOAD_HASH_MISMATCH");
      this.assertLive();
      await rename(temporary, output);
      return { saved: true };
    } catch (error) {
      await stream.close().catch(() => {});
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async call(action, input = {}) {
    this.assertLive();
    if(action==='assistant-intent') {
      const {path,...options}=starxiaotuIntentRequest(input);
      const generation=this.warehouseGeneration;
      const before=await this.host.context();
      this.assertLive();
      if(generation!==this.warehouseGeneration)throw fail('WAREHOUSE_CHANGED');
      if(this.context && identityKey(before)!==identityKey(this.context)){this.invalidate();throw fail('HOST_SESSION_EXPIRED');}
      const result=await this.api(path,{...options,workbench:true});
      const after=await this.host.context();
      this.assertLive();
      if(identityKey(before)!==identityKey(after)){this.invalidate();throw fail('HOST_SESSION_EXPIRED');}
      if(generation!==this.warehouseGeneration)throw fail('WAREHOUSE_CHANGED');
      return validateStarxiaotuDecision(result);
    }
    if (onboardingActions.has(action) || conversationActions.has(action)) {
      const request = onboardingActions.has(action)?onboardingRequest(action, input):conversationRequest(action,input);
      const generation = this.warehouseGeneration;
      const before = await this.host.context();
      this.assertLive();
      if (generation !== this.warehouseGeneration) throw fail('WAREHOUSE_CHANGED');
      if (this.context && identityKey(before) !== identityKey(this.context)) {
        this.invalidate(); throw fail('HOST_SESSION_EXPIRED');
      }
      if ((before.dataScope || 'personal') !== 'personal')
        throw workbenchFailure({code:'MODELING_HOST_CREATION_REQUIRED'},403);
      const {path: endpoint, ...options} = request;
      const result = await this.api(endpoint, {...options, workbench:true});
      const after = await this.host.context();
      this.assertLive();
      if (identityKey(before) !== identityKey(after)) { this.invalidate(); throw fail('HOST_SESSION_EXPIRED'); }
      if (generation !== this.warehouseGeneration) throw fail('WAREHOUSE_CHANGED');
      return result;
    }
    const warehouse = input.warehouseId ? resource(input.warehouseId) : null;
    const api = (endpoint, options) =>
      this.api(
        (warehouse ? "/warehouses/" + warehouse : "") + endpoint,
        options,
      );
    const processingEndpoint = (suffix = '') => {
      if ((input.scope !== undefined && !['warehouse', 'default'].includes(input.scope)) || (input.scope === 'warehouse' && !warehouse))
        throw fail('INVALID_RESOURCE');
      if (this.localDataGateMode === 'required' && input.scope !== 'default' && warehouse) {
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(warehouse)) throw fail('INVALID_RESOURCE');
        return '/warehouses/' + warehouse + '/processing' + suffix;
      }
      return '/processing' + suffix;
    };
    if (["skills","skill","import-skill","download-skill","delete-skill"].includes(action) && !warehouse) throw fail("INVALID_RESOURCE");
    if (action === "workbench-request") {
      if (!warehouse || !/^\/api\/[A-Za-z0-9_/?=&%.,:+-]+$/.test(input.url || "")) throw fail("INVALID_RESOURCE");
      const url = new URL(input.url, "http://localhost"); url.searchParams.delete("workspace_id");
      const method = input.method || "GET";
      if (input.operationId !== undefined && (method !== "POST" || url.search || input.editor !== undefined ||
          !/^\/api\/ontologies(?:\/[A-Za-z0-9_-]{1,128}\/publish)?$/.test(url.pathname) ||
          typeof input.operationId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(input.operationId)))
        throw fail("INVALID_RESOURCE");
      const ontologyDialogue=ontologyDialogueRequest(url,method,input);
      if(ontologyDialogue){
        const generation=this.warehouseGeneration;
        const {path,...options}=ontologyDialogue;
        const result=await api(path,options);
        if(generation!==this.warehouseGeneration)throw fail('WAREHOUSE_CHANGED');
        return result;
      }
      if (url.pathname === '/api/owner/graph') {
        if (method !== 'GET' || input.body !== undefined || input.editor !== undefined) throw fail('INVALID_RESOURCE');
        for (const [key, value] of url.searchParams) {
          if (!['entity_id','limit'].includes(key) || url.searchParams.getAll(key).length !== 1 ||
              (key === 'entity_id' ? !/^[A-Za-z0-9_-]{1,128}$/.test(value) :
                !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)>500)) throw fail('INVALID_RESOURCE');
        }
        const generation = this.warehouseGeneration;
        const result = await api('/owner/graph' + url.search, {workbench:true});
        if (generation !== this.warehouseGeneration) throw fail('WAREHOUSE_CHANGED');
        return result;
      }
      if (method === 'DELETE') {
        const target = /^\/api\/documents\/([A-Za-z0-9_-]{1,128})$/.exec(input.url.split('?')[0]);
        const body = typeof input.body === 'string' ? JSON.parse(input.body) : null;
        if (!target || input.editor !== undefined || url.searchParams.toString() !== 'confirm=true' ||
            !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'operation_id' ||
            typeof body.operation_id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.operation_id)) throw fail('INVALID_RESOURCE');
        const generation = this.warehouseGeneration;
        const result = await api('/documents/' + resource(target[1]), {method: 'DELETE', body, workbench: true});
        if (generation !== this.warehouseGeneration) throw fail('WAREHOUSE_CHANGED');
        return result;
      }
      if (!["GET","POST","PUT","PATCH"].includes(method)) throw fail("INVALID_RESOURCE");
      const contentWrite = method === 'PATCH' && /^\/api\/documents\/([A-Za-z0-9_-]{1,128})\/content$/.exec(input.url.split('?')[0]);
      if (contentWrite) {
        const value = typeof input.body === 'string' ? JSON.parse(input.body) : null;
        if (url.search || input.editor !== undefined || !value ||
            Object.keys(value).sort().join(',') !== 'base_version_id,operation_id,segments' ||
            typeof value.operation_id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.operation_id) ||
            typeof value.base_version_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.base_version_id) ||
            !Array.isArray(value.segments)) throw fail('INVALID_RESOURCE');
        const generation = this.warehouseGeneration;
        const result = await api('/documents/' + contentWrite[1] + '/correction', {method: 'POST', workbench: true,
          body: {operation_id: value.operation_id, payload: {base_version_id: value.base_version_id, segments: value.segments}}});
        if (generation !== this.warehouseGeneration) throw fail('WAREHOUSE_CHANGED');
        return result;
      }
      const documentText = method === 'GET' && /^\/api\/documents\/([A-Za-z0-9_-]{1,128})\/text$/.exec(input.url.split('?')[0]);
      if (documentText) {
        if (input.body !== undefined || input.editor !== undefined) throw fail('INVALID_RESOURCE');
        for (const [key, value] of url.searchParams) {
          if (!['version_id','start','end'].includes(key) || url.searchParams.getAll(key).length !== 1 ||
              (key === 'version_id' ? !/^[A-Za-z0-9_-]{1,128}$/.test(value) :
                !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))) throw fail('INVALID_RESOURCE');
        }
        const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'));
        if (!url.searchParams.has('version_id') || !url.searchParams.has('start') || !url.searchParams.has('end') ||
            end < start || end - start > 65536) throw fail('INVALID_RESOURCE');
        const generation = this.warehouseGeneration;
        const result = await api('/documents/' + documentText[1] + '/text' + url.search, {workbench: true});
        if (generation !== this.warehouseGeneration) throw fail('WAREHOUSE_CHANGED');
        return result;
      }
      const documentDetail = method === "GET" && /^\/api\/documents\/([A-Za-z0-9_-]{1,128})$/.exec(input.url.split("?")[0]);
      if (documentDetail) {
        if (input.body !== undefined) throw fail("INVALID_RESOURCE");
        for (const [key, value] of url.searchParams) {
          if (!["segment_offset", "segment_limit", "block_offset", "block_limit"].includes(key) || url.searchParams.getAll(key).length !== 1 ||
              !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) ||
              Number(value) > (key === "segment_limit" ? 200 : key === 'block_limit' ? 500 : 2147483647) ||
              (key.endsWith('_limit') && Number(value) < 1)) throw fail("INVALID_RESOURCE");
        }
      }
      const body = input.body ? JSON.parse(input.body) : {}; delete body.workspace_id;
      const jobRetry = method === 'POST' && /^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/retry$/.exec(url.pathname);
      if (jobRetry) {
        if (url.search || Object.keys(body).some(key => key !== 'operation_id') || input.editor !== undefined) throw fail('INVALID_RESOURCE');
        const operationId = body.operation_id === undefined ? randomUUID() : resource(body.operation_id);
        const generation = this.warehouseGeneration;
        const result = await api('/jobs/' + jobRetry[1] + '/retry', {
          method, body: { operation_id: operationId }, workbench: true,
        });
        if (generation !== this.warehouseGeneration) throw fail('WAREHOUSE_CHANGED');
        return result;
      }
      const editor = input.editor;
      const editorTarget = /^\/api\/documents\/[A-Za-z0-9_-]+\/corrections(?:\/[A-Za-z0-9_/-]+)?$/.test(url.pathname) ||
        method === 'POST' && /^\/api\/knowledge-releases\/[A-Za-z0-9_-]+\/documents\/[A-Za-z0-9_-]+\/restore$/.test(url.pathname);
      if (editor !== undefined && (!editorTarget ||
          !editor || typeof editor !== 'object' || Array.isArray(editor) || Object.keys(editor).sort().join(',') !== 'generation,session' ||
          typeof editor.session !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(editor.session) ||
          typeof editor.generation !== 'string' || !/^[0-9]{1,12}$/.test(editor.generation))) throw fail("INVALID_RESOURCE");
      if (Object.hasOwn(body, '_native_editor')) throw fail("INVALID_RESOURCE");
      if (editor && method === 'GET') {
        const generation = this.warehouseGeneration;
        const result = await api('/workbench/_correction_read', {method: 'POST', timeoutMs: 330000, workbench: true,
          body: {path: url.pathname, query: Object.fromEntries(url.searchParams), _native_editor: editor, _native_operation_id: randomUUID()}});
        if (generation !== this.warehouseGeneration) throw fail("WAREHOUSE_CHANGED");
        return result;
      }
      if (editor) body._native_editor = editor;
      if (input.operationId !== undefined &&
          Object.keys(body).sort().join(',') !== (url.pathname === '/api/ontologies' ? 'name,schema' : ''))
        throw fail("INVALID_RESOURCE");
      if (method !== "GET") body._native_operation_id = input.operationId || body.operation_id || randomUUID();
      if (url.pathname === '/api/sensitive/settings') delete body.operation_id;
      const generation = this.warehouseGeneration;
      // The workbench automatically reads a selected ready material on every view.
      // Reuse the existing scoped typed read; do not widen the workbench facade.
      const endpoint = documentDetail ? "/documents/" + resource(documentDetail[1]) : "/workbench/" + url.pathname.slice(5);
      const result = await api(endpoint + url.search,{method,body:method === "GET" ? undefined : body,timeoutMs:330000,workbench:true});
      if (generation !== this.warehouseGeneration) throw fail("WAREHOUSE_CHANGED");
      return result;
    }
    switch (action) {
      case "select-warehouse":
        this.warehouseGeneration++;
        return {selected:true};
      case "skills":
        return api("/skills?limit=20&offset=" + (Number(input.offset) || 0) + "&keyword=" + encodeURIComponent(input.keyword || ""));
      case "skill":
        return api("/skills/" + resource(input.id) + "?path=" + encodeURIComponent(input.path || "SKILL.md"));
      case "import-skill": {
        const generation = this.controller, warehouseGeneration = this.warehouseGeneration;
        const selected = await this.selectSkill();
        this.assertLive();
        if (!selected?.length) return null;
        if (warehouseGeneration !== this.warehouseGeneration) throw fail("WAREHOUSE_CHANGED");
        const file = selected[0], info = await stat(file);
        if (!info.isFile() || !file.toLowerCase().endsWith(".zip") || info.size > 4 * 1024 * 1024) throw fail("SKILL_TOO_LARGE");
        const data = await readFile(file), after = await stat(file);
        if (data.length !== info.size || after.mtimeMs !== info.mtimeMs || generation !== this.controller) throw fail("SEMANTICA_LOCAL_FILE_CHANGED");
        return api("/skills/import", {method:"POST", body:{operation_id:input.operationId || randomUUID(),content_base64:data.toString("base64")}});
      }
      case "download-skill": {
        const warehouseGeneration = this.warehouseGeneration;
        const blob = await api("/skills/" + resource(input.id) + "/download");
        const data = Buffer.from(blob.content_base64,"base64");
        if (data.length > 8 * 1024 * 1024 || createHash("sha256").update(data).digest("hex") !== blob.sha256) throw fail("SEMANTICA_DOWNLOAD_HASH_MISMATCH");
        const target = await this.selectSave(path.basename(blob.filename));
        this.assertLive();
        if (warehouseGeneration !== this.warehouseGeneration) throw fail("WAREHOUSE_CHANGED");
        if (target) await writeFile(target,data);
        return {saved:!!target};
      }
      case "delete-skill":
        return api("/skills/" + resource(input.id) + "/delete", {method:"POST",body:{...input.confirmation,operation_id:input.operationId || randomUUID()}});
      case "processing":
        // The box validates this selector against the signed path in required mode.
        // Semantica uses it to select the project profile rather than the owner default.
        return this.api(processingEndpoint() + (input.scope === "default" || !warehouse ? "" : "?warehouse_id=" + warehouse));
      case "model-catalog":
        return this.api(processingEndpoint('/catalog'));
      case "check-models":
      case "save-models": {
        const selected = input.scope === "default" ? null : warehouse;
        if (this.localDataGateMode === 'required' && input.config?.warehouse_id !== undefined && input.config.warehouse_id !== selected)
          throw fail('INVALID_RESOURCE');
        return this.api(processingEndpoint(action === "check-models" ? "/check" : ""), {method: action === "check-models" ? "POST" : "PUT", body: {...input.config, warehouse_id: selected, operation_id: randomUUID()}, timeoutMs: 330000});
      }
      case "reprocess-models":
        return this.api("/processing/reprocess", {method:"POST",workbench:true,body:{operation_id:resource(input.operationId),warehouse_id:warehouse,documents:input.documents,expected_signature:input.expectedSignature}});
      case "initialize":
        return this.initialize();
      case "space-list":
        return this.spaceList(input.parent || "");
      case "select-space-files":
        return this.chooseSpace(input.entries, warehouse, input.selectionMode === "conversation" ? "conversation" : "standard");
      case "release-files":
        for (const handle of input.handles || []) {
          if (this.files.get(handle)?.warehouseId === warehouse) this.files.delete(handle);
        }
        return { released: true };
      case "select-files":
        return this.choose(warehouse, input.multiple !== false, input.selectionMode === "conversation" ? "conversation" : "standard");
      case "upload":
        return this.upload(resource(input.handle), warehouse, uploadBinding(input));
      case "warehouses":
        return this.api("/warehouses");
      case "warehouse-import-status": {
        const id = resource(input.warehouseId);
        const result = await this.api("/warehouses/transfers");
        const transfer = Array.isArray(result.items)
          ? result.items.find(item => item.kind === "import" && item.warehouse_id === id && item.state === "failed")
          : null;
        return { error: transfer?.error || null };
      }
      case "runtime":
        return this.api("/warehouses/runtime");
      case "create-warehouse":
        return this.api("/warehouses", {
          method: "POST",
          workbench: true,
          body: {
            operation_id: resource(input.operationId),
            name: input.name,
            description: input.description || "",
            ...(input.warehouseScope ? {warehouse_scope: input.warehouseScope} : {}),
          },
        });
      case "warehouse":
        return this.api("/warehouses/" + resource(input.id));
      case "keys":
        return api("/keys");
      case "create-key":
        return api("/keys", {
          method: "POST",
          body: {
            operation_id: resource(input.operationId),
            name: input.name,
            scopes: input.scopes ?? ["documents", "evidence", "graph", "reasoning", "search"],
            days: input.days,
          },
        });
      case "revoke-key":
        return api("/keys/" + resource(input.id) + "/revoke", {
          method: "POST",
          body: { operation_id: resource(input.operationId) },
        });
      case "prepare-clear":
        return api("/clear/prepare", {
          method: "POST",
          body: { operation_id: resource(input.operationId) },
        });
      case "prepare-delete":
        return api("/delete/prepare", {
          method: "POST",
          body: { operation_id: resource(input.operationId) },
        });
      case "delete-warehouse": {
        const result = await api("/delete", {
          method: "POST",
          body: { operation_id: resource(input.operationId),
            confirmation_token: input.token, typed_name: input.typedName },
        });
        for (const [handle, file] of this.files)
          if (file.warehouseId === warehouse) this.files.delete(handle);
        return result;
      }
      case "clear-warehouse": {
        const result = await api("/clear", {
          method: "POST",
          body: {
            operation_id: resource(input.operationId),
            confirmation_token: input.token,
            typed_name: input.typedName,
          },
        });
        for (const [handle, file] of this.files)
          if (file.warehouseId === warehouse) this.files.delete(handle);
        return result;
      }
      case "documents":
        return api(
          "/documents?" +
            new URLSearchParams({
              limit: "100",
              offset: String(input.offset || 0),
            }),
        );
      case "document":
        return api(
          "/documents/" +
            resource(input.id) +
            "?" +
            new URLSearchParams({
              segment_offset: String(input.offset || 0),
              segment_limit: "100",
            }),
        );
      case "document-text": {
        const start = input.start ?? 0, end = input.end;
        if (!warehouse || !Number.isSafeInteger(start) || start < 0 ||
          (end !== undefined && (!Number.isSafeInteger(end) || end <= start || end - start > 65536))) throw fail("INVALID_RESOURCE");
        const query = new URLSearchParams({version_id:resource(input.versionId), start:String(start)});
        if (end !== undefined) query.set("end", String(end));
        return api("/documents/" + resource(input.id) + "/text?" + query);
      }
      case "jobs":
        return api(
          "/jobs?" +
            new URLSearchParams({
              limit: "100",
              offset: String(input.offset || 0),
            }),
        );
      case "graph":
        return api("/owner/graph?limit=120");
      case "retrieval":
        return api("/retrieval/status");
      case "search":
        return api("/search", {
          method: "POST",
          body: {
            query: input.query,
            document_ids: input.documentIds || [],
            entity_types: input.entityTypes || [],
            limit: 10,
          },
          timeoutMs: 90000,
        });
      case "sensitive":
        return api("/sensitive/settings");
      case "save-sensitive":
        return api("/sensitive/settings", {
          method: "PUT",
          body: {
            operation_id: resource(input.operationId),
            payload: input.payload,
          },
        });
      case "correct":
        return api("/documents/" + resource(input.id) + "/correction", {
          method: "POST",
          body: {
            operation_id: resource(input.operationId),
            payload: {
              base_version_id: resource(input.versionId),
              segments: input.segments,
            },
          },
        });
      case "retry-job":
        return api("/jobs/" + resource(input.id) + "/retry", {
          method: "POST",
          body: { operation_id: resource(input.operationId) },
        });
      case "build-index":
        return api("/retrieval/indexes", {
          method: "POST",
          body: { operation_id: resource(input.operationId) },
        });
      case "download":
        return this.download(input);
      default:
        throw fail("SEMANTICA_OPERATION_NOT_ALLOWED");
    }
  }
  close() {
    this.invalid = true;
    this.unsubscribe?.();
    this.controller.abort();
    this.files.clear();
    this.host?.close();
  }
}
