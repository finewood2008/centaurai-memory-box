import { expect, test } from "vitest";
import { mergeFetchedProviderModels } from "./providerApi";

test("refresh fills missing model capacities and preserves manual fields", () => {
  const previous = [
    { id: "pro", name: "My Pro", enabled: true, max_tokens: 8192 },
    { id: "legacy-id", name: "Legacy ID", enabled: true },
  ];
  const remote = [
    { id: "pro", name: "Pro", context_window: 1048576, max_tokens: 393216, max_input_tokens: 700000 },
    { id: "flash", name: "Flash", context_window: 1048576, max_tokens: 393216 },
  ];
  const { models, changed } = mergeFetchedProviderModels(previous, remote);
  expect(changed).toBe(2);
  expect(models[0]).toEqual({ ...previous[0], context_window: 1048576, max_input_tokens: 700000 });
  expect(models[1]).toBe(previous[1]);
  expect(models[2]).toMatchObject({ ...remote[1], enabled: false });
  expect(mergeFetchedProviderModels(models, remote).changed).toBe(0);
});
