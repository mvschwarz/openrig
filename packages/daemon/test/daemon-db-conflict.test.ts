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
    const callback = args.at(-1) as (error: null, result: { stdout: string; stderr: string }) => void;
    callback(null, { stdout: holders(args[1]), stderr: "" });
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
