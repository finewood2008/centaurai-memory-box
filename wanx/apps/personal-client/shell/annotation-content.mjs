import { extname } from "node:path";
import { Worker } from "node:worker_threads";

export const ANNOTATION_CONTENT_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  zipEntries: 10_000,
  textCharacters: 32_768,
  timeoutMs: 30_000,
});

const supported = new Set(["txt", "md", "csv", "tsv", "json", "log", "html", "htm", "xml", "pdf", "docx", "xlsx", "pptx"]);
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
    let worker, done = false, timer;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const closed = worker ? worker.terminate().catch(() => {}) : Promise.resolve();
      void closed.then(() => {
        if (error) reject(error);
        else if (signal?.aborted) reject(canceled());
        else resolve(value);
      });
    };
    const abort = () => finish(canceled());
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      worker = new Worker(new URL("./annotation-content-worker.mjs", import.meta.url), {
        workerData: { name: entry.name, format, bytes: input, limits: ANNOTATION_CONTENT_LIMITS },
        transferList: [input.buffer], execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
      });
      timer = setTimeout(() => finish(null, result(format, "unsupported", "SPACE_ANNOTATION_EXTRACTION_TIMEOUT")), ANNOTATION_CONTENT_LIMITS.timeoutMs);
      worker.once("message", value => {
        if (!value || !["content", "name-only", "unsupported"].includes(value.mode) || value.format !== format ||
          typeof value.content !== "string" || value.content.length > ANNOTATION_CONTENT_LIMITS.textCharacters ||
          typeof value.truncated !== "boolean" || value.reason !== undefined && !/^SPACE_ANNOTATION_[A-Z0-9_]+$/.test(value.reason)) {
          finish(null, result(format, "unsupported", "SPACE_ANNOTATION_EXTRACTION_FAILED"));
        } else finish(null, value);
      });
      worker.once("error", () => finish(null, result(format, "unsupported", "SPACE_ANNOTATION_EXTRACTION_FAILED")));
      worker.once("exit", () => finish(null, result(format, "unsupported", "SPACE_ANNOTATION_EXTRACTION_FAILED")));
    } catch {
      finish(null, result(format, "unsupported", "SPACE_ANNOTATION_EXTRACTION_FAILED"));
    }
  });
}
