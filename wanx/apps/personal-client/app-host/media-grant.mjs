// The scoped grant belongs only to the media service. Match its literal route
// grammar so a request for another service never receives this credential.
export function acceptsMediaGrant(path) {
  const route = path.split("?", 1)[0];
  return (
    /^\/api\/services\/wanx\.media\/v1\/(?:capabilities|asr\/sessions|delegations(?:\/[A-Za-z0-9_-]+)?|grant\/self|jobs(?:\/[A-Za-z0-9_-]+(?:\/(?:input|submit|result|retry))?)?)$/.test(route) ||
    /^\/api\/services\/wanx\.media\/v1\/(?:summaries|summary-templates(?:\/(?:default|builtin-default|[a-f0-9]{32}))?)$/.test(route)
  );
}

export function isMediaAsrStream(path) {
  return /^\/api\/services\/wanx\.media\/v1\/asr\/sessions\/[a-f0-9]{32}\/stream$/.test(path);
}
import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const FOREGROUND_MEDIA_PREFIX = "media_foreground_";

export function acceptsForegroundMediaGrant(url) {
  const route = url.split("?", 1)[0];
  return acceptsMediaGrant(route) && !/\/v1\/(?:delegations(?:\/|$)|grant\/self$)/.test(route);
}

// Only the installed application's Host supplies this credential. Persist a
// single seed so each app can resume its own jobs across Host restarts.
export function createForegroundMediaGrantReader(applicationRoot) {
  const filename = path.join(applicationRoot, ".media-foreground-key");
  let seed;

  async function readOrCreateSeed() {
    async function read() {
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size !== 32 || (process.platform !== "win32" && (info.mode & 0o077)))
          throw new Error("Invalid foreground media key file");
        const value = Buffer.alloc(32);
        if ((await file.read(value, 0, value.length, 0)).bytesRead !== value.length)
          throw new Error("Incomplete foreground media key file");
        return value;
      } finally { await file.close(); }
    }

    try { return await read(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(applicationRoot, { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(path.join(applicationRoot, ".media-foreground-"));
    try {
      const prepared = path.join(stage, "key");
      await writeFile(prepared, randomBytes(32), { mode: 0o600, flag: "wx" });
      try { await link(prepared, filename); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      return await read();
    } finally { await rm(stage, { recursive: true, force: true }); }
  }

  return async applicationId => {
    seed ||= readOrCreateSeed().catch(error => { seed = undefined; throw error; });
    return FOREGROUND_MEDIA_PREFIX + createHmac("sha256", await seed).update(applicationId).digest("base64url");
  };
}
