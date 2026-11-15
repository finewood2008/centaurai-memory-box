import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveGeminiHomeDirectory } from "../../agent-paths.js";
import { redactSecrets } from "../secret-redactor.js";
import type { ConversationMessage, SourceAdapter } from "../types.js";
import type { GeminiCapture } from "./capture.js";

export interface CreateGeminiSourceAdapterDeps { rootDirectory?: string; capturesRoot?: string }

/** Reads only our documented-hook captures, never Gemini private transcript formats. */
export function createGeminiSourceAdapter(deps: CreateGeminiSourceAdapterDeps = {}): SourceAdapter {
  const rootDirectory = deps.rootDirectory ?? resolveGeminiHomeDirectory();
  const capturesRoot = deps.capturesRoot ?? join(rootDirectory, "memobox-captures");
  const descriptor = Object.freeze({ sourceId: "gemini", displayName: "Gemini CLI", builtin: true, dataPath: capturesRoot });
  return {
    descriptor,
    async detect() {
      try { return (await lstat(rootDirectory)).isDirectory(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    },
    async *scan(options) {
      options.signal?.throwIfAborted();
      let names: string[];
      try {
        if (!(await lstat(capturesRoot)).isDirectory()) throw new Error("Invalid Gemini capture directory");
        names = (await readdir(capturesRoot)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const captures: GeminiCapture[] = [];
      for (const name of names) {
        options.signal?.throwIfAborted();
        const file = join(capturesRoot, name);
        const info = await lstat(file);
        if (!info.isFile() || info.size > 3 * 1024 * 1024) continue;
        try {
          const item = JSON.parse(await readFile(file, "utf8")) as GeminiCapture;
          if (item.version !== 1 || item.id + ".json" !== name || typeof item.sessionId !== "string" ||
              !item.sessionId || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) ||
              typeof item.prompt !== "string" || !item.prompt.trim() || typeof item.response !== "string" || !item.response.trim()) continue;
          captures.push(item);
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      captures.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      if (options.order === "recent_first") captures.reverse();
      const since = options.since && Date.parse(options.since);
      let emitted = 0;
      let conversations = 0;
      const sessions = new Set<string>();
      for (const capture of captures) {
        options.signal?.throwIfAborted();
        if (since && Date.parse(capture.createdAt) < since) continue;
        if (!sessions.has(capture.sessionId)) {
          if (options.maxScanTargets !== undefined && conversations >= options.maxScanTargets) continue;
          sessions.add(capture.sessionId); conversations += 1;
        }
        // Never emit half a captured turn when the scan's message budget is odd.
        if (options.maxMessages !== undefined && emitted + 2 > options.maxMessages) break;
        for (const role of ["user", "assistant"] as const) {
          yield {
            messageId: `${capture.id}:${role === "user" ? "0" : "1"}:${role}`, sourceId: "gemini", conversationId: capture.sessionId,
            role, content: redactSecrets(role === "user" ? capture.prompt : capture.response),
            createdAt: capture.createdAt,
            workspacePath: typeof capture.workspacePath === "string" && isAbsolute(capture.workspacePath) ? capture.workspacePath : null,
            gitRoot: null, rawMeta: Object.freeze({ captureId: capture.id, hookEvent: "AfterAgent" }),
          } satisfies ConversationMessage;
          emitted += 1;
        }
        options.onProgress?.({ sourceId: "gemini", phase: "emit", current: emitted, total: captures.length * 2 });
      }
      options.onProgress?.({ sourceId: "gemini", phase: "done", current: emitted, total: emitted });
    },
  };
}
