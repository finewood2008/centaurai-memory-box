/** Local data service module. */
import { join } from "node:path";
import {
  LocalDataClearResponseSchema,
  LocalDataExportResponseSchema,
  LocalDataRevealResponseSchema,
  type ClearLocalDataInput,
  type LocalDataClearResponse,
  type ExportLocalDataInput,
  type LocalDataExportResponse,
  type LocalDataRevealResponse
} from "@memmy/local-api-contracts";
import type { LocalDataStore } from "../infrastructure/app-state-store/local-data-store.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";

export interface LocalDataService {
  getPath(): Promise<LocalDataRevealResponse>;
  reveal(): Promise<LocalDataRevealResponse>;
  export(input: ExportLocalDataInput): Promise<LocalDataExportResponse>;
  clear(input: ClearLocalDataInput): Promise<LocalDataClearResponse>;
  getWanxStorage?: NonNullable<MemoryClient["getWanxStorage"]>;
  moveWanxStorage?: NonNullable<MemoryClient["moveWanxStorage"]>;
  snapshotWanxStorage?: NonNullable<MemoryClient["snapshotWanxStorage"]>;
}

export interface CreateLocalDataServiceOptions {
  localDataStore: LocalDataStore;
  memoryClient: MemoryClient;
}

/** Creates create local data service. */
export function createLocalDataService(options: CreateLocalDataServiceOptions): LocalDataService {
  const getPathResponse = async (): Promise<LocalDataRevealResponse> => LocalDataRevealResponseSchema.parse({
    ok: true,
    dataPath: (await options.memoryClient.getWanxStorage?.().catch(() => null))?.dataPath
      ?? options.localDataStore.getDataPath()
  });

  return {
    getWanxStorage: options.memoryClient.getWanxStorage?.bind(options.memoryClient),
    moveWanxStorage: options.memoryClient.moveWanxStorage?.bind(options.memoryClient),
    snapshotWanxStorage: options.memoryClient.snapshotWanxStorage?.bind(options.memoryClient),
    async getPath() {
      return getPathResponse();
    },

    async reveal() {
      const response = await getPathResponse();
      await options.localDataStore.revealDataPath(response.dataPath);
      return response;
    },

    async export(input) {
      if (!options.memoryClient.exportBundle) throw new Error("Memory export API is unavailable");
      const bundle = await options.memoryClient.exportBundle();
      const storage = input.targetPath ? null : await options.memoryClient.getWanxStorage?.().catch(() => null);
      return LocalDataExportResponseSchema.parse(options.localDataStore.exportData(
        storage?.configured ? { targetPath: join(storage.dataPath, "exports") } : input, bundle
      ));
    },

    async clear(_input) {
      if (!options.memoryClient.clearAllData) throw new Error("Memory clear API is unavailable");
      const result = await options.memoryClient.clearAllData();
      options.localDataStore.clearImportState();
      return LocalDataClearResponseSchema.parse({
        ok: true,
        clearedAt: result.clearedAt
      });
    }
  };
}
