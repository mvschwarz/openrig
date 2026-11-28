import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
// @ts-expect-error OMP loads the shipped plain JavaScript extension.
import openrigCore, { runRefocus } from "../assets/plugins/openrig-core/omp/index.js";
const contextMessage = { customType: "openrig-refocus", content: "context", display: true, details: { openrigRefocusId: "revision" } };
function fixture(seat = true, kind = "main", budget?: string) {
  const handlers: Record<string, Function> = {}, commands: Record<string, any> = {};
  const refocus = vi.fn().mockResolvedValue({ revision: "revision", message: contextMessage });
  const pi = { on: (n: string, f: Function) => { handlers[n] = f; }, registerCommand: (n: string, c: unknown) => { commands[n] = c; }, sendMessage: vi.fn() };
  openrigCore(pi, { env: { ...(seat ? { OPENRIG_SESSION_NAME: "seat" } : {}), OPENRIG_REFOCUS_BUDGET_MS: budget }, runRefocus: refocus });
  const sessionManager = { getSessionId: vi.fn(() => "occupant"), getBranch: vi.fn((): Record<string, unknown>[] => []) };
  return { handlers, commands, refocus, pi, ctx: { agent: { kind }, sessionManager, ui: { notify: vi.fn() } } };
}
describe("OMP core refocus", () => {
  it.each([[false, "main"], [true, "subagent"]] as const)("ignores non-seat or child conversation (%s, %s)", async (seat, kind) => {
    const f = fixture(seat, kind, "52000");
    await f.handlers.session_start({}, f.ctx);
    expect(f.ctx.ui.notify).not.toHaveBeenCalled();
    await f.handlers.session_compact({}, f.ctx);
    expect(await f.handlers.before_agent_start({ prompt: "continue" }, f.ctx)).toBeUndefined();
    await f.handlers.message_end({ message: { ...contextMessage, role: "custom" } }, f.ctx);
    await f.commands.refocus.handler("", f.ctx);
    expect(f.refocus).not.toHaveBeenCalled();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
  });
  it("prepares again after cancellation and acknowledges only the accepted custom message", async () => {
    const f = fixture();
    await f.handlers.session_compact({}, f.ctx);
    expect(f.refocus.mock.calls[0][0]).toMatchObject({ hook_event_name: "PostCompact" });
    expect(await f.handlers.before_agent_start({ reason: "revive" }, f.ctx)).toBeUndefined();
    expect(f.refocus).toHaveBeenCalledTimes(1);
    for (const prompt of ["aborted", "continue"]) {
      expect(await f.handlers.before_agent_start({ prompt }, f.ctx)).toEqual({ message: contextMessage });
      expect(f.refocus.mock.lastCall?.[0]).toMatchObject({ hook_event_name: "UserPromptSubmit", prompt, omp_prepare: true });
    }
    await f.handlers.message_end({ message: { ...contextMessage, role: "user" } }, f.ctx);
    await f.handlers.message_end({ message: { ...contextMessage, role: "custom", customType: "other" } }, f.ctx);
    await f.handlers.message_end({ message: { ...contextMessage, role: "custom", details: undefined } }, f.ctx);
    expect(f.refocus).toHaveBeenCalledTimes(3);
    await f.handlers.message_end({ message: { ...contextMessage, role: "custom" } }, f.ctx);
    expect(f.refocus.mock.lastCall?.[0]).toMatchObject({ hook_event_name: "OmpRefocusAccepted", session_id: "occupant", omp_delivery_id: "revision" });
    f.refocus.mockResolvedValue(null);
    expect(await f.handlers.before_agent_start({ prompt: "continue" }, f.ctx)).toBeUndefined();
  });
  it("recovers a missed acknowledgement from the current branch even when today's lookup fails", async () => {
    const f = fixture();
    f.refocus.mockResolvedValue({ revision: "revision", message: { ...contextMessage, content: "trace gap", details: undefined } });
    f.ctx.sessionManager.getBranch.mockReturnValue([{ type: "custom_message", ...contextMessage }]);
    expect(await f.handlers.before_agent_start({ prompt: "resume" }, f.ctx)).toBeUndefined();
    expect(f.refocus.mock.lastCall?.[0]).toMatchObject({ hook_event_name: "OmpRefocusAccepted", omp_delivery_id: "revision" });
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
  });
  it("drops the prepared message if the command's session changed during lookup", async () => {
    const f = fixture();
    f.ctx.sessionManager.getSessionId.mockReturnValueOnce("occupant").mockReturnValue("replacement");
    await f.commands.refocus.handler("", f.ctx);
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.refocus).toHaveBeenCalledTimes(1);
  });
  it.each([["52000", true], ["23001", true], ["23000", false], [undefined, false]] as const)(
    "reports the effective native budget at session start when %s exceeds the limit", async (budget, capped) => {
      const f = fixture(true, "main", budget);
      await f.handlers.session_start({}, f.ctx);
      if (capped) expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`requested ${budget} ms. Native OMP uses 23000 ms`), "warning");
      else expect(f.ctx.ui.notify).not.toHaveBeenCalled();
    });

  it("/refocus starts a turn only when the hook returns context", async () => {
    const f = fixture();
    await f.commands.refocus.handler("", f.ctx);
    expect(f.refocus.mock.calls[0][1]).toMatchObject({ now: true });
    expect(f.pi.sendMessage).toHaveBeenCalledWith(contextMessage, { triggerTurn: true });
    f.refocus.mockResolvedValue(null);
    await f.commands.refocus.handler("", f.ctx);
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.ctx.ui.notify).toHaveBeenCalled();
  });
  it.each([0, 1])("accepts output only after successful exit (%s)", async code => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn() });
    const result = runRefocus({}, { spawn: () => child });
    child.stdout.emit("data", JSON.stringify({ hookSpecificOutput: { additionalContext: "context" }, ompRevision: "revision", ompComplete: true }));
    child.emit("close", code);
    expect(await result).toEqual(code === 0 ? { revision: "revision", message: contextMessage } : null);
  });
  it("keeps split UTF-8 and limits the helper budget inside the handler deadline", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { on: vi.fn(), end: vi.fn() } });
    const spawn = vi.fn(() => child);
    const result = runRefocus({}, { spawn, env: { OPENRIG_REFOCUS_BUDGET_MS: "30000" } });
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ env: { OPENRIG_REFOCUS_BUDGET_MS: "23000" } }));
    const output = Buffer.from(JSON.stringify({ hookSpecificOutput: { additionalContext: "å🌍" } }));
    const split = output.indexOf(Buffer.from("🌍")) + 2;
    child.stdout.emit("data", output.subarray(0, split)); child.stdout.emit("data", output.subarray(split));
    child.emit("close", 0);
    expect(await result).toEqual({ revision: null, message: { customType: "openrig-refocus", content: "å🌍", display: true } });
  });
  it("waits for the helper's full 1.5-second issue report after a lookup at the cap", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn() });
      const spawn = vi.fn((_command, _args, _options) => child);
      const result = runRefocus({}, { spawn, env: { OPENRIG_REFOCUS_BUDGET_MS: "52000" } });
      const lookup = Number(spawn.mock.calls[0][2].env.OPENRIG_REFOCUS_BUDGET_MS);
      vi.advanceTimersByTime(lookup);
      child.stdout.emit("data", JSON.stringify({ hookSpecificOutput: { additionalContext: "trace gap" }, ompRevision: "revision", ompComplete: false }));
      vi.advanceTimersByTime(1_500 + 400);
      child.emit("close", 0);
      expect(child.kill).not.toHaveBeenCalled();
      expect(await result).toEqual({ revision: "revision", message: { customType: "openrig-refocus", content: "trace gap", display: true } });
    } finally {
      vi.useRealTimers();
    }
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
