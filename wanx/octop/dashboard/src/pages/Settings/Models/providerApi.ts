import { request } from "../../../api/request";
import type { ProviderModel } from "./useProviders";

export interface TestProviderDraftParams {
  name: string;
  kind: string;
  api_key?: string;
  base_url?: string | null;
  model_id: string;
  extra_json?: string | null;
  embedding?: boolean;
}

export interface TestProviderResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

export async function testProviderDraft(
  params: TestProviderDraftParams,
): Promise<TestProviderResult> {
  return request<TestProviderResult>("/admin/providers/test-draft", {
    method: "POST",
    body: JSON.stringify({
      name: params.name,
      kind: params.kind,
      api_key: params.api_key?.trim() || null,
      base_url: params.base_url?.trim() || null,
      model_id: params.model_id,
      extra_json: params.extra_json ?? null,
      embedding: params.embedding === true,
    }),
  });
}

export interface FetchProviderModelsParams {
  kind: string;
  api_key?: string;
  base_url?: string | null;
  extra_json?: string | null;
  name?: string | null;
}

export interface FetchedProviderModel {
  id: string;
  name: string;
  context_window?: number;
  max_tokens?: number;
  max_input_tokens?: number;
}

export interface FetchProviderModelsResult {
  ok: boolean;
  models?: FetchedProviderModel[];
  error?: string;
}

export function mergeFetchedProviderModels(
  existing: ProviderModel[],
  fetched: FetchedProviderModel[],
): { models: ProviderModel[]; changed: number } {
  let changed = 0;
  const byId = new Map(fetched.map((model) => [model.id, model]));
  const models = existing.map((model) => {
    const remote = byId.get(model.id);
    byId.delete(model.id);
    if (!remote) return model;
    const capacity: Partial<ProviderModel> = {};
    for (const key of ["context_window", "max_tokens", "max_input_tokens"] as const) {
      if (model[key] == null && remote[key] != null) capacity[key] = remote[key];
    }
    if (Object.keys(capacity).length === 0) return model;
    changed += 1;
    return { ...model, ...capacity };
  });
  for (const remote of byId.values()) {
    models.push({
      ...remote,
      name: remote.name || remote.id,
      enabled: false,
      input: ["text"],
      thinking: null,
    });
    changed += 1;
  }
  return { models, changed };
}

export async function fetchProviderModels(
  params: FetchProviderModelsParams,
): Promise<FetchProviderModelsResult> {
  return request<FetchProviderModelsResult>("/admin/providers/fetch-models", {
    method: "POST",
    body: JSON.stringify({
      kind: params.kind,
      api_key: params.api_key?.trim() || null,
      base_url: params.base_url?.trim() || null,
      extra_json: params.extra_json ?? null,
      name: params.name?.trim() || null,
    }),
  });
}

export async function startCodexOAuth() {
  return request<{
    state_id: string;
    user_code: string;
    verification_url: string;
  }>("/admin/providers/codex-oauth/start", { method: "POST" });
}

export async function pollCodexOAuth(stateId: string) {
  return request<{
    status: string;
    error?: string;
    provider_id?: number;
    provider_name?: string;
  }>(`/admin/providers/codex-oauth/pending/${encodeURIComponent(stateId)}`);
}
