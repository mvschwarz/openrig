import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../src/startup.js";
import { execArgvCommand } from "../src/adapters/tmux-exec.js";
import type { ArgvExecFn, ExecFn, TmuxAdapter } from "../src/adapters/tmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";

const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

function argvExecOf(adapter: TmuxAdapter): ArgvExecFn | undefined {
  return (adapter as unknown as { argvExec?: ArgvExecFn }).argvExec;
}

// A full daemon composition took 3-28 s per file on a loaded host.
describe("createDaemon tmux exec wiring", { timeout: 120000 }, () => {
  let tmuxDir: string;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // better-sqlite3 picks its native addon by process.platform on first open; load the host's one first.
  beforeAll(() => { new Database(":memory:").close(); });
  beforeEach(() => {
    // Any real tmux call during composition reaches an empty private directory, never a live server.
    tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-startup-tmux-"));
    vi.stubEnv("TMUX_TMPDIR", tmuxDir);
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("OPENRIG_NO_KERNEL", "1");
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    fs.rmSync(tmuxDir, { recursive: true, force: true });
  });

  for (const host of ["linux", "darwin"] as const) {
    it(`runs tmux without a shell on ${host}`, async () => {
      Object.defineProperty(process, "platform", { ...platform, value: host });
      const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory });
      try {
        expect(argvExecOf(daemon.deps.tmuxAdapter)).toBe(execArgvCommand);
      } finally {
        daemon.eventLoopMonitor.stop();
        daemon.db.close();
      }
    });
  }

  it("OPENRIG_TMUX_SHELL=1 keeps tmux on the shell path on linux, and is ignored on Windows", async () => {
    vi.stubEnv("OPENRIG_TMUX_SHELL", "1");
    for (const [host, expected] of [["linux", undefined], ["win32", execArgvCommand]] as const) {
      Object.defineProperty(process, "platform", { ...platform, value: host });
      const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory });
      try {
        expect(argvExecOf(daemon.deps.tmuxAdapter), host).toBe(expected);
      } finally {
        daemon.eventLoopMonitor.stop();
        daemon.db.close();
      }
    }
  });

  it("keeps an injected string exec on the shell path, so its fake sees every command", async () => {
    const tmuxExec: ExecFn = async () => "";
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory, tmuxExec });
    try {
      expect(argvExecOf(daemon.deps.tmuxAdapter)).toBeUndefined();
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });
});
