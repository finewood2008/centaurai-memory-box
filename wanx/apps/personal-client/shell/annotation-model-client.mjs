import { readMemoryConnection } from "./local-memory-runtime.mjs";
const fail = code => Object.assign(new Error(code), { code });

// Only the main process reads the loopback descriptor and its token. Neither
// the renderer nor the model output can choose a URL or a credential.
export function createAnnotationModelClient({ runtimeFile, ensureReady, getScope, request = fetch }) {
  async function call(route, body, signal) {
    const scope = getScope(), check = () => {
      if (!scope || scope !== getScope()) throw fail("SPACE_CONTEXT_CHANGED");
      if (signal?.aborted) throw fail("SPACE_ANNOTATION_CANCELED");
    };
    try {
      check(); await ensureReady?.(); check();
      const { base, token } = await readMemoryConnection(runtimeFile); check();
      const response = await request(new URL(`/api/app/space-annotations/${route}`, base), {
        method: body ? "POST" : "GET", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(130_000)]) : AbortSignal.timeout(130_000),
        headers: { "x-memmy-local-token": token, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }); check();
      const result = await response.json(); check();
      if (!response.ok) throw fail(result?.error?.code);
      if (!result || typeof result !== "object" || Array.isArray(result) || !Object.keys(result).length) throw fail("SPACE_ANNOTATION_MODEL_UNAVAILABLE");
      return result;
    } catch (cause) {
      check();
      const code = cause?.code || cause?.message;
      throw fail(typeof code === "string" && /^(?:SPACE_CONTEXT_CHANGED|SPACE_ANNOTATION_[A-Z0-9_]+)$/.test(code) ? code : "SPACE_ANNOTATION_MODEL_UNAVAILABLE");
    }
  }
  return { models: ({ signal } = {}) => call("models", null, signal), suggest: (input, { signal } = {}) => call("suggest", input, signal) };
}
