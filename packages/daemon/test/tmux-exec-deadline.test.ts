import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { execArgvCommand, execTmuxCommand } from "../src/adapters/tmux-exec.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";

// This owns only a fake executable and child in a private home; it never contacts a tmux server.
describe.skipIf(process.platform === "win32")("tmux execution deadline", () => {
it("keeps kill on the shell builtin when PATH has no kill executable", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-tmux-kill-builtin-"));
  vi.stubEnv("PATH", home);
  try { await expect(execTmuxCommand(`kill -0 ${process.pid}`)).resolves.toBe(""); }
  finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); }
});

it.each(["argv", "shell"] as const)("kills a stalled %s client and releases the next operation for that seat", async mode => {
  const home = mkdtempSync(join(tmpdir(), "openrig-tmux-deadline-"));
  const pidFile = join(home, "child.json"), calls = join(home, "calls"), script = join(home, "client.cjs");
  const seat = "deadline-worker@fixture";
  // Exercise both -s meanings without adding more 30-second waits.
  const stalled = mode === "argv" ? ["tmux", "list-panes", "-s", "-t", seat] : ["tmux", "set-option", "-s", "exit-empty", "off"];
  const execute = (argv: string[]) => mode === "argv"
    ? execArgvCommand(argv) : execTmuxCommand(`tmux ${argv.slice(1).map(shellQuote).join(" ")}`);
  writeFileSync(script, `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, process.argv[2] + "\\n");
if (process.argv[2] === ${JSON.stringify(stalled[1])}) {
  process.on("SIGTERM", () => {});
  fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, owner: ${JSON.stringify(home)} }));
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(99), 60000); // Last-resort cleanup if the test process is interrupted.
} else process.stdout.write("next operation completed\\n");
`);
  writeFileSync(join(home, "tmux"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  vi.stubEnv("PATH", `${home}:${process.env.PATH ?? ""}`);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const target = { nodeId: "deadline-node", session: seat, occupant: "g1", pane: "%1" };
  const db = { prepare: () => ({ get: () => undefined, all: () => [] }) };
  const guard = new SeatDeliveryGuard(db as never, name => name === seat ? target : null);
  let pid: number | undefined, settled = false, nextStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = guard.operation(seat, () => execute(stalled))
    .then(value => { settled = true; return { kind: "resolved" as const, value }; },
      error => { settled = true; return { kind: "rejected" as const, error }; });
  let next: Promise<unknown> | undefined;
  const ownedPid = () => {
    const record = JSON.parse(readFileSync(pidFile, "utf8"));
    expect(record.owner).toBe(home);
    expect(Number.isSafeInteger(record.pid) && record.pid > 0).toBe(true);
    return record.pid as number;
  };
  try {
    await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true);
    pid = ownedPid();
    next = guard.operation(seat, async () => {
      nextStarted = true;
      return execute(["tmux", "display-message", "-p", "-t", seat]);
    });
    expect(nextStarted).toBe(false);
    const result = await Promise.race([first, new Promise<{ kind: "not-settled" }>(resolve => {
      timer = setTimeout(() => resolve({ kind: "not-settled" }), 40_000);
    })]);
    expect(result).toMatchObject({ kind: "rejected", error: {
      killed: true, signal: "SIGKILL", message: expect.stringContaining("the write may still have happened. Check with rig capture before resending."),
    } });
    expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/);
    expect(await next).toBe("next operation completed\n");
    expect(nextStarted).toBe(true);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([stalled[1], "display-message"]);
    expect(warn).toHaveBeenCalledWith("[tmux] execution deadline exceeded; client killed", {
      command: stalled[1], target: mode === "argv" ? seat : "(server)", timeoutMs: 30_000,
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (!settled && existsSync(pidFile)) {
      try { process.kill(pid ?? ownedPid(), "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await Promise.allSettled([first, ...(next ? [next] : [])]);
    warn.mockRestore(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
}, 55_000);
});
