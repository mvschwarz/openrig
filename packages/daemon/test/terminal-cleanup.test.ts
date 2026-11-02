import { afterEach, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { stopTerminalSessionForCleanup } from "../src/terminal-cleanup-surface.js";

afterEach(() => vi.restoreAllMocks());
it("accepts the backend's positive no-server diagnostic after the last session ends", async () => {
  vi.spyOn(TmuxAdapter.prototype, "probeSession").mockResolvedValueOnce({ state: "present" })
    .mockResolvedValueOnce({ state: "transport_unavailable", cause: "no server running on /owned/socket" });
  vi.spyOn(TmuxAdapter.prototype, "killSession").mockResolvedValue({ ok: true });
  expect(await stopTerminalSessionForCleanup("owned", ["-S", "/owned/socket"])).toBe("stopped");
});
it("keeps a permission diagnostic unknown without sending a kill", async () => {
  vi.spyOn(TmuxAdapter.prototype, "probeSession").mockResolvedValue({ state: "transport_unavailable", cause: "permission denied on /owned/socket" });
  const kill = vi.spyOn(TmuxAdapter.prototype, "killSession");
  expect(await stopTerminalSessionForCleanup("owned", ["-S", "/owned/socket"])).toBe("unknown"); expect(kill).not.toHaveBeenCalled();
});
it("does not kill a positively absent session", async () => {
  vi.spyOn(TmuxAdapter.prototype, "probeSession").mockResolvedValue({ state: "absent" });
  const kill = vi.spyOn(TmuxAdapter.prototype, "killSession");
  expect(await stopTerminalSessionForCleanup("owned|logical", ["-L", "owned"])).toBe("missing");
  expect(kill).not.toHaveBeenCalled();
});
it("requires observed disappearance after a successful stop", async () => {
  vi.spyOn(TmuxAdapter.prototype, "probeSession").mockResolvedValueOnce({ state: "present" }).mockResolvedValueOnce({ state: "absent" });
  const kill = vi.spyOn(TmuxAdapter.prototype, "killSession").mockResolvedValue({ ok: true });
  expect(await stopTerminalSessionForCleanup("owned|logical")).toBe("stopped");
  expect(kill).toHaveBeenCalledExactlyOnceWith("owned|logical");
});
it("does not turn a surviving session into confirmed cleanup", async () => {
  vi.spyOn(TmuxAdapter.prototype, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(TmuxAdapter.prototype, "killSession").mockResolvedValue({ ok: true });
  expect(await stopTerminalSessionForCleanup("owned|logical")).toBe("unknown");
});
it("does not turn a transport error into absence", async () => {
  vi.spyOn(TmuxAdapter.prototype, "probeSession").mockRejectedValue(new Error("transport denied"));
  const kill = vi.spyOn(TmuxAdapter.prototype, "killSession");
  expect(await stopTerminalSessionForCleanup("owned|logical")).toBe("unknown");
  expect(kill).not.toHaveBeenCalled();
});
