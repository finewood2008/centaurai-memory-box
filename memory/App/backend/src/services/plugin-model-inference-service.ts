import { EmbeddingInferenceInputSchema, type EmbeddingInferenceInput, type EmbeddingInferenceOutput, type ModelSelectionResolution } from "@memmy/local-api-contracts";
import type { PluginHostServiceCall, PluginHostServiceInvoker } from "../adapters/outbound/plugin-runtime/index.js";
import { ModelInferenceInputSchema, inferTextModel, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS, type TextModelInferenceInput, type TextModelInferenceResult } from "./text-model-inference-service.js";

export type PluginModelInferenceInput = TextModelInferenceInput;
export type PluginModelInferenceResult = TextModelInferenceResult;

export interface CreatePluginModelInferenceServiceOptions {
  /** Resolves the model preset the calling plugin is allowed to reach, honouring its manifest model policy. */
  resolveModel: (pluginId: string, requestedPreset?: string) => Promise<ModelSelectionResolution | null>;
  embeddingInference?: (input: EmbeddingInferenceInput, options?: { signal?: AbortSignal }) => Promise<EmbeddingInferenceOutput>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

export function createPluginModelInferenceService(options: CreatePluginModelInferenceServiceOptions): PluginHostServiceInvoker {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async invoke(call) {
      throwIfCallerAborted(call.signal);
      if (call.service === "embedding-inference") {
        if (!options.embeddingInference) {
          throw serviceError("embedding_unavailable", "The current embedding model is not available to plugins", false);
        }
        const input = EmbeddingInferenceInputSchema.parse(call.input);
        try {
          return await raceWithAbort(options.embeddingInference(input, { signal: call.signal }), call.signal);
        } catch (error) {
          if (hasServiceErrorCode(error)) throw error;
          throw serviceError(
            "embedding_inference_failed",
            error instanceof Error ? error.message : "Embedding inference failed",
            true
          );
        }
      }
      if (call.service !== "model-inference") throw serviceError("host_service_unavailable", `Unknown Host service: ${call.service}`, false);
      const input = ModelInferenceInputSchema.parse(call.input);
      const selectionController = new AbortController();
      const selectionSignal = call.signal ? AbortSignal.any([call.signal, selectionController.signal]) : selectionController.signal;
      const selectionTimer = setTimeout(() => selectionController.abort(), Math.min(deadlineTimeout(call, options.timeoutMs ?? input.timeoutMs ?? DEFAULT_TIMEOUT_MS), input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      let resolved: ModelSelectionResolution | null;
      try {
        resolved = await raceWithAbort(options.resolveModel(call.pluginId, call.modelPreset), selectionSignal);
      } catch (error) {
        if (call.signal?.aborted) throw cancelledError();
        if (selectionController.signal.aborted) throw serviceError("model_inference_timeout", "Model selection timed out before a request was sent", true);
        throw error;
      } finally { clearTimeout(selectionTimer); }
      if (!resolved?.ok) throw serviceError("model_unavailable", "The current user model is not configured or available", false);
      const requestHeaders: Record<string, string> = call.pluginId === "literature-review" && resolved.context.protocol === "memmy-account" && resolved.context.model === "agent_chat"
        ? { "X-Agent-Task": "literature-review" } : {};
      const configuredAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      const maxAttempts = input.maxAttempts === undefined ? configuredAttempts : Math.min(configuredAttempts, input.maxAttempts);
      let lastError: unknown;
      let attemptInput = input;
      let remainingAttempts = maxAttempts;
      let usedJsonCompatibilityFallback = false;
      while (remainingAttempts > 0) {
        remainingAttempts -= 1;
        try {
          throwIfCallerAborted(call.signal);
          const timeoutMs = Math.min(
            deadlineTimeout(call, options.timeoutMs ?? attemptInput.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            attemptInput.timeoutMs ?? DEFAULT_TIMEOUT_MS
          );
          return await inferTextModel(resolved, attemptInput, input.responseFormat, fetchImpl, timeoutMs, call.signal, requestHeaders, "plugin_call_cancelled");
        } catch (error) {
          lastError = error;
          // Some OpenAI-compatible gateways occasionally return an empty choice
          // when response_format=json_object is requested. The prompt still asks
          // for JSON, so retrying without the transport-level JSON constraint is
          // a safe, single compatibility fallback. It is transport negotiation,
          // so it remains available even when the plugin disables ordinary retries.
          const canUseJsonFallback = !usedJsonCompatibilityFallback
            && serviceErrorCode(error) === "model_empty_response"
            && attemptInput.responseFormat === "json";
          if (canUseJsonFallback) {
            usedJsonCompatibilityFallback = true;
            attemptInput = { ...attemptInput, responseFormat: "text" };
            remainingAttempts += 1;
          } else if (remainingAttempts <= 0 || !isRetryableServiceError(error)) {
            throw error;
          }
          const baseDelayMs = Math.max(0, Math.min(30_000, options.retryBaseDelayMs ?? 250));
          const attemptsUsed = maxAttempts - remainingAttempts;
          const exponentialDelayMs = baseDelayMs * (2 ** Math.max(0, attemptsUsed - 1));
          const jitterMs = baseDelayMs > 0 ? Math.floor(Math.random() * Math.max(1, baseDelayMs * 0.2)) : 0;
          await abortableDelay(exponentialDelayMs + jitterMs, call.signal);
        }
      }
      throw lastError;
    }
  };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  throwIfCallerAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfCallerAborted(signal);
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function throwIfCallerAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): Error {
  return serviceError("plugin_call_cancelled", "The owning plugin call was cancelled", false);
}

function deadlineTimeout(call: PluginHostServiceCall, fallback: number): number {
  if (!call.deadline) return fallback;
  return Math.max(1, Math.min(fallback, Date.parse(call.deadline) - Date.now()));
}
function serviceError(code: string, message: string, retryable: boolean): Error { return Object.assign(new Error(message), { code, retryable }); }
function hasServiceErrorCode(error: unknown): error is Error & { code: string; retryable?: boolean } {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string";
}
function isRetryableServiceError(error: unknown): error is Error & { retryable: true } {
  return error instanceof Error && (error as Error & { retryable?: unknown }).retryable === true;
}
function serviceErrorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
}
