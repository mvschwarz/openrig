import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const { holders, openDb } = vi.hoisted(() => ({ holders: vi.fn(), openDb: vi.fn() }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: (...args: unknown[]) => {
    const callback = args.at(-1) as (error: unknown, result?: { stdout: string; stderr: string }) => void;
    // A fixture returns lsof's stdout, or { error } for how the run ended without one. Other commands answer nothing.
    const answer = args[0] === "lsof" ? holders(args[1]) as string | { error: unknown } : "";
    if (typeof answer === "string") callback(null, { stdout: answer, stderr: "" });
    else callback(answer.error);
  },
}));
vi.mock("../src/db/connection.js", () => ({ createDb: openDb }));
let root: string, dbPath: string, policy: string;
const pid = process.pid + 100_000;
beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), "openrig-db-conflict-"));
  dbPath = join(root, "shared.sqlite");
  writeFileSync(dbPath, "original database bytes");
  writeFileSync(join(root, "daemon.json"), JSON.stringify({ pid, db: dbPath, port: 17433 }));
  holders.mockImplementation((args: string[]) => args[0] === "-t" ? `${pid}\n` : "");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ pid }) })));
  policy = "warn";
  vi.spyOn(SettingsStore.prototype, "resolveOne").mockImplementation(() => ({ value: policy, source: "file", defaultValue: "warn" }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Sentinel ends startup exactly at its first database open; no test opens or reconciles a database.
  openDb.mockImplementation(() => { throw Error("fixture reached database open"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it("stops before opening the database on an opted-in confirmed live-daemon conflict, with a one-start remedy", async () => {
  policy = "stop";
  await expect(createDaemon({ dbPath })).rejects.toThrow(/OPENRIG_DB_CONFLICT:.*--allow-db-conflict/s);
  expect(openDb).not.toHaveBeenCalled();
  expect(readFileSync(dbPath, "utf8")).toBe("original database bytes");
});

it("keeps the default warning and reaches database open on a confirmed conflict", async () => {
  await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
  expect(openDb).toHaveBeenCalledExactlyOnceWith(dbPath);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Another live daemon"));
});

it("honours and consumes the one-start go-ahead", async () => {
  policy = "stop";
  vi.stubEnv("OPENRIG_ALLOW_DB_CONFLICT", "1");
  await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
  expect(process.env.OPENRIG_ALLOW_DB_CONFLICT).toBeUndefined();
  expect(openDb).toHaveBeenCalledExactlyOnceWith(dbPath);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Another live daemon"));
});

it.each(["holder", "record", "listener"])("does not stop without matching %s evidence", async missing => {
  policy = "stop";
  if (missing === "holder") holders.mockReturnValue("");
  if (missing === "record") writeFileSync(join(root, "daemon.json"), JSON.stringify({ pid: pid + 1, db: dbPath, port: 17433 }));
  if (missing === "listener") vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ pid: pid + 1 }) })));
  await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
  expect(openDb).toHaveBeenCalledExactlyOnceWith(dbPath);
});

it("honours an explicit cross-home path even with stop selected and no confirmed holder", async () => {
  policy = "stop";
  holders.mockReturnValue("");
  vi.stubEnv("OPENRIG_DB", dbPath);
  await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("This explicit path is honoured"));
  expect(openDb).toHaveBeenCalledExactlyOnceWith(dbPath);
});

// How lsof ends without an answer, as execFile reports it.
const lsofEnded = {
  "isn't installed": Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }),
  "timed out": Object.assign(new Error("Command failed: lsof"), { killed: true, signal: "SIGTERM", code: null }),
  "failed": Object.assign(new Error("Command failed: lsof"), { killed: false, code: 2 }),
};
const unknownOwnership = (reason: string) => expect.stringMatching(new RegExp(`Couldn't verify whether another daemon has database .* open \\(lsof ${reason}\\): ownership is unknown`));

it.each(Object.keys(lsofEnded))("says ownership is unknown when lsof %s, in both modes, and never stops on it", async reason => {
  holders.mockImplementation(() => ({ error: lsofEnded[reason as keyof typeof lsofEnded] }));
  for (const mode of ["warn", "stop"]) {
    policy = mode;
    vi.mocked(console.warn).mockClear();
    openDb.mockClear();
    await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
    expect(openDb).toHaveBeenCalledExactlyOnceWith(dbPath);
    expect(console.warn).toHaveBeenCalledWith(unknownOwnership(reason));
    if (mode === "stop") expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("daemon.db_conflict=stop stops only on a confirmed conflict"));
  }
});

it("says ownership is unknown when a matching record's listener doesn't answer in time, and doesn't stop", async () => {
  policy = "stop";
  vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }));
  await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
  expect(openDb).toHaveBeenCalledExactlyOnceWith(dbPath);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`the listener recorded for pid ${pid} on port 17433 didn't answer within 500 ms): ownership is unknown`));
});

// A health answer that starts but can't be read: its body aborts, or a 200 isn't JSON.
const unreadable = {
  "body aborts": () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("body aborted", "AbortError")); } }), { status: 200 }),
  "not JSON": () => new Response("{invalid", { status: 200 }),
};
it.each(Object.keys(unreadable))("says ownership is unknown when a matching record's listener answer can't be read (%s), in both modes", async kind => {
  vi.stubGlobal("fetch", vi.fn(async () => unreadable[kind as keyof typeof unreadable]()));
  for (const mode of ["warn", "stop"]) {
    policy = mode;
    vi.mocked(console.warn).mockClear();
    openDb.mockClear();
    await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
    expect(openDb).toHaveBeenCalledExactlyOnceWith(dbPath);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`the listener recorded for pid ${pid} on port 17433 gave an answer that couldn't be read): ownership is unknown`));
  }
});

it("adds no warning when the recorded listener answers for another pid", async () => {
  policy = "stop";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pid: pid + 1 })));
  await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
  expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("Couldn't verify"));
  expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("Another live daemon"));
});

it("says ownership is unknown when the holder's own files can't be read and no record confirms it", async () => {
  writeFileSync(join(root, "daemon.json"), JSON.stringify({ pid: pid + 1, db: dbPath, port: 17433 }));
  holders.mockImplementation((args: string[]) => args[0] === "-t" ? `${pid}\n` : { error: lsofEnded["timed out"] });
  await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`(lsof timed out for pid ${pid}): ownership is unknown`));
});

it.each([["no output", ""], ["exit status 1", { error: Object.assign(new Error("Command failed: lsof"), { code: 1 }) }]])(
  "adds no warning when lsof answers that nothing holds the database (%s)", async (_case, answer) => {
    policy = "stop";
    holders.mockImplementation(() => answer);
    await expect(createDaemon({ dbPath })).rejects.toThrow("fixture reached database open");
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("Couldn't verify"));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("Another live daemon"));
  });
