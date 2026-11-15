/** Session discovery module. */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonlObjects } from "../jsonl-lines.js";
import { readDirectoryIfExists } from "../read-directory.js";

export interface CodexSessionFile {
  /** Session file path. */
  sessionFilePath: string;
  workspacePath: string | null;
  gitRoot: string | null;
}

export interface DiscoverCodexSessionsOptions {
  /** Root. */
  root: string;
  order?: "path_asc" | "recent_first";
  maxSessions?: number;
  allowedOrigins?: ReadonlySet<string>;
}

/** Handles discover codex sessions. */
export async function discoverCodexSessions(options: DiscoverCodexSessionsOptions): Promise<CodexSessionFile[]> {
  const files = await listRolloutFiles(options.root, options.order ?? "path_asc", options.allowedOrigins ? undefined : options.maxSessions);
  const sessions: CodexSessionFile[] = [];

  for (const filePath of files) {
    if (sessions.length >= (options.maxSessions ?? Infinity)) break;
    const workspacePath = options.allowedOrigins ? await readScopedSession(filePath, options.allowedOrigins) : await readFirstCwd(filePath);
    if (workspacePath === undefined) continue;
    sessions.push({
      sessionFilePath: filePath,
      workspacePath,
      gitRoot: workspacePath ? findGitRoot(workspacePath) : null
    });
  }

  return sessions;
}

async function readScopedSession(filePath: string, allowedOrigins: ReadonlySet<string>): Promise<string | null | undefined> {
  try {
    for await (const record of readJsonlObjects(filePath)) {
      const payload = record.payload;
      if (record.type !== "session_meta" || !isRecord(payload) || typeof payload.originator !== "string" ||
          !allowedOrigins.has(payload.originator)) return undefined;
      return typeof payload.cwd === "string" ? payload.cwd : null;
    }
  } catch { /* An unreadable header cannot establish a source. */ }
}

/** Handles list rollout files. */
async function listRolloutFiles(
  root: string,
  order: "path_asc" | "recent_first",
  maxSessions: number | undefined
): Promise<string[]> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const directories = [root];

  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    const currentDirectory = directories[directoryIndex]!;
    const entries = await readDirectoryIfExists(currentDirectory);

    for (const entry of entries) {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }

      if (entry.isFile() && entry.name.startsWith("rollout-") && (entry.name.indexOf(".jsonl") === entry.name.length - 6) && !/\.jsonl\.bak-/u.test(entry.name)) {
        const fileStat = await stat(path);
        files.push({ path, mtimeMs: fileStat.mtimeMs });
      }
    }
  }

  return files
    .sort((left, right) => order === "recent_first"
      ? right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
      : left.path.localeCompare(right.path))
    .slice(0, maxSessions ?? files.length)
    .map((file) => file.path);
}

async function readFirstCwd(filePath: string): Promise<string | null> {
  try {
    for await (const record of readJsonlObjects(filePath)) {
      if (typeof record.cwd === "string") {
        return record.cwd;
      }

      if (isRecord(record.payload) && typeof record.payload.cwd === "string") {
        return record.payload.cwd;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function findGitRoot(workspacePath: string): string | null {
  let current = workspacePath;
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    current = dirname(current);
  }

  return existsSync(join(current, ".git")) ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
