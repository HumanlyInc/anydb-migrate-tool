import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { normalizeConfig, validateConfig } from "./schema.js";
import type { LoadedConfig, LoadedStep } from "../types/config.js";

export async function loadConfig(filename: string): Promise<LoadedConfig> {
  const configPath = path.resolve(filename);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let config: unknown;
  try {
    config = YAML.parse(text);
  } catch (error) {
    throw new Error(`Invalid YAML in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateConfig(config);
  const plan = normalizeConfig(config);
  const steps: LoadedStep[] = plan.steps.map((step) => ({
    name: step.name,
    sourcePath: path.resolve(path.dirname(configPath), step.source.file),
    config: {
      name: plan.steps.length > 1 ? `${plan.name} / ${step.name}` : plan.name,
      anydb: plan.anydb,
      source: step.source,
      objects: step.objects,
    },
  }));
  return { plan, configPath, steps };
}
