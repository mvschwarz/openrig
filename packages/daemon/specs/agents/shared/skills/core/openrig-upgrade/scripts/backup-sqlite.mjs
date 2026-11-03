#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Suppress experimental warning for node:sqlite to keep stderr clean for JSON errors
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  if (typeof warning === "string" && warning.includes("SQLite is an experimental feature")) {
    return;
  }
  if (warning && typeof warning === "object" && warning.name === "ExperimentalWarning" && warning.message?.includes("SQLite")) {
    return;
  }
  return originalEmitWarning.call(process, warning, ...args);
};

let sqliteModule;
let DatabaseSync;
try {
  sqliteModule = await import("node:sqlite");
  DatabaseSync = sqliteModule.DatabaseSync;
} catch {
  sqliteModule = undefined;
  DatabaseSync = undefined;
}

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

const sqliteBin = process.env.OPENRIG_SQLITE_BIN || "sqlite3";
const probe = spawnSync(sqliteBin, ["-version"], { encoding: "utf8" });
const hasCli = probe.status === 0;

let integrity;

if (hasCli) {
  const backup = spawnSync(sqliteBin, [sourcePath, `.backup '${destinationPath}'`], { encoding: "utf8" });
  if (backup.status !== 0) {
    fs.rmSync(destinationPath, { force: true });
    fail(
      backup.stderr?.trim() || backup.stdout?.trim() || backup.error?.message || "sqlite3 backup failed",
      `run ${sqliteBin} against the source directly, resolve locking/path/tooling errors, then choose a fresh destination`,
    );
  }

  const check = spawnSync(sqliteBin, [destinationPath, "PRAGMA integrity_check;"], { encoding: "utf8" });
  integrity = check.stdout?.trim();
  if (check.status !== 0 || integrity !== "ok") {
    fail(
      check.stderr?.trim() || `backup integrity result was ${JSON.stringify(integrity)}`,
      "preserve the failed backup for diagnosis only; do not use it for rollback",
    );
  }
} else if (DatabaseSync) {
  try {
    const srcDb = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      if (typeof sqliteModule?.backup === "function") {
        await sqliteModule.backup(srcDb, destinationPath);
      } else {
        srcDb.exec(`VACUUM INTO '${destinationPath}';`);
      }
    } finally {
      srcDb.close();
    }
  } catch (err) {
    fs.rmSync(destinationPath, { force: true });
    fail(
      err?.message || "sqlite backup failed via node:sqlite",
      "resolve locking/path/tooling errors, then choose a fresh destination",
    );
  }

  try {
    const backupDb = new DatabaseSync(destinationPath, { readOnly: true });
    try {
      const rows = backupDb.prepare("PRAGMA integrity_check;").all();
      integrity = rows[0]?.integrity_check;
    } finally {
      backupDb.close();
    }
  } catch (err) {
    fail(
      err?.message || `backup integrity result was ${JSON.stringify(integrity)}`,
      "preserve the failed backup for diagnosis only; do not use it for rollback",
    );
  }

  if (integrity !== "ok") {
    fail(
      `backup integrity result was ${JSON.stringify(integrity)}`,
      "preserve the failed backup for diagnosis only; do not use it for rollback",
    );
  }
} else {
  fail(
    "neither sqlite3 CLI nor node:sqlite is available to create a backup",
    "install sqlite3 CLI or run on Node with node:sqlite support",
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
