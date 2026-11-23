export const warehouseA = "a1c4c496-d58b-4b3c-b6d3-1b3d25c20110";
export const warehouseB = "b1c4c496-d58b-4b3c-b6d3-1b3d25c20110";
export const nativeTools = [
  ["xingtu_warehouse", {}],
  ["xingtu_search", { query: { type: "string", minLength: 1 }, limit: { type: "integer", default: 10 } }, ["query"]],
  ["xingtu_evidence", { evidence_id: { type: "string" } }, ["evidence_id"]],
  ["xingtu_reasoning_search", { arguments: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }, ["arguments"]],
].map(([name, properties, required = []]) => ({ name, description: "Native fixture " + name,
  annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties, required, additionalProperties: false } }));
export const nativeResult = data => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
export const nativeCatalog = (warehouses = [{ id: warehouseA }]) => ({ tools: nativeTools, warehouses });
