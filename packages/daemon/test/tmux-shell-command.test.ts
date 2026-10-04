import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";

function fixture(fail?: string, scriptPath = "/tmp/launch 'quoted'.sh") {
  const files = new Map<string, string>();
  let names = 0;
  const fileOps: TmuxFileOps = {
    tmpName: () => names++ === 0 ? scriptPath : "/tmp/paste.txt",
    bufferName: () => "buffer",
    writeFile: vi.fn(async (path, text) => { files.set(path, text); }),
    unlink: vi.fn(async path => { files.delete(path); }),
  };
  const commands: string[] = [];
  const exec = vi.fn(async (command: string) => {
    commands.push(command);
    if (fail && command.includes(fail)) throw new Error("transport refused");
    if (command.includes("#{pane_current_command}")) return "bash";
    return "";
  });
  return { adapter: new TmuxAdapter(exec, fileOps), fileOps, files, commands, scriptPath };
}

describe("shell launch transport", () => {
  it.each(["fish", "-fish"])("selects fish sourcing or the older-fish sh fallback before launching (%s)", async shell => {
    const f = fixture();
    vi.spyOn(f.adapter, "getPaneCommand").mockResolvedValue(shell);
    const command = `OPENRIG_HOME='/instance' PATH='/rig/bin':"$PATH" claude --model '${"m".repeat(4096)}'`;
    expect(await f.adapter.sendShellCommand("pane", command, undefined, { sourceInPane: true })).toEqual({ ok: true });
    const invocation = vi.mocked(f.fileOps.writeFile).mock.calls[1]![1];
    const quotedPath = shellQuote(f.scriptPath);
    expect(invocation).toBe(`if eval 'OPENRIG_FISH_ASSIGNMENT_PROBE=1 /bin/true'; source ${quotedPath}; else; /bin/sh ${quotedPath}; end`);
    expect(Buffer.byteLength(invocation)).toBeLessThan(512);
    expect(f.files.get(f.scriptPath)).toBe(`/bin/rm -f -- '/tmp/launch '\"'\"'quoted'\"'\"'.sh'\n${command}\n`);
    expect(f.commands.at(-1)).toBe("tmux send-keys -t 'pane' 'Enter'");
  });

  it.each(["pair\\\\backslashes", "trailing\\", "quote\\'backslash"])("keeps a backslash payload on sh without changing its value (%s)", async value => {
    const root = mkdtempSync(join(tmpdir(), "fish-staging-"));
    try {
      const f = fixture(undefined, join(root, "launch.sh"));
      vi.spyOn(f.adapter, "getPaneCommand").mockResolvedValue("fish");
      const command = `VALUE=${shellQuote(value)} /bin/sh -c 'printf %s "$VALUE"'`;
      expect(await f.adapter.sendShellCommand("pane", command, undefined, { sourceInPane: true })).toEqual({ ok: true });
      expect(vi.mocked(f.fileOps.writeFile).mock.calls[1]![1]).toBe(`/bin/sh ${shellQuote(f.scriptPath)}`);
      // Execute the selected POSIX payload with a real shell, not a quoting model.
      expect(execFileSync("/bin/sh", ["-c", f.files.get(f.scriptPath)!], { encoding: "utf8" })).toBe(value);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the existing sh invocation for a backslash staging path", async () => {
    const f = fixture(undefined, "/tmp/launch\\\\tail\\");
    vi.spyOn(f.adapter, "getPaneCommand").mockResolvedValue("fish");
    expect(await f.adapter.sendShellCommand("pane", "claude", undefined, { sourceInPane: true })).toEqual({ ok: true });
    expect(vi.mocked(f.fileOps.writeFile).mock.calls[1]![1]).toBe(`/bin/sh ${shellQuote(f.scriptPath)}`);
    expect(f.files.get(f.scriptPath)).toBe(`/bin/rm -f -- ${shellQuote(f.scriptPath)}\nclaude\n`);
  });

  it("keeps the short sh invocation when fish fallback syntax would exceed the input bound", async () => {
    const f = fixture(undefined, "/tmp/" + "p".repeat(240));
    vi.spyOn(f.adapter, "getPaneCommand").mockResolvedValue("fish");
    expect(await f.adapter.sendShellCommand("pane", "claude", undefined, { sourceInPane: true })).toEqual({ ok: true });
    const invocation = vi.mocked(f.fileOps.writeFile).mock.calls[1]![1];
    expect(invocation).toBe(`/bin/sh ${shellQuote(f.scriptPath)}`);
    expect(Buffer.byteLength(invocation)).toBeLessThan(512);
  });

  it("keeps ordinary staging unchanged in fish without sourceInPane", async () => {
    const f = fixture();
    const paneCommand = vi.spyOn(f.adapter, "getPaneCommand").mockResolvedValue("fish");
    expect(await f.adapter.sendShellCommand("pane", "codex")).toEqual({ ok: true });
    expect(paneCommand).not.toHaveBeenCalled();
    expect(vi.mocked(f.fileOps.writeFile).mock.calls[1]![1]).toBe(`/bin/sh '/tmp/launch '\"'\"'quoted'\"'\"'.sh'`);
  });

  it.each(["nu", "unknown", "pwsh", null])("retains /bin/sh staging when the pane reports %s", async shell => {
    const f = fixture();
    vi.spyOn(f.adapter, "getPaneCommand").mockResolvedValue(shell);
    expect(await f.adapter.sendShellCommand("pane", "claude", undefined, { sourceInPane: true })).toEqual({ ok: true });
    expect(vi.mocked(f.fileOps.writeFile).mock.calls[1]![1]).toBe(`/bin/sh '/tmp/launch '\"'\"'quoted'\"'\"'.sh'`);
  });

  it("retains /bin/sh staging when the pane command read fails", async () => {
    const f = fixture("display-message");
    expect(await f.adapter.sendShellCommand("pane", "claude", undefined, { sourceInPane: true })).toEqual({ ok: true });
    expect(vi.mocked(f.fileOps.writeFile).mock.calls[1]![1]).toBe(`/bin/sh '/tmp/launch '\"'\"'quoted'\"'\"'.sh'`);
  });

  it.each(["bash", "zsh", "sh", "dash", "ksh", "-bash"])("retains subshell sourcing for a reported POSIX shell (%s)", async shell => {
    const f = fixture();
    vi.spyOn(f.adapter, "getPaneCommand").mockResolvedValue(shell);
    expect(await f.adapter.sendShellCommand("pane", "claude", undefined, { sourceInPane: true })).toEqual({ ok: true });
    expect(vi.mocked(f.fileOps.writeFile).mock.calls[1]![1]).toBe(`( . '/tmp/launch '\"'\"'quoted'\"'\"'.sh' )`);
  });

  it("keeps long PATH/quoted arguments out of terminal input and retains script until consumption", async () => {
    const f = fixture();
    const command = `env PATH='${"p".repeat(4096)}' codex -s workspace-write resume 'same-native-id' -m 'chosen-model'`;
    expect(await f.adapter.sendShellCommand("pane", command)).toEqual({ ok: true });
    expect(f.fileOps.writeFile).toHaveBeenNthCalledWith(1, f.scriptPath,
      `/bin/rm -f -- '/tmp/launch '\"'\"'quoted'\"'\"'.sh'\n${command}\n`, { mode: 0o600, flag: "wx" });
    const invocation = vi.mocked(f.fileOps.writeFile).mock.calls[1]![1];
    expect(Buffer.byteLength(invocation)).toBeLessThan(512);
    expect(invocation).toBe(`/bin/sh '/tmp/launch '\"'\"'quoted'\"'\"'.sh'`);
    expect(f.files.get(f.scriptPath)).toContain(command);
    expect(f.files.has("/tmp/paste.txt")).toBe(false);
    expect(f.commands.at(-1)).toBe("tmux send-keys -t 'pane' 'Enter'");
  });

  it("sources a long classic command in a pane-shell subshell using the same short-input bound", async () => {
    const f = fixture();
    const command = `OPENRIG_HOME='/instance' claude --model '${"m".repeat(4096)}'`;
    expect(await f.adapter.sendShellCommand("pane", command, undefined, { sourceInPane: true })).toEqual({ ok: true });
    const invocation = vi.mocked(f.fileOps.writeFile).mock.calls[1]![1];
    expect(invocation).toBe(`( . '/tmp/launch '\"'\"'quoted'\"'\"'.sh' )`);
    expect(Buffer.byteLength(invocation)).toBeLessThan(512);
    expect(f.files.get(f.scriptPath)).toBe(`/bin/rm -f -- '/tmp/launch '\"'\"'quoted'\"'\"'.sh'\n${command}\n`);
    expect(f.commands.at(-1)).toBe("tmux send-keys -t 'pane' 'Enter'");
  });

  it.each(["load-buffer", "paste-buffer", "'Enter'"].flatMap(failure => [
    { failure, sourceInPane: false }, { failure, sourceInPane: true },
  ]))("removes the unconsumed script when $failure fails (source=$sourceInPane)", async ({ failure, sourceInPane }) => {
    const f = fixture(failure);
    expect(await f.adapter.sendShellCommand("pane", "inert launch", undefined, { sourceInPane })).toMatchObject({ ok: false });
    expect(f.files.size).toBe(0);
    expect(f.commands.some(command => command.endsWith("'C-c'"))).toBe(failure === "'Enter'");
    expect(f.commands.some(command => command.endsWith("'Enter'"))).toBe(failure === "'Enter'");
  });

  it("refuses an oversized bootstrap path before writing or sending", async () => {
    const f = fixture(undefined, "/tmp/" + "a".repeat(512));
    expect(await f.adapter.sendShellCommand("pane", "codex")).toMatchObject({ ok: false, code: "launch_path_too_long" });
    expect(f.fileOps.writeFile).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });

  it.each([513, 1023])("falls back to direct Pi input for a %i-byte command under a long TMPDIR", async bytes => {
    const f = fixture(undefined, "/tmp/" + "a".repeat(512));
    const command = "é".repeat((bytes - 1) / 2) + "x";
    expect(Buffer.byteLength(command, "utf8")).toBe(bytes);
    expect(await f.adapter.sendShellCommand("pane", command, undefined, { stageIfLong: true, execInScript: true }))
      .toEqual({ ok: true });
    expect(f.fileOps.writeFile).toHaveBeenCalledOnce();
    expect(vi.mocked(f.fileOps.writeFile).mock.calls[0]![1]).toBe(command);
    expect(f.commands.at(-1)).toBe("tmux send-keys -t 'pane' 'Enter'");
  });

  it("refuses a 1024-byte Pi command when its staged invocation exceeds the bound", async () => {
    const f = fixture(undefined, "/tmp/" + "a".repeat(512));
    const command = "é".repeat(512);
    expect(Buffer.byteLength(command, "utf8")).toBe(1024);
    expect(await f.adapter.sendShellCommand("pane", command, undefined, { stageIfLong: true, execInScript: true }))
      .toMatchObject({ ok: false, code: "launch_path_too_long" });
    expect(f.fileOps.writeFile).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });

  it("does not remove a preexisting file when exclusive creation fails", async () => {
    const f = fixture();
    f.files.set(f.scriptPath, "retained bytes");
    vi.mocked(f.fileOps.writeFile).mockRejectedValueOnce(new Error("EEXIST"));
    expect(await f.adapter.sendShellCommand("pane", "codex")).toMatchObject({ ok: false });
    expect(f.files.get(f.scriptPath)).toBe("retained bytes");
    expect(f.fileOps.unlink).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });
});
