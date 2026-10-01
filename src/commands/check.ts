import { createSdkClient } from "../anydb/createSdkClient.js";

const REQUIRED = ["ANYDB_API_KEY", "ANYDB_USER_EMAIL", "ANYDB_TEAM_ID", "ANYDB_ADB_ID"];

/** Reports which settings are present (never their values) and tests the connection. */
export async function checkCommand(): Promise<void> {
  for (const name of [...REQUIRED, "ANYDB_BASE_URL"]) {
    const value = process.env[name];
    if (!value) console.log(`${name}: ${REQUIRED.includes(name) ? "MISSING" : "not set (SDK default)"}`);
    else if (name === "ANYDB_BASE_URL") console.log(`${name}: ${value}`);
    else if (name === "ANYDB_TEAM_ID" || name === "ANYDB_ADB_ID") console.log(`${name}: ${value}`);
    else console.log(`${name}: set`);
  }
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`Missing ${missing.join(", ")}`);
  const client = createSdkClient({});
  const types = await client.listTypes();
  console.log(`Connected. ${types.length} types in the workspace: ${types.join(", ")}`);
}
