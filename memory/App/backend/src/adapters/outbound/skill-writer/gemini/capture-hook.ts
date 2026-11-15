import { normalizeGeminiCapture, redactGeminiCaptureText, saveGeminiCapture } from "@memmy/agent-source-readers/adapters/gemini/index";

/** Self-contained observation hook: a private spool replaces a fragile HTTP write. */
export function renderGeminiCaptureHook(capturesRoot: string): string {
  return `#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
${redactGeminiCaptureText.toString()}
${normalizeGeminiCapture.toString()}
${saveGeminiCapture.toString()}
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 3 * 1024 * 1024) throw new Error("Hook input too large");
  }
  const capture = normalizeGeminiCapture(JSON.parse(input), createHash);
  if (capture) await saveGeminiCapture(${JSON.stringify(capturesRoot)}, capture, { chmod, link, lstat, mkdir, open, rm, join, randomUUID });
} catch {
  process.stderr.write("MemoBox: Gemini turn was not queued; check local capture permissions.\\n");
}
// No decision, additionalContext, or continuation: never alter the host turn.
process.stdout.write("{}\\n");
`;
}
