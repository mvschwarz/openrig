import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon } from "../src/daemon-lifecycle.js";
import { databaseFlagPath, daemonCommand } from "../src/commands/daemon.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";

const preflightRun = vi.hoisted(() => vi.fn(async () => ({ ready: true, checks: [] })));
vi.mock("../src/daemon-lifecycle.js", async (original) => {
  const actual = await original<typeof import("../src/daemon-lifecycle.js")>();
  return { ...actual, getDaemonStatus: vi.fn(async () => ({ state: "stopped" })), startDaemon: vi.fn(async () => { throw new Error("startup options captured"); }) };
});
vi.mock("../src/system-preflight.js", () => ({ SystemPreflight: class { run = preflightRun; }, quietPreflightExec: async () => "" }));
let home: string;
let errors: string[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "daemon-start-port-"));
  vi.stubEnv("OPENRIG_HOME", home);
  errors = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  vi.mocked(startDaemon).mockClear();
  preflightRun.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); process.exitCode = undefined; });

it.each(["abc", "99999", "-1"])("daemon start --port %s is refused before preflight or startup", async (port) => {
  await daemonCommand({} as never).parseAsync(["start", "--port", port], { from: "user" });
  expect(errors.join("\n")).toContain(`Invalid --port: must be an integer in [0, 65535], got "${port}"`);
  expect(process.exitCode).toBe(1);
  expect(preflightRun).not.toHaveBeenCalled();
  expect(startDaemon).not.toHaveBeenCalled();
});

it("daemon start --port with a bindable port still reaches startup on that port", async () => {
  await daemonCommand({} as never).parseAsync(["start", "--port", "7434"], { from: "user" });
  expect(preflightRun).toHaveBeenCalledTimes(1);
  expect(startDaemon).toHaveBeenCalledTimes(1);
  expect(vi.mocked(startDaemon).mock.calls[0]![0]).toMatchObject({ port: 7434 });
});

it("daemon start --port 0 reaches startup asking for any free port", async () => {
  await daemonCommand({} as never).parseAsync(["start", "--port", "0"], { from: "user" });
  expect(startDaemon).toHaveBeenCalledTimes(1);
  expect(vi.mocked(startDaemon).mock.calls[0]![0]).toMatchObject({ port: 0 });
});

it.each(["relative/openrig.sqlite", "link/../openrig.sqlite"])("daemon start --db %s reaches startup anchored at this directory, not normalized", async (db) => {
  // Not collapsed: with link a symlink, link/.. is that link's parent, which only the OS can resolve.
  await daemonCommand({} as never).parseAsync(["start", "--db", db], { from: "user" });
  expect(startDaemon).toHaveBeenCalledTimes(1);
  expect(vi.mocked(startDaemon).mock.calls[0]![0]).toMatchObject({ db: `${process.cwd()}${sep}${db}` });
});

it.each([":memory:", " :memory: ", "/an/absolute/openrig.sqlite"])("daemon start --db '%s' reaches startup exactly as given", async (db) => {
  await daemonCommand({} as never).parseAsync(["start", "--db", db], { from: "user" });
  expect(vi.mocked(startDaemon).mock.calls[0]![0]).toMatchObject({ db });
});

it.each(["configured/openrig.sqlite", " :memory: "])("daemon start passes a configured database path ('%s') to startup unchanged", async (db) => {
  vi.stubEnv("OPENRIG_DB", db);
  await daemonCommand({} as never).parseAsync(["start"], { from: "user" });
  expect(vi.mocked(startDaemon).mock.calls[0]![0]).toMatchObject({ db });
});

it("a relative --db names the file SQLite opens from that directory, through a symlinked parent too", () => {
  mkdirSync(join(home, "target", "nested"), { recursive: true });
  symlinkSync(join(home, "target", "nested"), join(home, "link"), "dir");
  // From home, link/.. is target (the link's parent), not home: a lexical collapse would name home/selected.sqlite.
  const db = createDb(databaseFlagPath("link/../selected.sqlite", home));
  try {
    expect((db.pragma("database_list") as { file: string }[])[0]!.file).toBe(join(realpathSync(home), "target", "selected.sqlite"));
  } finally {
    db.close();
  }
});
