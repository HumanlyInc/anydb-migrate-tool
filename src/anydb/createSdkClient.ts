import { SdkMigrationClient } from "./sdkClient.js";
import type { MigrationConfig } from "../types/config.js";

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}; set it in the YAML anydb section or the corresponding environment variable`);
  return value;
}

export interface CreateSdkClientOptions {
  verbose?: boolean;
  requestsPerMinute?: string | number;
}

function requestRate(value: string | number | undefined): number {
  const parsed = value === undefined ? 100 : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Requests per minute must be a number greater than zero");
  }
  return parsed;
}

export function createSdkClient(config: MigrationConfig, options: CreateSdkClientOptions = {}): SdkMigrationClient {
  return new SdkMigrationClient({
    apiKey: required(process.env.ANYDB_API_KEY, "ANYDB_API_KEY"),
    userEmail: required(process.env.ANYDB_USER_EMAIL, "ANYDB_USER_EMAIL"),
    teamId: required(config.anydb?.teamId ?? process.env.ANYDB_TEAM_ID, "anydb.teamId or ANYDB_TEAM_ID"),
    databaseId: required(config.anydb?.databaseId ?? process.env.ANYDB_ADB_ID, "anydb.databaseId or ANYDB_ADB_ID"),
    baseUrl: config.anydb?.baseUrl ?? process.env.ANYDB_BASE_URL,
    debug: options.verbose,
    requestsPerMinute: requestRate(options.requestsPerMinute ?? process.env.ANYDB_REQUESTS_PER_MINUTE),
    onRateLimit: (waitMs, attempt) => {
      const seconds = Math.ceil(waitMs / 1_000);
      console.warn(`AnyDB rate limit reached. Waiting ${seconds} second${seconds === 1 ? "" : "s"} before retry ${attempt}/5...`);
    },
    onCacheProgress: ({ objectType, phase, loaded, total }) => {
      if (phase === "listing") {
        if (loaded === 0) console.log(`Loading ${objectType} cache: discovering records...`);
        else console.log(`Loading ${objectType} cache: discovered ${loaded} record${loaded === 1 ? "" : "s"}`);
        return;
      }
      if (phase === "ready") {
        console.log(`Loading ${objectType} cache: ready (${loaded} record${loaded === 1 ? "" : "s"})`);
        return;
      }
      const percentage = total === 0 ? 100 : Math.round((loaded / total!) * 100);
      console.log(`Loading ${objectType} cache: ${loaded}/${total} records (${percentage}%)`);
    },
  });
}
