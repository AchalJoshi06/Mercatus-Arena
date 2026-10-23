import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Crash/tick error log. Defaults to <os tmp>/mercatus; override with ERROR_LOG_DIR.
const dir = process.env.ERROR_LOG_DIR ?? path.join(os.tmpdir(), "mercatus");
try {
  fs.mkdirSync(dir, { recursive: true });
} catch {
  // best-effort; appendFile below will just fail silently
}

export function appendErrorLog(file: string, where: string, e: unknown): void {
  const err = e as { stack?: string } | null;
  fs.appendFile(
    path.join(dir, file),
    `[${where}] ` + (err && err.stack ? err.stack : String(e)) + "\n--- " + new Date().toISOString() + "\n",
    () => {},
  );
}
