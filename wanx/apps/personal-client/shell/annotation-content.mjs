import { fork } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export const ANNOTATION_CONTENT_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  zipEntries: 10_000,
  textCharacters: 32_768,
  timeoutMs: 30_000,
});

const supported = new Set(["txt", "md", "csv", "tsv", "json", "log", "html", "htm", "xml", "pdf", "docx", "xlsx", "pptx"]);
export const supportsAnnotationContent = name => typeof name === "string" && supported.has(extname(name).slice(1).toLowerCase());
const images = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "bmp", "svg"]);
const canceled = () => Object.assign(new Error("SPACE_ANNOTATION_CANCELED"), { code: "SPACE_ANNOTATION_CANCELED" });
const result = (format, mode, reason) => ({ content: "", mode, format, truncated: false, reason });

// Callers obtain and verify bytes through the current authorized space lease.
// No path, URL, provider credentials, or document code reaches the extractor.
export async function extractAnnotationContent({ entry, bytes, signal } = {}) {
  if (signal?.aborted) throw canceled();
  if (typeof entry?.name !== "string" || !entry.name || entry.name.length > 1000 || /[\\/\0]/.test(entry.name))
    return result("unknown", "unsupported", "SPACE_ANNOTATION_CONTENT_INVALID_INPUT");
  const format = extname(entry.name).slice(1).toLowerCase() || "unknown";
  if (entry.kind === "folder") return result("folder", "name-only", "SPACE_ANNOTATION_FOLDER_NAME_ONLY");
  if (images.has(format)) return result(format, "name-only", "SPACE_ANNOTATION_IMAGE_NO_OCR");
  if (!supported.has(format)) return result(format, "name-only", "SPACE_ANNOTATION_CONTENT_UNSUPPORTED");
  if (bytes === undefined || bytes === null) return result(format, "name-only", "SPACE_ANNOTATION_CONTENT_NOT_READ");
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer))
    return result(format, "unsupported", "SPACE_ANNOTATION_CONTENT_INVALID_INPUT");
  const length = bytes.byteLength;
  if (length > ANNOTATION_CONTENT_LIMITS.inputBytes)
    return result(format, "unsupported", "SPACE_ANNOTATION_CONTENT_TOO_LARGE");
  if (!length) return result(format, "name-only", "SPACE_ANNOTATION_CONTENT_EMPTY");

  // Copy before transferring so a caller's verified source buffer is intact.
  const input = Uint8Array.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  return new Promise((resolve, reject) => {
    let done = false, timer;
    let close = async () => {};
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void close().then(() => {
        if (error) reject(error);
        else if (signal?.aborted) reject(canceled());
        else resolve(value);
      });
    };
    const abort = () => finish(canceled());
    const failed = () => finish(null, result(format, "unsupported", "SPACE_ANNOTATION_EXTRACTION_FAILED"));
    const receive = value => {
      if (!value || !["content", "name-only", "unsupported"].includes(value.mode) || value.format !== format ||
        typeof value.content !== "string" || value.content.length > ANNOTATION_CONTENT_LIMITS.textCharacters ||
        typeof value.truncated !== "boolean" || value.reason !== undefined && !/^SPACE_ANNOTATION_[A-Z0-9_]+$/.test(value.reason)) failed();
      else finish(null, value);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      const entrypoint = new URL("./annotation-content-worker.mjs", import.meta.url);
      const request = { format, bytes: input, limits: ANNOTATION_CONTENT_LIMITS };
      // pdf.js loads a native canvas module whose Windows worker teardown can
      // crash the host. Keep that native code in a disposable process.
      if (process.platform === "win32" && format === "pdf") {
        const child = fork(fileURLToPath(entrypoint), [], {
          env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ELECTRON_RUN_AS_NODE: "1" },
          execArgv: ["--max-old-space-size=256", "--max-semi-space-size=16"],
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
        });
        const closed = new Promise(resolveClose => child.once("close", resolveClose));
        close = async () => { child.kill(); await closed; };
        child.once("message", receive);
        child.once("error", failed);
        child.once("close", failed);
        child.send(request, error => { if (error) failed(); });
      } else {
        const worker = new Worker(entrypoint, {
          workerData: request, transferList: [input.buffer], execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
        });
        close = async () => { await worker.terminate().catch(() => {}); };
        worker.once("message", receive);
        worker.once("error", failed);
        worker.once("exit", failed);
      }
      timer = setTimeout(() => finish(null, result(format, "unsupported", "SPACE_ANNOTATION_EXTRACTION_TIMEOUT")), ANNOTATION_CONTENT_LIMITS.timeoutMs);
    } catch {
      failed();
    }
  });
}
