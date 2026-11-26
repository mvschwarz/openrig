import { describe, expect, it, vi } from "vitest";
import { hasLiveAttachments, type WindowDeps } from "../src/terminal-window.js";
import { windowsTileAttachArgv } from "../../daemon/src/domain/terminal/windows-tile-attach.js";

describe("native multi-server Herdr attachment proof", () => {
  function fixture() {
    const tmux = "C:\\Program Files\\psmux\\tmux.exe", server = ["-L", "owned"];
    const tab = { workspace_id: "space", tab_id: "tab", label: "page-1" };
    const pages = [["first session", "second session"].map((session, index) => ({ seat: session, label: session, paneCommand: `recovery-${index}`,
      attachArgv: windowsTileAttachArgv(tmux, server, session, index === 1) }))];
    const clients = vi.fn(async (session: string) => session === "=first session" ? "101\tfirst session\t0\r\n" : "102\tsecond session\t1\r\n");
    const deps: WindowDeps = { platform: "win32", env: {}, exists: () => true, launch: async () => {}, sleep: async () => {}, id: () => "unused", herdrConfig: () => "unused",
      exec: vi.fn(async (file, args) => {
        if (file === tmux) { expect(args.slice(0, 3)).toEqual([...server, "list-clients"]); return clients(args[4]!); }
        if (args.includes("process-info")) { const id = args.at(-1)!; return JSON.stringify({ result: { process_info: { pane_id: id, foreground_processes: [{ pid: id === "p1" ? 101 : 102 }] } } }); }
        return JSON.stringify({ result: { panes: ["p1", "p2"].map(pane_id => ({ workspace_id: "space", tab_id: "tab", pane_id })) } });
      }) };
    return { clients, deps, pages, run: () => hasLiveAttachments(tab, [tab], pages, () => "page-1", [], deps, server) };
  }
  it("proves both independent session servers, preserving exact names and read-only mode", async () => {
    const f = fixture(); expect(await f.run()).toBe(true);
    expect(f.clients.mock.calls).toEqual([["=first session"], ["=second session"]]);
  });
  it.each(["102\twrong server\t1", "102\tsecond session\t0", "", "101\tsecond session\t1"])("refuses an unproven second attachment %s", async response => {
    const f = fixture(); f.clients.mockImplementation(async session => session === "=first session" ? "101\tfirst session\t0" : response);
    expect(await f.run()).toBe(false);
  });
  it("does not fall back to the default server after a target query fails", async () => {
    const f = fixture(); f.clients.mockRejectedValue(new Error("gone"));
    expect(await f.run()).toBe(false); expect(f.clients).toHaveBeenCalledTimes(1);
  });
});
