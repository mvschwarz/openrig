import { describe, expect, it, vi } from "vitest";
import { exitPaneRuntime } from "../src/domain/runtime-exit.js";
import { terminatePaneInPlace } from "../src/domain/pane-cutover.js";
import { codexPane, timing } from "./fixtures/runtime-exit-pane.js";

// The runtime's own exit may fail; the existing pane stop still proceeds and must say what it proved.
describe("Pending runtime exit and fallback reporting", () => {
  function unreadableRefusal() {
    const pane = codexPane();
    pane.afterTyping = () => null;
    const tmux = pane.tmux();
    tmux.signalPaneRuntime = vi.fn(async () => ({
      ok: false as const, code: "process_changed", message: "injected identity observation unavailable",
    }));
    return { pane, tmux };
  }

  it("reports the unsent command when readback and runtime TERM both fail", async () => {
    const { pane, tmux } = unreadableRefusal();
    const result = await exitPaneRuntime(tmux, { pane: "%1", inputTarget: "%1", runtime: "codex" }, timing, pane.list);
    expect(pane.effects).toEqual(["type /exit (keys)"]);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(result?.state).toBe("not_identified");
    expect(result?.detail).toMatch(/typed \/exit.*Enter wasn't sent/);
  });

  it("proceeds through the existing root fallback and reports forced, even if TERM ends that shell", async () => {
    const { pane, tmux } = unreadableRefusal();
    tmux.signalPaneProcess = vi.fn(async () => {
      pane.dead = true;
      pane.rows = [pane.rows[0]!];
      return { ok: true as const };
    });
    const result = await terminatePaneInPlace(tmux, "%1", timing, "Retiree", "%1", { runtime: "codex", listProcesses: pane.list });
    expect(pane.dead).toBe(true);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, path: "forced" });
    if (result.ok) expect(result.detail).toMatch(/Enter wasn't sent/);
  });

  it("ends the retired interactive shell and keeps the pending-command reason", async () => {
    const { pane, tmux } = unreadableRefusal();
    const result = await terminatePaneInPlace(tmux, "%1", timing, "Retiree", "%1", { runtime: "codex", listProcesses: pane.list });
    expect(pane.dead).toBe(true);
    expect(pane.effects).toEqual(["remain-on-exit", "type /exit (keys)", "root TERM", "root KILL"]);
    expect(result).toMatchObject({ ok: true, path: "forced" });
    if (result.ok) expect(result.detail).toMatch(/Enter wasn't sent/);
  });
});
