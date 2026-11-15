/** Local data module. */
import {
  ClearLocalDataInputSchema,
  ExportLocalDataInputSchema,
  LocalDataClearResponseSchema,
  LocalDataExportResponseSchema,
  LocalDataRevealResponseSchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import type { LocalDataService } from "../../../../services/local-data-service.js";
import { registerMemoryBundleRoutes } from "./memory-bundle.js";

/** Contract for register local data routes options. */
export interface RegisterLocalDataRoutesOptions {
  localData: LocalDataService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers register local data routes. */
export function registerLocalDataRoutes(app: FastifyInstance, options: RegisterLocalDataRoutesOptions): void {
  registerMemoryBundleRoutes(app, options);
  const directoryInput = z.strictObject({ directory: z.string().min(1).max(4096) });
  const moveInput = z.union([
    directoryInput.extend({ id: z.uuid() }),
    z.strictObject({ id: z.uuid(), restoreFrom: z.string().min(1).max(4096) }),
    z.strictObject({ id: z.uuid(), rollback: z.literal(true) })
  ]);
  const { getWanxStorage, moveWanxStorage, snapshotWanxStorage } = options.localData ?? {};
  if (getWanxStorage && moveWanxStorage) {
    app.get("/api/local-data/wanx-storage", { preHandler: options.authenticateRuntimeToken },
      withErrorEnvelope(async (_request, reply) => reply.send(await getWanxStorage())));
    app.post("/api/local-data/wanx-storage", { preHandler: options.authenticateRuntimeToken },
      withErrorEnvelope(async (request, reply) => reply.send(await moveWanxStorage(moveInput.parse(request.body)))));
  }
  if (snapshotWanxStorage) {
    app.post("/api/local-data/wanx-storage/snapshot", { preHandler: options.authenticateRuntimeToken },
      withErrorEnvelope(async (request, reply) => reply.send(await snapshotWanxStorage(directoryInput.parse(request.body)))));
  }
  app.get(
    "/api/local-data",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = LocalDataRevealResponseSchema.parse(await options.localData.getPath());
      return reply.send(response);
    })
  );

  app.post(
    "/api/local-data/reveal",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = LocalDataRevealResponseSchema.parse(await options.localData.reveal());
      return reply.send(response);
    })
  );

  app.post(
    "/api/local-data/export",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = ExportLocalDataInputSchema.parse(request.body ?? {});
      const response = LocalDataExportResponseSchema.parse(await options.localData.export(input));
      return reply.send(response);
    })
  );

  app.delete(
    "/api/local-data",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = ClearLocalDataInputSchema.parse(request.body);
      const response = LocalDataClearResponseSchema.parse(await options.localData.clear(input));
      return reply.send(response);
    })
  );
}
