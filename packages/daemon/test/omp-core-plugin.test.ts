import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
// @ts-expect-error OMP loads the shipped plain JavaScript extension.
import openrigCore, { runRefocus } from "../assets/plugins/openrig-core/omp/index.js";
function fixture(seat = true, kind = "main", budget?: string) {
  const handlers: Record<string, Function> = {}, commands: Record<string, any> = {};
  const refocus = vi.fn().mockResolvedValue("context");
  const pi = { on: (n: string, f: Function) => { handlers[n] = f; }, registerCommand: (n: string, c: unknown) => { commands[n] = c; }, sendMessage: vi.fn() };
  openrigCore(pi, { env: { ...(seat ? { OPENRIG_SESSION_NAME: "seat" } : {}), OPENRIG_REFOCUS_BUDGET_MS: budget }, runRefocus: refocus });
  return { handlers, commands, refocus, pi, ctx: { agent: { kind }, ui: { notify: vi.fn() } } };
}
describe("OMP core refocus", () => {
  it.each([[false, "main"], [true, "subagent"]] as const)("ignores non-seat or child conversation (%s, %s)", async (seat, kind) => {
    const f = fixture(seat, kind, "52000");
    await f.handlers.session_start({}, f.ctx);
    expect(f.ctx.ui.notify).not.toHaveBeenCalled();
    await f.handlers.session_compact({}, f.ctx);
    expect(await f.handlers.before_agent_start({ prompt: "continue" }, f.ctx)).toBeUndefined();
    await f.commands.refocus.handler("", f.ctx);
    expect(f.refocus).not.toHaveBeenCalled();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
  });
  it("records compaction, skips revive, and delivers at the next real prompt", async () => {
    const f = fixture();
    await f.handlers.session_compact({}, f.ctx);
    expect(f.refocus.mock.calls[0][0]).toMatchObject({ hook_event_name: "PostCompact" });
    expect(await f.handlers.before_agent_start({ reason: "revive" }, f.ctx)).toBeUndefined();
    expect(f.refocus).toHaveBeenCalledTimes(1);
    expect(await f.handlers.before_agent_start({ prompt: "continue" }, f.ctx)).toEqual({ message: { customType: "openrig-refocus", content: "context", display: true } });
    f.refocus.mockResolvedValue(null);
    expect(await f.handlers.before_agent_start({ prompt: "continue" }, f.ctx)).toBeUndefined();
  });
  it.each([["52000", true], ["24000", false], [undefined, false]] as const)(
    "reports the effective native budget at session start when %s exceeds the limit", async (budget, capped) => {
      const f = fixture(true, "main", budget);
      await f.handlers.session_start({}, f.ctx);
      if (capped) expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/52000.*24000/), "warning");
      else expect(f.ctx.ui.notify).not.toHaveBeenCalled();
    });

  it("/refocus starts a turn only when the hook returns context", async () => {
    const f = fixture();
    await f.commands.refocus.handler("", f.ctx);
    expect(f.refocus.mock.calls[0][1]).toMatchObject({ now: true });
    expect(f.pi.sendMessage).toHaveBeenCalledWith({ customType: "openrig-refocus", content: "context", display: true }, { triggerTurn: true });
    f.refocus.mockResolvedValue(null);
    await f.commands.refocus.handler("", f.ctx);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.ctx.ui.notify).toHaveBeenCalled();
  });
  it.each([0, 1])("accepts output only after successful exit (%s)", async code => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn() });
    const result = runRefocus({}, { spawn: () => child });
    child.stdout.emit("data", JSON.stringify({ hookSpecificOutput: { additionalContext: "context" } }));
    child.emit("close", code);
    expect(await result).toBe(code === 0 ? "context" : null);
  });
  it("keeps split UTF-8 and limits the helper budget inside the handler deadline", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { on: vi.fn(), end: vi.fn() } });
    const spawn = vi.fn(() => child);
    const result = runRefocus({}, { spawn, env: { OPENRIG_REFOCUS_BUDGET_MS: "30000" } });
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ env: { OPENRIG_REFOCUS_BUDGET_MS: "24000" } }));
    const output = Buffer.from(JSON.stringify({ hookSpecificOutput: { additionalContext: "å🌍" } }));
    const split = output.indexOf(Buffer.from("🌍")) + 2;
    child.stdout.emit("data", output.subarray(0, split)); child.stdout.emit("data", output.subarray(split));
    child.emit("close", 0);
    expect(await result).toBe("å🌍");
  });
  it("settles timeout even if the child never closes", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn() });
    expect(await runRefocus({}, { spawn: () => child, timeoutMs: 5 })).toBeNull();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("settles a failed spawn without failing the prompt", async () => {
    expect(await runRefocus({}, { spawn: () => { throw new Error("missing executable"); } })).toBeNull();
  });
});
