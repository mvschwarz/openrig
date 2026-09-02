#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message, next) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, next }, null, 2)}\n`);
  process.exit(1);
}

const source = argument("--source");
const destination = argument("--destination");
if (!source || !destination) {
  fail("--source and --destination are required", "choose an existing OpenRig SQLite database and a new backup path");
}

const sourcePath = path.resolve(source);
const destinationPath = path.resolve(destination);
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  fail(`source database is not a regular file: ${sourcePath}`, "derive the live database path from daemon status before retrying");
}
if (fs.existsSync(destinationPath)) {
  fail(`destination already exists: ${destinationPath}`, "choose a new path; this helper never overwrites a backup");
}
if (destinationPath.includes("'") || destinationPath.includes("\n")) {
  fail("destination contains a quote or newline unsupported by the sqlite3 backup command", "choose a simple filesystem path");
}

fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
const sqlite = process.env.OPENRIG_SQLITE_BIN || "sqlite3";
const backup = spawnSync(sqlite, [sourcePath, `.backup '${destinationPath}'`], { encoding: "utf8" });
if (backup.status !== 0) {
  fs.rmSync(destinationPath, { force: true });
  fail(
    backup.stderr?.trim() || backup.stdout?.trim() || backup.error?.message || "sqlite3 backup failed",
    `run ${sqlite} against the source directly, resolve locking/path/tooling errors, then choose a fresh destination`,
  );
}

const check = spawnSync(sqlite, [destinationPath, "PRAGMA integrity_check;"], { encoding: "utf8" });
const integrity = check.stdout?.trim();
if (check.status !== 0 || integrity !== "ok") {
  fail(
    check.stderr?.trim() || `backup integrity result was ${JSON.stringify(integrity)}`,
    "preserve the failed backup for diagnosis only; do not use it for rollback",
  );
}

process.stdout.write(`${JSON.stringify({
  schema: "openrig-sqlite-backup/v1",
  ok: true,
  source: sourcePath,
  destination: destinationPath,
  bytes: fs.statSync(destinationPath).size,
  integrity,
}, null, 2)}\n`);
