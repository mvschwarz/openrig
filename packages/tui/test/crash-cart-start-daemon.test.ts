import { readFileSync } from "node:fs";
import * as lifecycleBudget from "../../daemon/src/daemon-shutdown.js";
import { describe, it, expect } from "vitest";
import { daemonStartArgs } from "../src/crash-cart/start-daemon.js";
import { resolveCrashCartKey } from "../src/crash-cart/keys.js";

describe("local startup target", () => {
  it("starts only the intended local daemon, leaving occupant selection to the user", () => {
    // The default bind is 127.0.0.1 plus Tailscale when present, so naming 127.0.0.1 would drop the Tailscale listener.
    expect(daemonStartArgs("http://127.0.0.1:17433")).toEqual([
      "daemon", "start", "--no-kernel", "--port", "17433",
    ]);
  });
  it.each([["http://localhost:7433", "localhost"], ["http://[::1]:7433", "::1"]])(
    "names %s's host, which the default bind doesn't listen on", (target, host) => {
      expect(daemonStartArgs(target)).toEqual(["daemon", "start", "--no-kernel", "--host", host, "--port", "7433"]);
    },
  );
  it.each(["https://example.test", "http://10.0.0.2:7433", "http://user:password@localhost:7433", "http://localhost:7433/other"])(
    "does not turn %s into local startup authority", (target) => {
      expect(() => daemonStartArgs(target)).toThrow("no local daemon was started");
    },
  );
  it("unavailable prerequisites permit inspection/retry but no recovery effects", () => {
    const opts = { unavailable: "native load failed" };
    expect(resolveCrashCartKey("r", opts)).toBe("retry");
    expect(resolveCrashCartKey("d", opts)).toBe("details");
    for (const key of ["s", "n", "enter", "i"]) expect(resolveCrashCartKey(key, opts)).toBeNull();
  });
});

// The launcher must survive the CLI's current-child wait and cleanup budget.
describe("daemon start caller budget", () => {
  it("derives the caller timeout from the same wait/probe budgets as the CLI, with cleanup and margin", () => {
    const budget = lifecycleBudget as unknown as Record<string, number>;
    expect(budget.DAEMON_START_READINESS_WAIT_MS).toBe(180_000);
    expect(budget.DAEMON_START_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(
      budget.DAEMON_START_READINESS_WAIT_MS! + budget.DAEMON_START_PROBE_TIMEOUT_MS! + budget.DAEMON_STOP_WAIT_MS! + 5_000,
    );
    const source = readFileSync(new URL("../../cli/src/daemon-lifecycle.ts", import.meta.url), "utf8");
    expect(source).toContain("DAEMON_START_READINESS_WAIT_MS as STARTUP_READINESS_DEADLINE_MS");
    expect(source).toContain("DAEMON_START_PROBE_TIMEOUT_MS as STARTUP_PROBE_TIMEOUT_MS");
  });

  it("uses that timeout for all three asynchronous TUI daemon-start calls", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source.match(/timeout: DAEMON_START_COMMAND_TIMEOUT_MS/g)).toHaveLength(3);
    expect(source).not.toMatch(/execFileSync/);
  });
});
