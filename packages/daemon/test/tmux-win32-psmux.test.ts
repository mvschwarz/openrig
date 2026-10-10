import { describe, it, expect, vi } from "vitest";
import { TmuxAdapter, qualifiedPaneTarget, type ArgvExecFn } from "../src/adapters/tmux.js";

const onWin32 = process.platform === "win32";

function memFs() {
  return {
    writeFile: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    tmpName: () => "/tmp/text.txt",
    bufferName: () => "buf1",
  };
}

function argvAdapter(seen: string[][], impl?: (argv: string[]) => string) {
  const argvExec: ArgvExecFn = async (argv) => {
    seen.push(argv);
    return impl ? impl(argv) : "";
  };
  const exec = vi.fn(async (_cmd: string) => {
    throw new Error("string exec must not run on the argv path");
  });
  const adapter = new TmuxAdapter(exec, memFs(), argvExec);
  return { adapter, exec };
}

describe("qualifiedPaneTarget (psmux pane-id disambiguation)", () => {
  it("qualifies a bare pane id with session, window and pane index", () => {
    expect(qualifiedPaneTarget("dev-qa@rig", { id: "%1", index: 0, windowIndex: 2, cwd: "", width: 80, height: 24, active: true }))
      .toBe("=dev-qa@rig:2.0");
  });

  it("leaves non-id pane references unchanged", () => {
    const pane = { id: "0", index: 1, windowIndex: 0, cwd: "", width: 80, height: 24, active: false };
    expect(qualifiedPaneTarget("dev-qa@rig", pane)).toBe("0");
  });

  it("passes an already-qualified id through untouched", () => {
    const pane = { id: "%12", index: 3, windowIndex: 1, cwd: "", width: 80, height: 24, active: true };
    expect(qualifiedPaneTarget("s@r", pane)).toBe("=s@r:1.3");
  });
});

describe("win32 psmux staging behavior", () => {
  it.skipIf(!onWin32)("sendShellCommand does NOT stage long commands through /bin/sh on win32 non-POSIX panes", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen);
    // >512 bytes so the POSIX path would stage to a temp script; on win32 the
    // raw command must travel as terminal input instead (/bin/sh does not exist).
    const longCommand = `node 'C:\\proj\\pi-runner.js' --session-name 's@r' ${"--pad ".repeat(80)}--no-approve`;
    expect(longCommand.length).toBeGreaterThan(512);
    await adapter.sendShellCommand("s@r", longCommand, undefined, { stageIfLong: true });
    const sendKeysCalls = seen.filter((argv) => argv[0] === "tmux" && argv[1] === "send-keys");
    expect(sendKeysCalls.length).toBeGreaterThan(0);
    for (const argv of sendKeysCalls) {
      expect(argv.join(" ")).not.toContain("/bin/sh");
      expect(argv.join(" ")).not.toContain("/tmp/text.txt");
    }
  });

  it.skipIf(!onWin32)("probeSession classifies a silent has-session failure as absent (psmux prints nothing)", async () => {
    const seen: string[][] = [];
    // psmux's absent-session contract: non-zero exit with NO diagnostic text.
    const { adapter } = argvAdapter(seen, () => {
      throw new Error("Command failed: tmux has-session -t =gone@r\n");
    });
    const probe = await adapter.probeSession("gone@r");
    expect(probe.state).toBe("absent");
  });

  it.skipIf(!onWin32)("probeSession still fails closed on an unexpected probe error class", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen, () => {
      throw new Error("permission denied");
    });
    await expect(adapter.probeSession("x@r")).rejects.toThrow(/permission denied/);
  });
});
