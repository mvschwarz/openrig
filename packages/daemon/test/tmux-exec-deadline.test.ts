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
  const execute = (verb: string) => mode === "argv"
    ? execArgvCommand(["tmux", verb, "-p", "-t", seat])
    : execTmuxCommand(`tmux ${verb} -p -t ${shellQuote(seat)}`);
  writeFileSync(script, `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, process.argv[2] + "\\n");
if (process.argv[2] === "capture-pane") {
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
  const first = guard.operation(seat, () => execute("capture-pane"))
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
      return execute("display-message");
    });
    expect(nextStarted).toBe(false);
    const result = await Promise.race([first, new Promise<{ kind: "not-settled" }>(resolve => {
      timer = setTimeout(() => resolve({ kind: "not-settled" }), 40_000);
    })]);
    expect(result).toMatchObject({ kind: "rejected", error: { killed: true, signal: "SIGKILL" } });
    expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/);
    expect(await next).toBe("next operation completed\n");
    expect(nextStarted).toBe(true);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["capture-pane", "display-message"]);
    const warnings = JSON.stringify(warn.mock.calls);
    expect(warnings).toContain("capture-pane");
    expect(warnings).toContain(seat);
    expect(warnings).toContain("30000");
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
