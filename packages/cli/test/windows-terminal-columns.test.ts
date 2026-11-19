import { describe, expect, it, vi } from "vitest";
import { windowsHostingColumns } from "../src/windows-terminal-columns.js";

describe("native piped hosting-terminal width", () => {
  const env = { psmux_target_session: "owned-namespace__viewer", Tmux_Pane: "%2", Path: "selected-path" };
  it("uses the caller's captured session environment, including mixed-case native names", async () => {
    const query = vi.fn(async () => "172\r\n");
    expect(await windowsHostingColumns(env, query)).toBe(172);
    expect(query.mock.calls).toEqual([[env]]);
  });
  it.each([{}, { TMUX_PANE: "%2" }, { PSMUX_TARGET_SESSION: "server" }, { PSMUX_TARGET_SESSION: "server\0other", TMUX_PANE: "%2" }, { PSMUX_TARGET_SESSION: "server", TMUX_PANE: "other:2" }])("does not guess a server or pane from %j", async inherited => {
    const query = vi.fn(async () => "172");
    expect(await windowsHostingColumns(inherited, query)).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["", "0", "-1", "12.5", "Infinity", "9007199254740992", "120 extra"])("keeps invalid measurement %s unknown", async output => {
    expect(await windowsHostingColumns(env, async () => output)).toBeUndefined();
  });
  it("keeps unavailable measurement unknown", async () => {
    expect(await windowsHostingColumns(env, async () => { throw new Error("server gone"); })).toBeUndefined();
  });
});
