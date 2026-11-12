import { describe, expect, it } from "vitest";
import { viewerTerminalEnv, type ViewerEnvironmentDeps } from "../src/terminals/open-window.js";

describe("shared viewer identity selection", () => {
  function fixture(rows: string[]) {
    const targets: string[] = [], reads: number[] = [];
    const deps: ViewerEnvironmentDeps = {
      platform: "win32", env: { tmux_pane: "%0", psmux_target_session: "owned session:one" },
      listClients: async target => { targets.push(target); return rows.length > 1 ? rows.shift()! : rows[0]!; },
      readClientEnvironment: async pid => { reads.push(pid); return { Term_Program: "herdr", HERDR_PANE_ID: "viewer", PRIVATE_SENTINEL: "never forwarded" }; },
    };
    return { deps, targets, reads };
  }
  it("pins Windows lookup to its inherited session, excludes control clients, and forwards only markers", async () => {
    const f = fixture(["9 123 0\r\n10 456 0\r\n99 789 1\r\n"]);
    expect(await viewerTerminalEnv(f.deps)).toEqual({ TERM_PROGRAM: "herdr", HERDR_PANE_ID: "viewer" });
    expect(f.targets).toEqual(["=owned session:one", "=owned session:one"]);
    expect(f.reads).toEqual([456]);
  });
  it.each(["1 123 0\n1 456 0", "9 0 0", "9 NaN 0", "9 123 2", "9 2147483648 0", "9 123 1", ""])("does not inspect an ambiguous/invalid client list %s", async rows => {
    const f = fixture([rows]);
    expect(await viewerTerminalEnv(f.deps)).toBeUndefined();
    expect(f.reads).toEqual([]);
  });
  it.each(["10 456 0", "", "10 123 0\n10 456 0"])("rejects a client that changed while its markers were read: %s", async changed => {
    const f = fixture(["9 123 0", changed]);
    expect(await viewerTerminalEnv(f.deps)).toBeUndefined();
    expect(f.reads).toEqual([123]);
  });
  it("does not guess a Windows server from a bare pane or TMUX socket", async () => {
    const f = fixture(["9 123 0"]); f.deps.env = { TMUX_PANE: "%0", TMUX: "some socket,1,0" };
    expect(await viewerTerminalEnv(f.deps)).toBeUndefined(); expect(f.targets).toEqual([]);
  });
  it("retains Linux pane/socket lookup and suppresses an unreadable client", async () => {
    const f = fixture(["9 123 0"]);
    f.deps.platform = "linux"; f.deps.env = { TMUX: "/owned/socket,1,0", TMUX_PANE: "%2" };
    f.deps.readClientEnvironment = async () => { throw new Error("denied"); };
    expect(await viewerTerminalEnv(f.deps)).toBeUndefined(); expect(f.targets).toEqual(["%2"]);
  });
});
