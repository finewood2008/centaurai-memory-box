// Main-process only. Renderer/Host SDK callers never provide this override.
export function validateApplicationConnectionOptions(options) {
  if (options === undefined) return undefined;
  const invalidContracts = value => !Array.isArray(value) || value.length > 32 || value.some(contract => {
    return !contract || typeof contract.id !== "string" || !/^[a-z][a-z0-9._-]{1,127}$/.test(contract.id) ||
      !Array.isArray(contract.features) || contract.features.some(feature => typeof feature !== "string" || !/^[a-z][a-z0-9._-]{1,127}$/.test(feature));
  });
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      !Object.keys(options).length || Object.keys(options).some(key => !["backendProductId", "launchId", "capabilities", "backendContracts"].includes(key)) ||
      (options.backendProductId !== undefined && !["wanx", "super-advisory"].includes(options.backendProductId)) ||
      (options.launchId !== undefined && (typeof options.launchId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(options.launchId)
        || Buffer.from(options.launchId, "base64url").toString("base64url") !== options.launchId)) ||
      (options.capabilities !== undefined && (!Array.isArray(options.capabilities) ||
        new Set(options.capabilities).size !== options.capabilities.length || options.capabilities.some(value =>
          !["identity.read", "experts.read", "experts.select", "http.request", "chat.stream", "files.upload"].includes(value)))) ||
      (options.backendContracts !== undefined && invalidContracts(options.backendContracts)))
    throw Object.assign(new Error("BOX_APPLICATION_SCOPE_FORBIDDEN"), { code: "BOX_APPLICATION_SCOPE_FORBIDDEN" });
  return Object.freeze({ ...(options.backendProductId !== undefined ? { backendProductId: options.backendProductId } : {}),
    ...(options.launchId !== undefined ? { launchId: options.launchId } : {}),
    ...(options.capabilities !== undefined ? { capabilities: Object.freeze([...options.capabilities]) } : {}),
    ...(options.backendContracts !== undefined ? { backendContracts: Object.freeze(options.backendContracts.map(contract => Object.freeze({
      id: contract.id, range: contract.range, features: Object.freeze([...contract.features]),
    }))) } : {}) });
}
