import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Only one migration may write to a workspace at a time. A second run would load its cache before
 * the first one's records exist and create them again. The lock names the process that holds it, so a
 * lock left by a crashed or killed run is detected and taken over. Returns a function that releases it.
 */
export function acquireRunLock(teamId: string, databaseId: string, directory = tmpdir()): () => void {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `anydb-migrate-${teamId}-${databaseId}.lock`);
  try {
    const holder = Number(readFileSync(file, "utf8").trim());
    if (Number.isInteger(holder) && holder !== process.pid && processIsAlive(holder)) {
      throw new Error(
        `Another migration (process ${holder}) is already writing to this workspace. ` +
        `Wait for it to finish or stop it first. If it is not really running, delete ${file}.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeFileSync(file, String(process.pid), "utf8");

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
    } catch {
      // Already gone.
    }
  };
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      release();
      process.exit(130);
    });
  }
  return release;
}
