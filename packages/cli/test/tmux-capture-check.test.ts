// #980: setup and doctor check that tmux can serve `capture-pane -p`. The check is the getting-started guide's: a throwaway
// socket with no config, so the person's own sessions are never touched, and that server is always removed.
import { describe, expect, it } from "vitest";
import { probeTmuxCapture } from "../src/tmux-health.js";

describe("probeTmuxCapture", () => {
  const run = (failure: (cmd: string) => string | null) => {
    const calls: string[] = [];
    const result = probeTmuxCapture((cmd) => {
      calls.push(cmd);
      const message = failure(cmd);
      if (message) throw new Error(message);
      return "";
    }, "openrig-check-test");
    return { result, calls };
  };

  it("passes on a tmux that captures, using only a throwaway socket with no config, and removes that server", () => {
    const { result, calls } = run(() => null);
    expect(result).toEqual({ status: "pass" });
    expect(calls).toEqual([
      "tmux -L openrig-check-test -f /dev/null new-session -d -s check",
      "tmux -L openrig-check-test -f /dev/null capture-pane -p -t check",
      "tmux -L openrig-check-test -f /dev/null kill-server",
    ]);
  });

  it("fails with tmux's own words when its server exits on capture-pane -p, and still tries to remove the server", () => {
    const { result, calls } = run((cmd) => cmd.includes("capture-pane") ? "server exited unexpectedly"
      : cmd.includes("kill-server") ? "no server running on /tmp/tmux-1000/openrig-check-test" : null);
    expect(result).toEqual({ status: "fail", detail: "server exited unexpectedly" });
    expect(calls.at(-1)).toBe("tmux -L openrig-check-test -f /dev/null kill-server");
  });

  it("reports not checked when a throwaway server won't start, without trying to capture", () => {
    const { result, calls } = run((cmd) => cmd.includes("new-session") ? "create window failed" : null);
    expect(result).toEqual({ status: "skipped", detail: "create window failed" });
    expect(calls).toHaveLength(1);
  });
});
