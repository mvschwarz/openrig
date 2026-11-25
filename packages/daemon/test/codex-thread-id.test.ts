import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexThreadIdResolver, defaultOpenCodexDatabaseHomeByPid, lstartToMinTs, readCodexThreadIdFromCandidateHomes } from "../src/domain/codex-thread-id.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const identity = "Sun Sep  6 23:52:32 2026";
const start = lstartToMinTs(identity)!;

it.each(["2026-09-06T15:52:32.1234567Z", "2026-09-06T23:52:32.1234567+08:00"])("retains the second-level PID reuse gate for Windows identity %s", value => {
  expect(lstartToMinTs(value)).toBe(Date.parse("2026-09-06T15:52:32Z") / 1000);
});

it("does not resolve a retired PID's conversation when Windows supplies an ISO creation time", async () => {
  const f = fixture(); f.thread("retired"); f.log("retired", start - 1);
  const resolver = f.finish();
  expect(await resolver.resolve(60422, new Date(start * 1000 + 123).toISOString())).toBeUndefined();
});
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

// The OS names the databases a process holds open; this one reads this test's own process.
it("names the one directory whose Codex databases a process holds open, and none when there are two", async () => {
  const open = (dir: string, name: string) => { fs.mkdirSync(dir, { recursive: true }); return new Database(path.join(dir, name)); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-open-home-")); roots.push(root);
  const logs = open(path.join(root, "a"), "logs_2.sqlite"), state = open(path.join(root, "a"), "state_5.sqlite");
  logs.exec("CREATE TABLE t (x)"); state.exec("CREATE TABLE t (x)");
  try {
    expect(await defaultOpenCodexDatabaseHomeByPid(process.pid)).toBe(fs.realpathSync(path.join(root, "a")));
    const other = open(path.join(root, "b"), "logs_2.sqlite"); other.exec("CREATE TABLE t (x)");
    try { expect(await defaultOpenCodexDatabaseHomeByPid(process.pid)).toBeUndefined(); } finally { other.close(); }
  } finally { logs.close(); state.close(); }
});

it("reads a verified process's open database home only on a miss and only when asked", async () => {
  const declared = fixture(), actual = fixture();
  actual.thread("moved-thread"); actual.log("moved-thread"); actual.finish(); declared.finish();
  const actualHome = path.join(actual.home, ".codex");
  const openDatabaseHomeByPid = vi.fn(() => actualHome);
  const resolver = new CodexThreadIdResolver({ codexHome: path.join(declared.home, ".codex"), openDatabaseHomeByPid });
  expect(await resolver.resolveWithHome(60422, identity)).toEqual({});
  expect(openDatabaseHomeByPid).not.toHaveBeenCalled();
  expect(await resolver.resolveWithHome(60422, identity, true)).toEqual({ thread: "moved-thread", codexHome: actualHome });
  const hit = vi.fn(() => actualHome);
  expect(await new CodexThreadIdResolver({ codexHome: actualHome, openDatabaseHomeByPid: hit }).resolveWithHome(60422, identity, true))
    .toEqual({ thread: "moved-thread", codexHome: actualHome });
  expect(hit).not.toHaveBeenCalled();
});

it("follows the open database home only when the declared home holds none of the process's rows", async () => {
  const declared = fixture(), actual = fixture();
  // Two qualifying threads in the declared home: ambiguous proof, not absence.
  declared.thread("first"); declared.log("first"); declared.thread("second"); declared.log("second");
  actual.thread("moved-thread"); actual.log("moved-thread"); actual.finish(); declared.finish();
  const openDatabaseHomeByPid = vi.fn(() => path.join(actual.home, ".codex"));
  const resolver = new CodexThreadIdResolver({ codexHome: path.join(declared.home, ".codex"), openDatabaseHomeByPid });
  expect(await resolver.resolveWithHome(60422, identity, true)).toEqual({});
  expect(openDatabaseHomeByPid).not.toHaveBeenCalled();
});

it("an open database home whose state databases weren't all read stays unknown, though one joins a thread", async () => {
  const declared = fixture(), actual = fixture();
  actual.thread("moved-thread"); actual.log("moved-thread"); actual.finish(); declared.finish();
  const actualHome = path.join(actual.home, ".codex");
  // A second state database that can't be read could join another of the process's threads.
  fs.writeFileSync(path.join(actualHome, "state_6.sqlite"), "not a database");
  const resolver = new CodexThreadIdResolver({ codexHome: path.join(declared.home, ".codex"), openDatabaseHomeByPid: () => actualHome });
  expect(await resolver.resolveWithHome(60422, identity, true)).toEqual({});
});

it("an fd link that fails to read for a reason other than closing leaves the open database home unknown", async () => {
  const fds = (code: string) => ({
    readdir: async () => ["3", "4"],
    readlink: async (link: string) => {
      if (link.endsWith("/3")) return "/codex/home/logs_2.sqlite";
      throw Object.assign(new Error(`${code}: ${link}`), { code });
    },
  });
  // An fd closed since the listing (ENOENT) is skipped; one that can't be read (EACCES) leaves the list incomplete.
  expect(await defaultOpenCodexDatabaseHomeByPid(7, fds("ENOENT"))).toBe("/codex/home");
  await expect(defaultOpenCodexDatabaseHomeByPid(7, fds("EACCES"))).rejects.toThrow("EACCES");
  const resolver = new CodexThreadIdResolver({ openDatabaseHomeByPid: pid => defaultOpenCodexDatabaseHomeByPid(pid, fds("EACCES")) });
  expect(await resolver.openDatabaseHome(7)).toBeUndefined();
});

describe("Codex home discovery respects an explicit platform home", () => {
  it("reads the default home before resolving a process home and never consults passwd", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-default-home-")); roots.push(home);
    vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);
    const passwd = vi.spyOn(os, "userInfo").mockImplementation(() => { throw new Error("passwd home must not be read"); });
    const processHome = vi.fn(() => "/synthetic-other-home");
    const read = vi.fn((_pid: number, candidate: string) => candidate === home ? "conversation" : undefined);
    const resolver = new CodexThreadIdResolver({ readFromLogs: read, resolveHomeDirByPid: processHome });
    expect(await resolver.resolve(60422, identity)).toBe("conversation");
    expect(read).toHaveBeenCalledExactlyOnceWith(60422, home, expect.any(Function), "exclude");
    expect(processHome).not.toHaveBeenCalled();
    expect(passwd).not.toHaveBeenCalled();
  });

  it("candidate-home fallback finds fixture logs without searching the passwd home", () => {
    const f = fixture(); f.thread("conversation"); f.log("conversation"); f.finish();
    vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", f.home);
    const passwd = vi.spyOn(os, "userInfo").mockImplementation(() => { throw new Error("passwd home must not be read"); });
    expect(readCodexThreadIdFromCandidateHomes(60422, [])).toBe("conversation");
    expect(passwd).not.toHaveBeenCalled();
  });

  it("an empty fixture home never resolves another home's conversation", () => {
    const foreign = fixture(); foreign.thread("foreign-conversation"); foreign.log("foreign-conversation"); foreign.finish();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-home-")); roots.push(home);
    vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);
    const passwd = vi.spyOn(os, "userInfo").mockReturnValue({ homedir: foreign.home } as ReturnType<typeof os.userInfo>);
    expect(readCodexThreadIdFromCandidateHomes(60422, [])).toBeUndefined();
    expect(passwd).not.toHaveBeenCalled();
  });
});

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


it.each(["default", "process-cache", "explicit"] as const)("carries the positive %s home with PID/start-time thread evidence", async mode => {
  const target = fixture(); target.thread("selected-thread"); target.log("selected-thread"); target.finish();
  const processHome = vi.fn(() => target.home);
  let resolver: CodexThreadIdResolver;
  if (mode === "process-cache") {
    const daemon = fixture(); daemon.finish();
    resolver = new CodexThreadIdResolver({ defaultHome: daemon.home, resolveHomeDirByPid: processHome });
  } else if (mode === "explicit") {
    resolver = new CodexThreadIdResolver({ codexHome: path.join(target.home, ".codex"), resolveHomeDirByPid: processHome });
  } else {
    resolver = new CodexThreadIdResolver({ defaultHome: target.home, resolveHomeDirByPid: processHome });
  }
  for (let i = 0; i < 2; i++) expect(await resolver.resolveWithHome(60422, identity)).toEqual({
    thread: "selected-thread", codexHome: path.join(target.home, ".codex"),
  });
  expect(processHome).toHaveBeenCalledTimes(mode === "process-cache" ? 1 : 0);
});
