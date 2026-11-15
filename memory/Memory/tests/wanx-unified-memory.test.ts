import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../src/storage/db.js";
import { bindWanxSourceProfile, prepareWanxRestore, unifyWanxSourceProfile } from "../src/server/wanx-storage.js";

describe("unified local memory upgrade", () => {
  it.each(["codex-desktop", "codex-cli"])("preserves all rows and a rollback snapshot when upgrading %s", async profile => {
    const root = mkdtempSync(join(tmpdir(), "memobox-unify-"));
    const database = new MemoryDb({ path: join(root, "current.sqlite") });
    try {
      bindWanxSourceProfile(database, profile, true);
      database.db.exec("CREATE TABLE synthetic_memory (id TEXT PRIMARY KEY, body TEXT)");
      database.db.prepare("INSERT INTO synthetic_memory VALUES (?, ?)").run("turn-1", "synthetic committed WAL text");
      const previous = await unifyWanxSourceProfile(database, join(root, "rollback"));
      expect(previous).toBeTruthy();
      expect(database.db.prepare("SELECT COUNT(*) AS n FROM wanx_memory_source").get()).toEqual({ n: 0 });
      expect(database.db.prepare("SELECT * FROM synthetic_memory").get()).toEqual({ id: "turn-1", body: "synthetic committed WAL text" });
      expect(() => bindWanxSourceProfile(database, undefined, false)).not.toThrow();
      database.db.prepare("UPDATE synthetic_memory SET body=?").run("new mixed-store write");
      const snapshot = new MemoryDb({ path: previous, readonly: true });
      try {
        expect(snapshot.db.prepare("SELECT profile FROM wanx_memory_source").get()).toEqual({ profile });
        expect(snapshot.db.prepare("SELECT body FROM synthetic_memory").get()).toEqual({ body: "synthetic committed WAL text" });
      } finally { snapshot.close(); }
      expect(await unifyWanxSourceProfile(database, join(root, "rollback"))).toBeUndefined();
      await expect(prepareWanxRestore(previous, root)).rejects.toThrow(/备份/);
      const restored = await prepareWanxRestore(previous, root, undefined, true);
      const candidate = new MemoryDb({ path: restored, readonly: true });
      try {
        expect(candidate.db.prepare("SELECT COUNT(*) AS n FROM wanx_memory_source").get()).toEqual({ n: 0 });
        expect(candidate.db.prepare("SELECT body FROM synthetic_memory").get()).toEqual({ body: "synthetic committed WAL text" });
      } finally { candidate.close(); }
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("never promotes an unknown profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "memobox-unify-unknown-"));
    const database = new MemoryDb({ path: join(root, "current.sqlite") });
    try {
      bindWanxSourceProfile(database, "foreign", true);
      await expect(unifyWanxSourceProfile(database, root)).rejects.toThrow(/Unknown/);
      expect(database.db.prepare("SELECT profile FROM wanx_memory_source").get()).toEqual({ profile: "foreign" });
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
