import { afterEach, describe, it, expect, vi } from "vitest";
import { TmuxAdapter, type ArgvExecFn } from "../src/adapters/tmux.js";

function memFs() {
  return {
    writeFile: vi.fn(async (_path: string, _content: string, _options?: { mode: number; flag: "wx" }) => {}),
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
  afterEach(() => { vi.unstubAllEnvs(); });

  it("createSession preserves cwd/env in a private config", async () => {
    // Without a user runtime directory no systemd user scope is tried (#2710), so the create starts a missing server itself.
    vi.stubEnv("XDG_RUNTIME_DIR", undefined);
    const seen: string[][] = [];
    const files = memFs();
    const exec = vi.fn(async () => { throw new Error("argv only"); });
    // The sourced new-session -P prints its pane.
    const adapter = new TmuxAdapter(exec, files, async args => { seen.push(args); return args.includes("source-file") ? "%1\n" : ""; });
    // A daemon that has already checked its server's bus once (#3253; its first launch is the case below).
    (adapter as unknown as { sessionBusRestorePending: boolean }).sessionBusRestorePending = false;
    await adapter.createSession("r01-dev1-impl", "/home/user/my project/code", { PATH: "/a b:/c", EMPTY: "" });
    expect(exec).not.toHaveBeenCalled();
    // #3253: on Linux the create runs on the running server first (startServer starts a missing one); elsewhere it
    // starts a missing server itself.
    const create = process.platform === "linux" ? ["tmux", "source-file", "/tmp/text.txt"] : ["tmux", "start-server", ";", "source-file", "/tmp/text.txt"];
    expect(seen).toEqual([create, ["tmux", "show-environment", "-g"]]);
    const config = files.writeFile.mock.calls[0]![1];
    expect(config).toBe("new-session -d -s 'r01-dev1-impl' -c '/home/user/my project/code' -e 'OPENRIG_TRANSCRIPTS_LINES=' -e 'OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS=' -e 'PATH=/a b:/c' -e 'EMPTY=' -P -F '#{pane_id}'\n");
  });

  it("#3253: on Linux without a user scope, a create that finds no server has startServer start it, then runs as before", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    vi.stubEnv("XDG_RUNTIME_DIR", undefined);
    vi.stubEnv("MANAGERPID", undefined);
    try {
      const seen: string[][] = [];
      const files = memFs();
      let up = false;
      // Only startServer's `tmux -D` goes through the string exec; it starts the server.
      const exec = vi.fn(async (cmd: string) => { if (/ -D /.test(cmd)) up = true; return ""; });
      const adapter = new TmuxAdapter(exec, files, async args => {
        seen.push(args);
        if (!up) throw new Error(`Command failed: ${args.join(" ")}\nno server running on /tmp/tmux-1000/default`);
        return args.includes("source-file") ? "%1\n" : "";
      });
      // A daemon that has already checked its server's bus once: the server has gone since.
      (adapter as unknown as { sessionBusRestorePending: boolean }).sessionBusRestorePending = false;
      expect(await adapter.createSession("r01-dev1-impl", "/w", {})).toMatchObject({ ok: true });
      expect(exec.mock.calls.map(([cmd]) => cmd)).toEqual(["tmux -D </dev/null >/dev/null 2>&1 &"]);
      const creates = seen.filter(args => args.includes("source-file"));
      expect(creates).toEqual([["tmux", "source-file", "/tmp/text.txt"], ["tmux", "start-server", ";", "source-file", "/tmp/text.txt"]]);
      // The first private config was never read (no server), so it was removed; the second carries the create.
      expect(files.writeFile).toHaveBeenCalledTimes(2);
      expect(files.unlink).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("#3253: on Linux, a daemon's first launch runs startServer first, which checks the running server's bus once", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    vi.stubEnv("XDG_RUNTIME_DIR", undefined);
    vi.stubEnv("MANAGERPID", undefined);
    try {
      const seen: string[][] = [];
      const exec = vi.fn(async () => { throw new Error("argv only"); });
      const adapter = new TmuxAdapter(exec, memFs(), async args => { seen.push(args); return args.includes("source-file") ? "%1\n" : ""; });
      expect(await adapter.createSession("r01-dev1-impl", "/w", {})).toMatchObject({ ok: true });
      expect(seen.map(args => args[1])).toEqual(["has-session", "show-environment", "source-file", "show-environment"]);
      expect(seen[2]).toEqual(["tmux", "source-file", "/tmp/text.txt"]);
      seen.length = 0;
      expect(await adapter.createSession("r01-dev1-impl-b", "/w", {})).toMatchObject({ ok: true });
      expect(seen.map(args => args[1])).toEqual(["source-file", "show-environment"]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("sendKeys passes key names as separate verbatim units", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen);
    await adapter.sendKeys("dev'qa@rig", ["Enter; rm -rf /", "C-c"]);
    expect(seen).toEqual([["tmux", "send-keys", "-t", "dev'qa@rig", "Enter; rm -rf /", "C-c"]]);
  });

  it("sendKeys escapes a trailing semicolon on the argv path too, so both transports agree", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen);
    // The same escaped argument reaches exec's argv and the spawned client's command line: one key,
    // one argument, on either transport.
    await adapter.sendKeys("dev'qa@rig", ["x;", "C-c"]);
    expect(seen).toEqual([["tmux", "send-keys", "-t", "dev'qa@rig", "x\\;", "C-c"]]);
  });

  it("pipe-pane sink travels as ONE unit with inner quoting intact", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen);
    await adapter.startPipePane("seat@rig", "/tmp/out dir/x.log");
    expect(seen).toEqual([["tmux", "pipe-pane", "-t", "=seat@rig:", "cat >> '/tmp/out dir/x.log'"]]);
  });

  it("respawn keeps the command as ONE trailing unit", async () => {
    const seen: string[][] = [];
    const files = memFs();
    const adapter = new TmuxAdapter(async () => "", files, async args => { seen.push(args); return ""; });
    await adapter.respawnPane("%1", "codex resume 'tok en'", { cwd: "/w", env: { A: "b c" } });
    expect(seen).toEqual([["tmux", "show-environment", "-g"], ["tmux", "source-file", "/tmp/text.txt"]]);
    expect(files.writeFile.mock.calls[0]![1]).toBe("respawn-pane -t '%1' -c '/w' -e 'A=b c' 'codex resume '\"'\"'tok en'\"'\"''\n");
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
      ["tmux", "detach-client", "-s", "=r01-dev1-impl"],
      ["tmux", "kill-session", "-t", "=r01-dev1-impl"],
    ]);
    // Every unit must survive a shell WITHOUT quoting: argv elements are
    // atomic by construction — the join layer adds nothing.
    for (const argv of seen) {
      expect(argv[0]).toBe("tmux");
      expect(argv.length).toBeGreaterThan(1);
    }
  });

  it("joins wrapped capture lines on the argv path without changing exact targeting", async () => {
    const seen: string[][] = [];
    const { adapter } = argvAdapter(seen, () => "output");
    await adapter.capturePaneContent("%1", 30, { joinWrappedLines: true });
    expect(seen).toEqual([["tmux", "capture-pane", "-p", "-J", "-t", "%1", "-S", "-30"]]);
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
