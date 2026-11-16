// A cell's raw bank: everything a reader needs to check its verdict without trusting the harness, each file pinned by
// sha256 and size. Kept: the stand-in's request log, OpenRig's tmux calls, the screen frames, the harness's steps, the
// daemon's delivery records (its events and held messages, read from the private daemon's own database, read only),
// and the program's own transcript. Columns that could hold a credential are dropped from the export, and every banked
// file is scanned for credential-shaped strings before the bank is sealed.

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { DUMMY_TOKEN } from "./world.mjs";

const SECRET_COLUMN = /auth|secret|password|env|credential|api_key|token/i;
// Shapes of real credentials. The cell's dummy token is the only credential it holds, and it isn't one.
const CREDENTIAL_SHAPES = [/sk-ant-[A-Za-z0-9_-]{10,}/, /sk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /xox[bp]-[A-Za-z0-9-]{10,}/, /"access_token"\s*:\s*"[^"]{8,}/];
// The daemon's tables a delivery case reads.
const TABLES = ["events", "seat_delivery_guards", "outbox_entries", "queue_items", "nodes", "sessions"];

function exportDatabase(dbPath, outPath) {
  if (!existsSync(dbPath)) return { missing: dbPath };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const out = {};
  try {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const table of TABLES) {
      if (!names.has(table)) { out[table] = { missing: true }; continue; }
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const kept = columns.filter((c) => !SECRET_COLUMN.test(c));
      out[table] = { dropped: columns.filter((c) => SECRET_COLUMN.test(c)), rows: db.prepare(`SELECT ${kept.map((c) => `"${c}"`).join(", ")} FROM ${table}`).all() };
    }
  } finally { db.close(); }
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  return null;
}

/** The daemon's delivery records for the seat: #2937's per-send evidence and the hook's prompt observations. */
export function deliveryEvents(dbPath) {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT seq, type, payload, created_at FROM events WHERE type IN ('transport.delivery_evidence', 'transport.prompt_observation') ORDER BY seq")
      .all().map((r) => ({ seq: r.seq, type: r.type, at: r.created_at, payload: JSON.parse(r.payload) }));
  } catch { return []; } finally { db.close(); }
}

function filesUnder(dir, keep) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && keep(d.name))
    .map((d) => join(d.parentPath ?? d.path, d.name));
}

/** Copy the cell's evidence into `bank` and write MANIFEST.json. Returns the manifest. */
export function bankCell(cell, bank, extra = {}) {
  mkdirSync(bank, { recursive: true });
  const db = join(cell.env.OPENRIG_HOME, "openrig.sqlite");
  const notes = [];
  const missing = exportDatabase(db, join(bank, "daemon-tables.json"));
  if (missing) notes.push(`no daemon database at ${missing.missing}`);
  writeFileSync(join(bank, "delivery-events.json"), JSON.stringify(deliveryEvents(db), null, 1));
  for (const [name, value] of Object.entries(extra)) writeFileSync(join(bank, name), typeof value === "string" ? value : JSON.stringify(value, null, 1));
  for (const file of readdirSync(cell.logs)) copyFileSync(join(cell.logs, file), join(bank, file));
  // The program's own record of its conversation: Claude Code's session transcripts, Codex's rollouts.
  const native = [
    ...filesUnder(join(cell.env.CLAUDE_CONFIG_DIR, "projects"), (n) => n.endsWith(".jsonl")),
    ...filesUnder(join(cell.env.CODEX_HOME, "sessions"), (n) => n.endsWith(".jsonl")),
  ];
  mkdirSync(join(bank, "native"), { recursive: true });
  for (const file of native) copyFileSync(file, join(bank, "native", relative(cell.home, file).replaceAll("/", "__")));
  const daemonLog = join(cell.env.OPENRIG_HOME, "daemon.log");
  if (existsSync(daemonLog)) copyFileSync(daemonLog, join(bank, "daemon.log"));

  const files = filesUnder(bank, (n) => n !== "MANIFEST.json").sort().map((path) => {
    const bytes = readFileSync(path);
    const text = bytes.toString("latin1");
    const shapes = CREDENTIAL_SHAPES.filter((re) => re.test(text)).map(String);
    return { path: relative(bank, path), bytes: statSync(path).size, sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(shapes.length ? { credentialShapes: shapes } : {}) };
  });
  const flagged = files.filter((f) => f.credentialShapes);
  const manifest = { cell: basename(cell.root), dummyToken: DUMMY_TOKEN, notes, files,
    credentialScan: flagged.length ? { clean: false, files: flagged.map((f) => f.path) } : { clean: true } };
  writeFileSync(join(bank, "MANIFEST.json"), JSON.stringify(manifest, null, 1));
  return manifest;
}
