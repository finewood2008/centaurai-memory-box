// Signed client policy only. Box OS contracts remain exact-version contracts.
const fail = () => { throw Object.assign(new Error("CONTRACT_UNSUPPORTED"), { code: "CONTRACT_UNSUPPORTED" }); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, min, max = 2147483647) => Number.isSafeInteger(value) && value >= min && value <= max;

export function validateClientOsPolicy(policy, os) {
  if (os === "darwin") {
    if (!exact(policy, ["kind", "majors"]) || policy.kind !== "macos-product-majors" ||
        !Array.isArray(policy.majors) || !policy.majors.length || policy.majors.length > 64 ||
        policy.majors.some((major, i) => !integer(major, 1, 999) || i > 0 && major <= policy.majors[i - 1])) fail();
  } else if (os === "win32") {
    if (!exact(policy, ["kind", "ranges"]) || policy.kind !== "windows-build-ranges" ||
        !Array.isArray(policy.ranges) || !policy.ranges.length || policy.ranges.length > 32) fail();
    for (const [i, range] of policy.ranges.entries()) {
      if (!exact(range, ["family", "minBuild", "maxBuild"]) ||
          !["windows10", "windows11"].includes(range.family) ||
          !integer(range.minBuild, range.family === "windows10" ? 10240 : 22000) ||
          !integer(range.maxBuild, range.minBuild, range.family === "windows10" ? 19045 : 2147483647) ||
          i > 0 && range.minBuild <= policy.ranges[i - 1].maxBuild) fail();
    }
  } else fail();
  return policy;
}

export function validateClientReleasePolicies(release) {
  if (Object.hasOwn(release, "clientOsPolicy")) {
    if (release.product !== "wanx-client") fail();
    validateClientOsPolicy(release.clientOsPolicy, release.platform?.os);
  }
  if (Object.hasOwn(release, "applicationCompatibilityPolicy") &&
      (release.product !== "wanx-client" || release.hostProtocol !== 1 || release.dataPolicy !== "backward-compatible" ||
       !exact(release.applicationCompatibilityPolicy, ["mode"]) ||
       release.applicationCompatibilityPolicy.mode !== "host-protocol-backward-compatible")) fail();
}

function versionParts(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,9})(?:\.(?:0|[1-9]\d{0,9})){0,3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(part => integer(part, 0)) ? parts : null;
}

export function matchesClientPlatform(release, current) {
  if (release.platform?.os !== current.platform || release.platform.arch !== current.arch) return false;
  if (Object.hasOwn(current, "osProductVersion") && (current.platform !== "darwin" ||
      typeof current.osProductVersion !== "string" || !current.osProductVersion.length || current.osProductVersion.length > 256)) return false;
  if (Object.hasOwn(current, "windowsProductType") && (current.platform !== "win32" || !integer(current.windowsProductType, 0, 3))) return false;
  if (current.platform === "win32" && Object.hasOwn(current, "windowsProductType") && current.windowsProductType !== 1) return false;
  if (Object.hasOwn(release, "clientOsPolicy")) {
    try { validateClientOsPolicy(release.clientOsPolicy, release.platform.os); } catch { return false; }
    const policy = release.clientOsPolicy;
    if (current.platform === "darwin" && Object.hasOwn(current, "osProductVersion")) {
      const parts = versionParts(current.osProductVersion);
      return Boolean(parts && parts.length <= 3 && policy.majors.includes(parts[0]));
    }
    if (current.platform === "win32" && Object.hasOwn(current, "windowsProductType")) {
      const parts = versionParts(current.osVersion);
      if (!parts || parts.length < 3 || parts[0] !== 10 || parts[1] !== 0) return false;
      const build = parts[2], family = build >= 22000 ? "windows11" : build >= 10240 && build <= 19045 ? "windows10" : null;
      return policy.ranges.some(range => range.family === family && build >= range.minBuild && build <= range.maxBuild);
    }
  }
  // A missing runtime fact identifies the old request contract. Invalid new
  // facts above never reach this transition-only exact matching path.
  return Boolean(release.supportedOsVersions?.includes(current.osVersion));
}

export function clientPlatformFacts(current) {
  return { os: current.platform, arch: current.arch, osVersion: current.osVersion,
    ...(current.platform === "darwin" && Object.hasOwn(current, "osProductVersion") ? { osProductVersion: current.osProductVersion } : {}),
    ...(current.platform === "win32" && Object.hasOwn(current, "windowsProductType") ? { windowsProductType: current.windowsProductType } : {}) };
}
