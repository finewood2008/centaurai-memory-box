import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import type { RegisterLocalDataRoutesOptions } from "./local-data.js";

export function registerMemoryBundleRoutes(app: FastifyInstance, options: RegisterLocalDataRoutesOptions): void {
  const { exportBundle, importBundle } = options.localData;
  if (exportBundle) app.get("/api/local-data/bundle", { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => reply.send(await exportBundle())));
  if (importBundle) app.post("/api/local-data/bundle/import", {
    preHandler: options.authenticateRuntimeToken, bodyLimit: 101 * 1024 * 1024,
  }, withErrorEnvelope(async (request, reply) => {
    const { bundle } = z.strictObject({
      bundle: z.object({
        schemaVersion: z.number().int().positive(),
        manifest: z.object({ service: z.literal("memmy-memory-service") }).passthrough(),
        tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
      }).passthrough(),
      conflictStrategy: z.literal("skip"),
    }).parse(request.body);
    return reply.send(await importBundle(bundle));
  }));
}
