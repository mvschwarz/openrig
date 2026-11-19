import { expect, it, vi } from "vitest";
import { chatroomTmuxSelection } from "../src/commands/chatroom.js";
import type { DaemonClient } from "../src/client.js";

function client(local: boolean, tmux: unknown, baseUrl = "http://127.0.0.1:7433") {
  return { baseUrl, isLocalInstance: vi.fn(async () => local), get: vi.fn(async () => ({ status: 200, data: { tmux } })) };
}
it("retains the selected executable prefix and server instead of caller defaults", async () => {
  const command = ["C:/owned tools/psmux.exe", "--prefix"], serverArgs = ["-L", "owned"];
  const c = client(true, { command, serverArgs });
  expect(await chatroomTmuxSelection(c as unknown as DaemonClient)).toEqual({ command, serverArgs });
  expect(c.get).toHaveBeenCalledExactlyOnceWith("/api/terminal/status");
});
it("refuses a forwarded remote identity before consulting launch metadata", async () => {
  const c = client(false, { serverArgs: [] });
  await expect(chatroomTmuxSelection(c as unknown as DaemonClient)).rejects.toThrow("identity");
  expect(c.get).not.toHaveBeenCalled();
});
it("refuses a remote address before consulting local identity", async () => {
  const c = client(true, { serverArgs: [] }, "http://example.invalid:7433");
  await expect(chatroomTmuxSelection(c as unknown as DaemonClient)).rejects.toThrow("daemon's machine");
  expect(c.isLocalInstance).not.toHaveBeenCalled(); expect(c.get).not.toHaveBeenCalled();
});
it.each([undefined, { serverArgs: ["kill-server"] }, { serverArgs: [], command: "shell text" }])("refuses absent or malformed metadata %j", async tmux => {
  await expect(chatroomTmuxSelection(client(true, tmux) as unknown as DaemonClient)).rejects.toThrow();
});
