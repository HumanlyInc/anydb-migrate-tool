import { access } from "node:fs/promises";
import { loadConfig } from "../config/loadConfig.js";
import { createSourceReader } from "../source/createSourceReader.js";
import { createSdkClient } from "../anydb/createSdkClient.js";
import { validateAgainstAnyDB } from "../config/validateRemote.js";

export async function validateCommand(configFile: string): Promise<void> {
  const loaded = await loadConfig(configFile);
  const client = createSdkClient(loaded.plan);
  console.log(`Valid configuration: ${loaded.plan.name} (${loaded.steps.length} step${loaded.steps.length === 1 ? "" : "s"})`);
  for (const step of loaded.steps) {
    try {
      await access(step.sourcePath);
    } catch {
      throw new Error(`Source file does not exist for step "${step.name}": ${step.sourcePath}`);
    }
    const rows = await createSourceReader(step.sourcePath, step.config.source.sheet).read();
    await validateAgainstAnyDB(client, step.config, rows);
    console.log(`- ${step.name}: ${rows.length} rows, ${step.config.objects.length} objects, AnyDB types and fields valid`);
  }
}
