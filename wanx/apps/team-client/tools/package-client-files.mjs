import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const localIdentityEntry = /^(?:device-trust(?:\/|$)|local-ui\/device-trust(?:\/|$|-preload\.cjs$)|shell\/(?:device-trust-window|device-trust-lifecycle|identity-security|recovery-files|backup-files|wanx-mcp-knowledge)\.mjs$)|(?:^|\/)(?:identity-security\.json$|local-device-identity(?:\/|$))/;

// Inspect the actual archive so a future broad include cannot reintroduce the
// retired identity runtime or accidentally ship a developer's identity files.
export function assertCloudOnlyPackage(archive) {
  for (const file of require("@electron/asar").listPackage(archive)) {
    const relative = file.replaceAll("\\", "/").replace(/^\//, "");
    if (localIdentityEntry.test(relative)) throw new Error(`CLIENT_LOCAL_IDENTITY_PACKAGED:${relative}`);
  }
}
