import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as native from "../src/windows-file-holders.js";
import { daemonDatabaseWarnings } from "../src/daemon-db-path.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe.skipIf(process.platform !== "win32")("Windows database file holders", () => {
  it("observes an owned child holding a file, confirms its daemon record and listener, and observes closure", async () => {
    const home = mkdtempSync(join(tmpdir(), "openrig-file-holder-"));
    const file = join(home, "database with ' 中文.sqlite");
    writeFileSync(file, "owned fixture");
    const child = spawn(process.execPath, ["-e", "require('fs').openSync(process.argv[1],'r');console.log('ready');setInterval(()=>{},1000)", file], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(child.stdout!, "data");
      const rows = await native.readWindowsFileHolders(file);
      expect(rows.some(row => row.pid === child.pid && Number.isFinite(Date.parse(row.startedAt)))).toBe(true);
      writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: child.pid, db: file, port: 17433 }));
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pid: child.pid })));
      await expect(daemonDatabaseWarnings(file, home, undefined, { conflictPolicy: "stop", allowConflict: false })).rejects.toThrow("OPENRIG_DB_CONFLICT");
      await expect(daemonDatabaseWarnings(file, home)).resolves.toEqual([expect.stringContaining("Another live daemon")]);
      writeFileSync(join(home, "daemon.json"), "{}");
      await expect(daemonDatabaseWarnings(file, home)).resolves.toEqual([expect.stringContaining("ownership is unknown")]);
    } finally {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
    try { expect(await native.readWindowsFileHolders(file)).toEqual([]); }
    finally { rmSync(home, { recursive: true, force: true }); }
  }, 90_000);
  it("retains unknown on native access/query failure instead of certifying no conflict", async () => {
    const home = mkdtempSync(join(tmpdir(), "openrig-holder-failed-"));
    try {
      const file = join(home, "db.sqlite"); writeFileSync(file, "fixture");
      vi.spyOn(native, "readWindowsFileHolders").mockRejectedValue(new Error("Access denied"));
      expect(await daemonDatabaseWarnings(file, home, undefined, { conflictPolicy: "stop", allowConflict: false }))
        .toEqual([expect.stringContaining("Windows Restart Manager file-holder query failed")]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
