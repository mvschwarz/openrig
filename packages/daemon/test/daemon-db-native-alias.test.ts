import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonDatabaseWarnings } from "../src/daemon-db-path.js";

const { holders } = vi.hoisted(() => ({ holders: vi.fn() }));
vi.mock("../src/windows-file-holders.js", () => ({ readWindowsFileHolders: holders }));
afterEach(() => { vi.unstubAllGlobals(); holders.mockReset(); });

it.runIf(process.platform === "win32")("joins native database aliases before applying confirmed-conflict policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "db-native-alias-"));
  const db = join(root, "openrig.sqlite");
  const pid = 123456789;
  try {
    writeFileSync(db, "owned sentinel, never opened as SQLite");
    writeFileSync(join(root, "daemon.json"), JSON.stringify({ pid, db: realpathSync.native(db), port: 17433 }));
    holders.mockResolvedValue([{ pid }]);
    const listener = vi.fn(async () => Response.json({ pid }));
    vi.stubGlobal("fetch", listener);
    await expect(daemonDatabaseWarnings(db, root, undefined, { conflictPolicy: "stop", allowConflict: false })).rejects.toThrow("OPENRIG_DB_CONFLICT");
    expect(listener).toHaveBeenCalled();
    expect((await daemonDatabaseWarnings(db, root, undefined, { conflictPolicy: "warn", allowConflict: false })).join()).toContain("Another live daemon");
    expect((await daemonDatabaseWarnings(db, root, undefined, { conflictPolicy: "stop", allowConflict: true })).join()).toContain("Startup and database writes continue");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pid: pid + 1 })));
    expect((await daemonDatabaseWarnings(db, root, undefined, { conflictPolicy: "stop", allowConflict: false })).join()).not.toContain("Another live daemon");
    holders.mockResolvedValue([]);
    expect(await daemonDatabaseWarnings(db, root, undefined, { conflictPolicy: "stop", allowConflict: false })).toEqual([]);
    expect(readFileSync(db, "utf8")).toBe("owned sentinel, never opened as SQLite");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
