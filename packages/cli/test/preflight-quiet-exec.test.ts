// A first `rig daemon start` on a machine with no tmux server yet printed tmux's "error connecting to …" line: the
// preflight's execSync had no stdio, so Node copied the probe's stderr to the terminal. The probe still needs that
// text to tell "no server yet" from a broken server, so it must arrive in the thrown error and nowhere else.
import { describe, it, expect, vi, afterEach } from "vitest";
import { quietPreflightExec } from "../src/system-preflight.js";
import { probeTmuxControlAsync } from "../src/tmux-health.js";

const node = JSON.stringify(process.execPath);
const failWith = (text: string) => `${node} -e "process.stderr.write(${JSON.stringify(text).replaceAll('"', '\\"')}); process.exit(1)"`;

describe("quietPreflightExec", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps a failing probe's stderr off the terminal and in the error", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
    const noServer = "error connecting to /private/tmp/tmux-503/default (No such file or directory)";
    await expect(quietPreflightExec(failWith(noServer))).rejects.toThrow(/error connecting to/);
    expect(writes.join("")).not.toContain("error connecting to");
  });

  it("still lets the tmux probe tell no server yet from a broken server", async () => {
    const run = (stderr: string) => probeTmuxControlAsync(async (cmd) =>
      cmd === "tmux -V" ? "tmux 3.4" : quietPreflightExec(failWith(stderr)));
    expect((await run("error connecting to /tmp/tmux-1/default (No such file or directory)")).code).toBe("no_server");
    expect(await run("server exited unexpectedly")).toMatchObject({ code: "unhealthy", available: false, detail: expect.stringContaining("server exited unexpectedly") });
  });
});
