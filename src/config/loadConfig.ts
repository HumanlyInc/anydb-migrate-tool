import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { validateConfig } from "./schema.js";
import type { LoadedConfig } from "../types/config.js";

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
  return {
    config,
    configPath,
    sourcePath: path.resolve(path.dirname(configPath), config.source.file),
  };
}
