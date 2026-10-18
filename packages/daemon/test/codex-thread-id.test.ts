import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CodexThreadIdResolver, lstartToMinTs } from "../src/domain/codex-thread-id.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const identity = "Sun Sep  6 23:52:32 2026";
const start = lstartToMinTs(identity)!;
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-first-turn-")); roots.push(home);
  fs.mkdirSync(path.join(home, ".codex"));
  const logs = new Database(path.join(home, ".codex/logs_2.sqlite"));
  logs.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT)");
  const state = new Database(path.join(home, ".codex/state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
  return {
    home,
    log: (id: string, ts = start + 1, pid = 60422) => logs.prepare("INSERT INTO logs (ts,ts_nanos,process_uuid,thread_id) VALUES (?,0,?,?)").run(ts, `pid:${pid}:native-process`, id),
    thread: (id: string, source = "cli") => state.prepare("INSERT INTO threads VALUES (?,?,?)").run(id, source, `${home}/${id}.jsonl`),
    finish: () => { logs.close(); state.close(); return new CodexThreadIdResolver({ defaultHome: home, resolveHomeDirByPid: () => home }); },
  };
}

describe("native conversation identity excludes same-process auxiliary threads", () => {
  it("resolves the first native conversation while title generation is the newest log activity", async () => {
    const f = fixture(); f.thread("conversation"); f.log("conversation"); f.log("title", start + 2);
    expect(await f.finish().resolve(60422, identity)).toBe("conversation");
  });

  it.each(["no conversation", "unrelated process", "retired pid", "ambiguous start second", "non-CLI thread", "two conversations"])("refuses %s instead of selecting a recent rollout", async kind => {
    const f = fixture();
    if (kind !== "no conversation") f.thread("conversation", kind === "non-CLI thread" ? "exec" : "cli");
    f.log("conversation", kind === "retired pid" ? start - 1 : kind === "ambiguous start second" ? start : start + 1,
      kind === "unrelated process" ? 99999 : 60422);
    if (kind === "two conversations") { f.thread("second"); f.log("second", start + 2); }
    f.log("title", start + 3);
    expect(await f.finish().resolve(60422, identity)).toBeUndefined();
  });
});

describe("a fork child's start second", () => {
  it("resolveForkChild takes a lone start-second row from a process instance with no earlier rows; resolve still refuses it", async () => {
    const f = fixture(); f.thread("conversation"); f.log("conversation", start);
    const resolver = f.finish();
    expect(await resolver.resolve(60422, identity)).toBeUndefined();
    expect(await resolver.resolveForkChild(60422, identity)).toBe("conversation");
  });

  it("resolveForkChild stays unresolved when another log database can't be read", async () => {
    const f = fixture(); f.thread("conversation"); f.log("conversation", start);
    fs.writeFileSync(path.join(f.home, ".codex/logs_1.sqlite"), "not a database");
    expect(await f.finish().resolveForkChild(60422, identity)).toBeUndefined();
  });

  it("resolveForkChild refuses a start-second row from an instance that logged before the second", async () => {
    const f = fixture(); f.thread("conversation"); f.log("conversation", start - 5); f.log("conversation", start);
    expect(await f.finish().resolveForkChild(60422, identity)).toBeUndefined();
  });
});
