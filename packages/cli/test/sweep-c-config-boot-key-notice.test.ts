// SWEEP-c (shape f2576102) — persist-WITHOUT-reconcile honesty floor: setting a
// BOOT-ONLY key while the daemon runs prints the restart-required notice (silent
// stale -> loud honest). Live-reload (ii) routed as its own arch item, not built here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configCommand } from "../src/commands/config.js";

function runSet(key: string, value: string, daemonRunning: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweepc-"));
  const cmd = configCommand(path.join(dir, "config.json"), {
    probeDaemonRunning: async () => daemonRunning,
  });
  return cmd.parseAsync(["node", "rig", "set", key, value]).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe("SWEEP-c — boot-only config keys warn while the daemon runs", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it("daemon.port with a RUNNING daemon prints the restart-required notice", async () => {
    await runSet("daemon.port", "9999", true);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/next daemon restart|restart the daemon/i);
  });

  it("a non-boot key prints NO notice; boot key with daemon down prints NO notice", async () => {
    await runSet("workspace.root", "/tmp/x", true);
    await runSet("daemon.port", "9999", false);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).not.toMatch(/restart/i);
  });
});
