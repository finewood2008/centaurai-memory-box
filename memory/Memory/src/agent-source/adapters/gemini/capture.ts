import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

/** A completed Gemini turn, durably queued for the existing source scanner. */
export interface GeminiCapture {
  version: 1;
  id: string;
  sessionId: string;
  createdAt: string;
  workspacePath: string | null;
  prompt: string;
  response: string;
}

/** Also embedded in the standalone hook; do not add dependencies here. */
export function redactGeminiCaptureText(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:ssh_private_key]")
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED:authorization_bearer]")
    .replace(/\bsk-ant-api\d{2}-[A-Za-z0-9_-]{40,}\b/g, "[REDACTED:anthropic_api_key]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g, "[REDACTED:openai_api_key]")
    .replace(/\bAIza[A-Za-z0-9_-]{32,}\b/g, "[REDACTED:google_api_key]")
    .replace(/\b([A-Za-z0-9_]*password[A-Za-z0-9_]*\s*[:=]\s*)(?:"[^"\n]+"|'[^'\n]+'|[^\s#&]+)/gi, "$1[REDACTED:password]");
}

/** Validate the documented AfterAgent payload, without reading the transcript. */
export function normalizeGeminiCapture(payload: unknown, hash = createHash): GeminiCapture | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const item = payload as Record<string, unknown>;
  if (item.hook_event_name !== "AfterAgent" || typeof item.session_id !== "string" ||
      !item.session_id.trim() || item.session_id.length > 256 || typeof item.timestamp !== "string" ||
      !Number.isFinite(Date.parse(item.timestamp)) || typeof item.prompt !== "string" ||
      !item.prompt.trim() || typeof item.prompt_response !== "string" || !item.prompt_response.trim() ||
      Buffer.byteLength(item.prompt) + Buffer.byteLength(item.prompt_response) > 2 * 1024 * 1024) return null;
  const createdAt = new Date(item.timestamp).toISOString();
  const id = hash("sha256").update(JSON.stringify([
    item.session_id, createdAt, item.prompt, item.prompt_response,
  ])).digest("hex");
  return {
    version: 1, id, sessionId: item.session_id, createdAt,
    workspacePath: typeof item.cwd === "string" ? item.cwd : null,
    prompt: redactGeminiCaptureText(item.prompt), response: redactGeminiCaptureText(item.prompt_response),
  };
}

/** Atomic, private, idempotent queue publication. No service/network is needed. */
export async function saveGeminiCapture(directory: string, capture: GeminiCapture,
  io = { chmod, link, lstat, mkdir, open, rm, join, randomUUID }): Promise<void> {
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await io.lstat(directory)).isDirectory()) throw new Error("Invalid Gemini capture directory");
  await io.chmod(directory, 0o700);
  const temporary = io.join(directory, "." + io.randomUUID() + ".tmp");
  const target = io.join(directory, capture.id + ".json");
  try {
    const file = await io.open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(capture) + "\n"); await file.sync(); }
    finally { await file.close(); }
    try { await io.link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await io.lstat(target)).isFile()) throw error;
    }
  } finally { await io.rm(temporary, { force: true }); }
}
