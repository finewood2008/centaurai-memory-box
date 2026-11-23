export const ANNOTATION_WORKBENCH_CONTRACT = Object.freeze({ version: 1, operations: Object.freeze([
  "open", "list", "draft", "refresh-item", "prepare", "apply", "suggest", "skip-suggestions", "preview", "models",
  "pause", "resume", "cancel", "undo", "schemes", "save-scheme", "delete-scheme",
]) });
const fail = () => Object.assign(new Error("SPACE_ANNOTATION_INVALID"), { code: "SPACE_ANNOTATION_INVALID" });
export function validateWorkbenchInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !ANNOTATION_WORKBENCH_CONTRACT.operations.includes(input.op)) throw fail();
  const fields = {
    open: ["space_id", "parent", "ids", "recursive", "fresh"], list: ["jobId", "offset", "limit", "query", "type", "status"],
    draft: ["jobId", "id", "patch", "expectedRevision"], "refresh-item": ["jobId", "id", "discardDraft"], prepare: ["jobId", "selection", "change", "useDrafts", "acceptSuggestions"],
    apply: ["jobId", "planId"], suggest: ["jobId", "selection", "modelPresetId", "instructions", "schemeId"],
    "skip-suggestions": ["jobId", "selection"],
    preview: ["jobId", "id"], models: [], pause: ["jobId"], resume: ["jobId"], cancel: ["jobId"], undo: ["jobId"],
    schemes: [], "save-scheme": ["scheme"], "delete-scheme": ["id"],
  }[input.op];
  if (Object.keys(input).some(key => key !== "op" && !fields.includes(key))) throw fail();
  for (const field of ["jobId", "planId", "id"]) if (input[field] !== undefined && (typeof input[field] !== "string" || !/^[a-f0-9]{32}$/.test(input[field]))) throw fail();
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) throw fail();
  return input;
}
