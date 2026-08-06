import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import {
  resolveDaemonDbPath,
  snapshotDaemonDb,
  openDaemonDbReadonly,
  CrashCartReadError,
} from "../src/domain/crash-cart-discovery.js";

// Crash-cart C2 keystone (arch a1344201 Q1 + PM gate): copy the {db,-wal,-shm} triple to scratch,
// open the COPY, and SQLite replays the WAL on the copy → a FRESH view (the last pre-crash frames)
// with ZERO interference to the originals a restarting daemon reopens. REAL better-sqlite3 + real
// files — this is the "WAL-replay-on-copy demonstrated" evidence, not a mock.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(prefix = "cc-cr-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const sha = (p: string): string =>
  existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "ABSENT";

describe("copy-then-read — WAL replays on the copy; originals untouched", () => {
  it("last WAL-committed rows are visible on the copy; main-alone omits them; originals byte-identical after the read", () => {
    const dir = scratch();
    const dbPath = join(dir, "openrig.sqlite");
    // A WAL-mode DB with a committed-but-UNcheckpointed row (writer kept open ⇒ frames stay in -wal,
    // simulating a crash where the last frames never replayed into main.db).
    const writer = createDb(dbPath);
    writer.exec("CREATE TABLE t (x INTEGER)");
    writer.prepare("INSERT INTO t (x) VALUES (7)").run();
    expect(existsSync(dbPath + "-wal")).toBe(true);
    expect(existsSync(dbPath + "-shm")).toBe(true);

    const originals = [dbPath, dbPath + "-wal", dbPath + "-shm"];
    const before = originals.map(sha);

    // (A) COPY the full triple → open the copy → the WAL frames replay: the row is present + fresh.
    const scratchDir = scratch("cc-copy-");
    const copyDb = snapshotDaemonDb(dbPath, scratchDir, { copyFile: copyFileSync, exists: existsSync });
    const ro = openDaemonDbReadonly(copyDb);
    expect(ro.prepare("SELECT x FROM t").get()).toEqual({ x: 7 });
    ro.close();

    // (B) main.db ALONE (no -wal) omits the frames — proof they lived in the WAL, not main.db.
    const mainOnly = join(scratch("cc-main-"), "openrig.sqlite");
    copyFileSync(dbPath, mainOnly);
    const roMain = new Database(mainOnly, { readonly: true });
    expect(() => roMain.prepare("SELECT x FROM t").get()).toThrow(); // table itself lived in the WAL
    roMain.close();

    // (C) the reads touched ONLY copies — the originals are byte-identical (read-only / no interference).
    const afterReads = originals.map(sha);
    expect(afterReads).toEqual(before);

    writer.close(); // only now may the originals legitimately change (checkpoint on close)
  });

  it("snapshotDaemonDb copies sidecars only when present and fails loud on a missing db", () => {
    const dir = scratch();
    const dbPath = join(dir, "openrig.sqlite");
    const w = createDb(dbPath);
    w.exec("CREATE TABLE t (x INTEGER)");
    w.pragma("wal_checkpoint(TRUNCATE)"); // flush + truncate the -wal so it is empty/absent-ish
    w.close();

    const out = scratch("cc-copy2-");
    const copyDb = snapshotDaemonDb(dbPath, out, { copyFile: copyFileSync, exists: existsSync });
    expect(existsSync(copyDb)).toBe(true); // the db is always copied
    const ro = openDaemonDbReadonly(copyDb);
    expect(ro.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 0 });
    ro.close();

    expect(() =>
      snapshotDaemonDb(join(dir, "nope.sqlite"), out, { copyFile: copyFileSync, exists: existsSync }),
    ).toThrow(CrashCartReadError);
  });
});

describe("resolveDaemonDbPath — prefer daemon.json.db, flag relative", () => {
  it("uses the state file's db path when present (absolute)", () => {
    const r = resolveDaemonDbPath("/home/.openrig", () => ({
      pid: 1,
      port: 7433,
      db: "/home/.openrig/openrig.sqlite",
    }));
    expect(r).toEqual({ path: "/home/.openrig/openrig.sqlite", fromStateFile: true, relative: false });
  });

  it("flags a relative state-file db path (daemon CWD unknown → caller must handle)", () => {
    const r = resolveDaemonDbPath("/home/.openrig", () => ({ pid: 1, port: 7433, db: "openrig.sqlite" }));
    expect(r.fromStateFile).toBe(true);
    expect(r.relative).toBe(true);
  });

  it("falls back to $OPENRIG_HOME/openrig.sqlite when there is no state file", () => {
    const r = resolveDaemonDbPath("/home/.openrig", () => undefined);
    expect(r).toEqual({ path: "/home/.openrig/openrig.sqlite", fromStateFile: false, relative: false });
  });
});
