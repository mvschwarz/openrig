import { describe, it, expect, vi } from "vitest";
import { TmuxAdapter, type ArgvExecFn } from "../src/adapters/tmux.js";

function memFs() {
  return {
    writeFile: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    tmpName: () => "/tmp/text.txt",
    bufferName: () => "buf1",
  };
}

/** Adapter wired to the argv path with a capturing fake (the fake-tmux
 *  harness shape: assert exact argv, no shell layer). */
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

describe("tmux argv exec path", () => {
  it("createSession passes cwd/env as verbatim argv units", async () => {
    const seen: string[][] = [];
    const { adapter, exec } = argvAdapter(seen);
    await adapter.createSession("r01-dev1-impl", "/home/user/my project/code", { PATH: "/a b:/c", EMPTY: "" });
    expect(exec).not.toHaveBeenCalled();
    expect(seen).toEqual([[
      "tmux", "new-session", "-d", "-s", "r01-dev1-impl",
      "-c", "/home/user/my project/code",
      "-e", "PATH=/a b:/c", "-e", "EMPTY=",
    ]]);
  });

  it("sendKeys passes key names as separate verbatim units", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen);
    await adapter.sendKeys("dev'qa@rig", ["Enter; rm -rf /", "C-c"]);
    expect(seen).toEqual([["tmux", "send-keys", "-t", "dev'qa@rig", "Enter; rm -rf /", "C-c"]]);
  });

  it("pipe-pane sink travels as ONE unit with inner quoting intact", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen);
    await adapter.startPipePane("seat@rig", "/tmp/out dir/x.log");
    expect(seen).toEqual([["tmux", "pipe-pane", "-t", "seat@rig", "cat >> '/tmp/out dir/x.log'"]]);
  });

  it("respawn keeps the command as ONE trailing unit", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen);
    await adapter.respawnPane("%1", "codex resume 'tok en'", { cwd: "/w", env: { A: "b c" } });
    expect(seen).toEqual([["tmux", "respawn-pane", "-t", "%1", "-c", "/w", "-e", "A=b c", "codex resume 'tok en'"]]);
  });

  it("capture and display probes build atomic argv (no shell join artifacts)", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen, () => "output");
    await adapter.capturePaneContent("%1", 20);
    await adapter.getPaneCommand("%1");
    await adapter.killSession("r01-dev1-impl");
    expect(seen).toEqual([
      ["tmux", "capture-pane", "-p", "-t", "%1", "-S", "-20"],
      ["tmux", "display-message", "-p", "-t", "%1", "#{pane_current_command}"],
      ["tmux", "kill-session", "-t", "r01-dev1-impl"],
    ]);
    // Every unit must survive a shell WITHOUT quoting: argv elements are
    // atomic by construction — the join layer adds nothing.
    for (const argv of seen) {
      expect(argv[0]).toBe("tmux");
      expect(argv.length).toBeGreaterThan(1);
    }
  });

  it("sendText still stages through buffer files on the argv path", async () => {
    const seen: string[][] = [];
    const fs = memFs();
    const exec = vi.fn(async (_cmd: string) => {
      throw new Error("string exec must not run on the argv path");
    });
    const adapter = new TmuxAdapter(exec, fs, async (argv) => {
      seen.push(argv);
      return "";
    });
    await adapter.sendText("dev", "hello");
    expect(exec).not.toHaveBeenCalled();
    expect(seen).toEqual([
      ["tmux", "load-buffer", "-b", "buf1", "/tmp/text.txt"],
      ["tmux", "paste-buffer", "-t", "dev", "-b", "buf1", "-d", "-r", "-p"],
    ]);
  });
});
