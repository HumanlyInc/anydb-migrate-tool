import { access } from "node:fs/promises";
import { loadConfig } from "../config/loadConfig.js";
import { createSourceReader } from "../source/createSourceReader.js";
import { createSdkClient } from "../anydb/createSdkClient.js";
import { validateAgainstAnyDB } from "../config/validateRemote.js";

export async function validateCommand(configFile: string): Promise<void> {
  const loaded = await loadConfig(configFile);
  try {
    await access(loaded.sourcePath);
  } catch {
    throw new Error(`Source file does not exist: ${loaded.sourcePath}`);
  }
  const rows = await createSourceReader(loaded.sourcePath, loaded.config.source.sheet).read();
  const client = createSdkClient(loaded.config);
  await validateAgainstAnyDB(client, loaded.config, rows);
  console.log(`Valid: ${loaded.config.name}`);
  console.log(`Source: ${loaded.sourcePath}`);
  console.log(`Rows: ${rows.length}`);
  console.log(`Objects: ${loaded.config.objects.length}`);
  console.log("AnyDB types and fields: valid");
}
