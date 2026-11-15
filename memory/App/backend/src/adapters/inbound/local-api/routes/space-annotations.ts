import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SpaceAnnotationInferenceService } from "../../../../services/space-annotation-inference-service.js";

export function registerSpaceAnnotationRoutes(app: FastifyInstance, options: {
  spaceAnnotations?: SpaceAnnotationInferenceService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}): void {
  app.get("/api/app/space-annotations/models", { preHandler: options.authenticateRuntimeToken }, async (request, reply) => {
    if (!options.spaceAnnotations) return { available: false, presets: [], reason: "SPACE_ANNOTATION_MODEL_UNAVAILABLE" };
    return respond(request, reply, signal => options.spaceAnnotations!.models(signal));
  });
  app.post("/api/app/space-annotations/suggest", { preHandler: options.authenticateRuntimeToken, bodyLimit: 200_000 }, async (request, reply) => {
    if (!options.spaceAnnotations) return reply.code(503).send({ error: { code: "SPACE_ANNOTATION_MODEL_UNAVAILABLE" } });
    return respond(request, reply, signal => options.spaceAnnotations!.suggest(request.body, signal));
  });
}

async function respond(request: FastifyRequest, reply: FastifyReply, work: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => { if (!reply.raw.writableEnded) controller.abort(); };
  request.raw.once("aborted", abort); reply.raw.once("close", closed);
  try { return await work(controller.signal); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const statuses: Record<string, number> = {
      SPACE_ANNOTATION_INVALID: 400, SPACE_CONTEXT_CHANGED: 409,
      SPACE_ANNOTATION_MODEL_UNAVAILABLE: 503, SPACE_ANNOTATION_MODEL_TIMEOUT: 504,
      SPACE_ANNOTATION_MODEL_QUOTA: 402, SPACE_ANNOTATION_MODEL_CANCELED: 499,
      SPACE_ANNOTATION_MODEL_OUTPUT: 502, SPACE_ANNOTATION_MODEL_FAILED: 502
    };
    const safe = Object.hasOwn(statuses, code) ? code : "SPACE_ANNOTATION_MODEL_FAILED";
    return reply.code(statuses[safe]!).send({ error: { code: safe } });
  } finally { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", closed); }
}
