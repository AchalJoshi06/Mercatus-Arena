// Runs a local PostgreSQL 16 without Docker or sudo (embedded-postgres binaries).
// Credentials/port/db name come from DATABASE_URL in server/.env; data lives in
// <repo>/.localdb so it survives restarts.
//
// Usage (from server/): node scripts/local-db.mjs      — Ctrl+C to stop.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "..", "..", ".localdb");
const url = new URL(process.env.DATABASE_URL ?? "postgres://mercatus:mercatus@localhost:5432/mercatus");
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const port = Number(url.port || 5432);
const dbName = url.pathname.replace(/^\//, "") || "mercatus";

// npm may skip install scripts, which normally create the bundled lib symlinks.
const require = createRequire(import.meta.url);
const nativeDir = path.join(
  path.dirname(require.resolve(`@embedded-postgres/${process.platform}-${process.arch}`)),
  "..",
  "native",
);
const linksFile = path.join(nativeDir, "pg-symlinks.json");
if (fs.existsSync(linksFile)) {
  for (const { source, target } of JSON.parse(fs.readFileSync(linksFile, "utf8"))) {
    const dst = path.join(nativeDir, path.relative("native", target));
    if (!fs.existsSync(dst)) fs.symlinkSync(path.basename(source), dst);
  }
}

const pg = new EmbeddedPostgres({ databaseDir: dataDir, user, password, port, persistent: true });
if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase(dbName);
} catch {
  // already exists
}
console.log(`[local-db] postgres ready on :${port} db=${dbName} data=${dataDir}`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
