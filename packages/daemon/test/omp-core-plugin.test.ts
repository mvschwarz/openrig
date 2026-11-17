import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
// @ts-expect-error OMP loads the shipped plain JavaScript extension.
import openrigCore, { runRefocus } from "../assets/plugins/openrig-core/omp/index.js";
function fixture(seat = true, kind = "main") {
  const handlers: Record<string, Function> = {}, commands: Record<string, any> = {};
  const refocus = vi.fn().mockResolvedValue("context");
  const pi = { on: (n: string, f: Function) => { handlers[n] = f; }, registerCommand: (n: string, c: unknown) => { commands[n] = c; }, sendMessage: vi.fn() };
  openrigCore(pi, { env: seat ? { OPENRIG_SESSION_NAME: "seat" } : {}, runRefocus: refocus });
  return { handlers, commands, refocus, pi, ctx: { agent: { kind }, ui: { notify: vi.fn() } } };
}
describe("OMP core refocus", () => {
  it.each([[false, "main"], [true, "subagent"]] as const)("ignores non-seat or child conversation (%s, %s)", async (seat, kind) => {
    const f = fixture(seat, kind);
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
  it("settles timeout even if the child never closes", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn() });
    expect(await runRefocus({}, { spawn: () => child, timeoutMs: 5 })).toBeNull();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("settles a failed spawn without failing the prompt", async () => {
    expect(await runRefocus({}, { spawn: () => { throw new Error("missing executable"); } })).toBeNull();
  });
});
