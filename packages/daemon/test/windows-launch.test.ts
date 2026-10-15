import { describe, expect, it, vi } from "vitest";
import { parseLiteralLaunchWords, powershellQuote, renderWindowsLaunch, hasOnlyWindowsTerminalResponseDraft } from "../src/adapters/windows-launch.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

describe("literal Windows launch rendering", () => {
  it("recognises only an entirely terminal-response current draft", () => {
    const reply = "]10;rgb:cccc/cccc/cccc\\]11;rgb:0c0c/0c0c/0c0c\\";
    expect(hasOnlyWindowsTerminalResponseDraft(`header\n› ${reply}\n\n footer`)).toBe(true);
    expect(hasOnlyWindowsTerminalResponseDraft(`› ${reply}my draft\n\n`)).toBe(false);
    expect(hasOnlyWindowsTerminalResponseDraft(`› ${reply}\n  my second line\n\n`)).toBe(false);
    expect(hasOnlyWindowsTerminalResponseDraft(`› ${reply}\n\nold answer\n› current draft\n\n`)).toBe(false);
    expect(hasOnlyWindowsTerminalResponseDraft("› normal draft\n\n")).toBe(false);
  });
  it("preserves generated POSIX words, including empty, Unicode and apostrophe arguments", () => {
    expect(parseLiteralLaunchWords(`node 'C:\\project space\\runner.js' '' 'a'"'"'b' '中文;$HOME'`))
      .toEqual(["node", "C:\\project space\\runner.js", "", "a'b", "中文;$HOME"]);
    const launch = renderWindowsLaunch(`node 'C:\\project space\\runner.js' 'x;y'`, { OPENRIG_SESSION_NAME: "seat@rig", PATH: "C:\\bin;C:\\two" });
    expect(launch).toContain("$env:OPENRIG_SESSION_NAME='seat@rig'; $env:PATH='C:\\bin;C:\\two';");
    expect(launch).toContain("$openrigStart.FileName = 'node'");
    expect(launch).toContain('$openrigStart.Arguments = \'"C:\\project space\\runner.js" "x;y"\'');
    expect(powershellQuote("a'b")).toBe("'a''b'");
  });
  it("does not interpret shell syntax as native argv", () => {
    for (const command of ["node x; whoami", "node $(whoami)", 'node "$HOME"', "node x | whoami", "node 'unterminated", ""])
      expect(() => parseLiteralLaunchWords(command)).toThrow();
    expect(() => renderWindowsLaunch("node x", { "BAD;KEY": "x" })).toThrow();
  });
});

describe("psmux PowerShell launch staging", () => {
  it("scopes duplicate psmux pane IDs to the session's server", async () => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => "", undefined, async argv => {
      calls.push(argv);
      return argv.includes("list-panes") ? "seat-a|%1|0|C:\\cwd|80|24|1\n" : "pwsh";
    }, "psmux");
    const pane = (await adapter.listPanes("seat-a"))[0]!;
    await adapter.getPaneCommand(pane.id);
    expect(calls.at(-1)?.slice(0, 3)).toEqual(["tmux", "-t", "=seat-a"]);
    expect(calls.at(-1)).toContain("%1");
    expect(await adapter.readAllPaneProcesses()).toBeNull();
  });
  it("selects only the requested variable from psmux's full environment response", async () => {
    const adapter = new TmuxAdapter(async () => "", undefined,
      async () => "OTHER=private\r\nOPENRIG_NODE_ID=node\r\nOPENRIG_SESSION_NAME=seat@rig\r\n", "psmux");
    expect(await adapter.getSessionEnv("seat@rig", "OPENRIG_NODE_ID")).toBe("node");
    expect(await adapter.getSessionEnv("seat@rig", "MISSING")).toBeUndefined();
  });
  it("stages a native script and sends only its short invocation", async () => {
    const writes: string[][] = [];
    const fileOps = { writeFile: vi.fn(async (_path: string, _text: string) => {}), unlink: vi.fn(async () => {}), tmpName: () => "C:\\temp space\\launch.txt", bufferName: () => "buf" };
    const adapter = new TmuxAdapter(async () => { throw new Error("no POSIX exec"); }, fileOps, async args => { writes.push(args); return "pwsh"; }, "psmux");
    expect(await adapter.sendShellCommand("seat", "& 'node' @('-v')")).toEqual({ ok: true });
    expect(fileOps.writeFile.mock.calls[0]?.[1]).toContain("Remove-Item -LiteralPath 'C:\\temp space\\launch.txt'");
    expect(fileOps.writeFile.mock.calls[0]?.[1]).not.toContain("/bin/");
    expect(fileOps.writeFile.mock.calls[1]?.[1]).toContain("[scriptblock]::Create");
    expect(writes.some(argv => argv[1] === "send-keys" && argv.at(-1) === "Enter")).toBe(true);
    expect(fileOps.unlink).toHaveBeenCalledTimes(1); // the paste buffer file only; the consumed script owns its cleanup
  });
  it("rejects an unsupported pane before typing a native command", async () => {
    const fileOps = { writeFile: vi.fn(async () => {}), unlink: vi.fn(async () => {}), tmpName: () => "C:\\temp\\launch.txt", bufferName: () => "buf" };
    const adapter = new TmuxAdapter(async () => "", fileOps, async () => "cmd", "psmux");
    expect(await adapter.sendShellCommand("seat", "node -v")).toMatchObject({ ok: false, code: "unsupported_windows_pane" });
    expect(fileOps.writeFile).not.toHaveBeenCalled();
  });
});
