import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { CodexThreadIdResolver, lstartToMinTs, resolveCodexDbPaths, type CodexCaptureDiagnostic } from "../src/domain/codex-thread-id.js";

// The in-place restart's conflict check needs to tell a read with no detected incompleteness from a partial one. These
// run the real resolver over versioned SQLite databases in a scratch Codex home: mixed readability (an unreadable database
// beside a readable singleton) and discovery completeness (a listing that fails, or a listed database the existence check
// drops). resolve() and every resolveCodexDbPaths caller that doesn't ask keep exactly today's answers.

const E1 = "019a0000-0000-7000-8000-000000000001";
const Y = "019fd98d-16a1-7981-8000-000000000002";
const X = "019fc51f-2c51-76e2-976d-7a2989460100";
const identity = "Sun Sep  6 23:52:32 2026";
const start = lstartToMinTs(identity)!;
const isRoot = process.getuid?.() === 0;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function versionedHome(dbs: { logs: number[]; state: number[] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-readability-")); roots.push(home);
  for (const v of dbs.logs) {
    const d = new Database(path.join(home, `logs_${v}.sqlite`));
    d.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT)"); d.close();
  }
  for (const v of dbs.state) {
    const d = new Database(path.join(home, `state_${v}.sqlite`));
    d.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)"); d.close();
  }
  return home;
}
function seed(home: string, logsV: number, stateV: number, id: string, at = start + 1) {
  const logs = new Database(path.join(home, `logs_${logsV}.sqlite`)); const state = new Database(path.join(home, `state_${stateV}.sqlite`));
  state.prepare("INSERT OR IGNORE INTO threads VALUES (?,?,?)").run(id, "cli", `${home}/${id}.jsonl`);
  logs.prepare("INSERT INTO logs (ts,ts_nanos,process_uuid,thread_id) VALUES (?,0,?,?)").run(at, "pid:700:p", id);
  logs.close(); state.close();
}
const evidence = (home: string) => new CodexThreadIdResolver({ codexHome: home }).resolveWithReadability(700, identity);
async function resolveToday(home: string): Promise<{ thread?: string; reasons: string[] }> {
  const seen: CodexCaptureDiagnostic[] = [];
  const thread = await new CodexThreadIdResolver({ codexHome: home }).resolve(700, identity, (d) => seen.push(d));
  return { ...(thread ? { thread } : {}), reasons: seen.map((d) => d.reason) };
}

describe("mixed readability: a readable singleton beside an unreadable database is not fully readable", () => {
  it("readable logs_1 + state_5, only Y logged: Y, fully readable", async () => {
    const h = versionedHome({ logs: [1], state: [5] }); seed(h, 1, 5, Y);
    expect(await evidence(h)).toEqual({ thread: Y, fullyReadable: true });
    expect(await resolveToday(h)).toEqual({ thread: Y, reasons: [] });
  });
  it("plus an unreadable logs_2, or an unreadable state_6: still Y, not fully readable (resolve unchanged)", async () => {
    for (const name of ["logs_2.sqlite", "state_6.sqlite"]) {
      const h = versionedHome({ logs: [1], state: [5] }); seed(h, 1, 5, Y);
      fs.writeFileSync(path.join(h, name), "not a database");
      expect(await evidence(h)).toEqual({ thread: Y, fullyReadable: false, incomplete: "unreadable" });
      expect(await resolveToday(h)).toEqual({ thread: Y, reasons: [] });
    }
  });
  it("control: X and Y both logged: no thread, ambiguous_threads, fully readable", async () => {
    const h = versionedHome({ logs: [1], state: [5] }); seed(h, 1, 5, X); seed(h, 1, 5, Y, start + 5);
    expect(await evidence(h)).toEqual({ reason: "ambiguous_threads", fullyReadable: true });
  });
  it("nothing logged: no thread, no_log_row", async () => {
    const h = versionedHome({ logs: [1], state: [5] });
    expect(await evidence(h)).toEqual({ reason: "no_log_row", fullyReadable: true });
  });
});

describe("discovery completeness: a listing that fails or a dropped database is not fully readable", () => {
  /** logs_1/state_5 hold Y, logs_2/state_6 hold E1. */
  function twoGenerations() {
    const h = versionedHome({ logs: [1, 2], state: [5, 6] }); seed(h, 1, 5, Y); seed(h, 2, 6, E1); return h;
  }

  it("control: everything visible: ambiguous_threads, fully readable; the paths are today's", async () => {
    const h = twoGenerations();
    expect(await evidence(h)).toEqual({ reason: "ambiguous_threads", fullyReadable: true });
    const discovery = { complete: true };
    expect(resolveCodexDbPaths("", "logs", undefined, h, discovery)).toEqual(resolveCodexDbPaths("", "logs", undefined, h));
    expect(discovery.complete).toBe(true);
  });

  it.skipIf(isRoot)("the listing fails (EACCES), the historical paths still open: Y, but not fully readable", async () => {
    const h = twoGenerations();
    fs.chmodSync(h, 0o333);
    try {
      expect(await evidence(h)).toEqual({ thread: Y, fullyReadable: false, incomplete: "discovery" });
      expect(await resolveToday(h)).toEqual({ thread: Y, reasons: [] });
      const discovery = { complete: true };
      expect(resolveCodexDbPaths("", "logs", undefined, h, discovery)).toEqual([path.join(h, "logs_1.sqlite")]);
      expect(discovery.complete).toBe(false);
    } finally { fs.chmodSync(h, 0o755); }
  });

  it.skipIf(isRoot)("a listed database the existence check drops: Y, but not fully readable; the returned paths are unchanged", async () => {
    const h = versionedHome({ logs: [1, 2], state: [5, 6] }); seed(h, 1, 5, Y);
    const hidden = path.join(h, "hidden"); fs.mkdirSync(hidden);
    for (const name of ["logs_2.sqlite", "state_6.sqlite"]) {
      fs.renameSync(path.join(h, name), path.join(hidden, name));
      fs.symlinkSync(path.join(hidden, name), path.join(h, name));
    }
    seed(hidden, 2, 6, E1);
    fs.chmodSync(hidden, 0o000);
    try {
      expect(await evidence(h)).toEqual({ thread: Y, fullyReadable: false, incomplete: "discovery" });
      expect(await resolveToday(h)).toEqual({ thread: Y, reasons: [] });
      const discovery = { complete: true };
      const paths = resolveCodexDbPaths("", "logs", undefined, h, discovery);
      expect(paths).toEqual(resolveCodexDbPaths("", "logs", undefined, h));
      expect(paths).toEqual([path.join(h, "logs_1.sqlite")]);
      expect(discovery.complete).toBe(false);
    } finally { fs.chmodSync(hidden, 0o755); }
  });

  it("an existence check that throws on a listed database marks discovery incomplete and still throws, as today", () => {
    const h = twoGenerations();
    const discovery = { complete: true };
    expect(() => resolveCodexDbPaths("", "logs", () => { throw new Error("boom"); }, h, discovery)).toThrow("boom");
    expect(discovery.complete).toBe(false);
  });
});
