import { describe, it, expect, vi } from "vitest";
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
    return "";
  });
  return { adapter: new TmuxAdapter(exec, fileOps), fileOps, files, commands, scriptPath };
}

describe("shell launch transport", () => {
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

  it.each(["load-buffer", "paste-buffer", "'Enter'"])("removes the unconsumed script when %s fails", async failure => {
    const f = fixture(failure);
    expect(await f.adapter.sendShellCommand("pane", "codex resume 'same-id'")).toMatchObject({ ok: false });
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
