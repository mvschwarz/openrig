import { describe, expect, it, vi } from "vitest";
import { compileOmpPluginHooks } from "../src/domain/omp-plugin-hooks.js";
// @ts-expect-error OMP loads the shipped plain JavaScript extension.
import bridge from "../assets/omp/openrig-plugin-hooks.js";
// @ts-expect-error OMP loads the shipped plain JavaScript handlers.
import { runHttpHook } from "../assets/omp/openrig-hook-handlers.js";

function compile(files: Record<string, string>, type: "claude" | "codex" | "auto" = "auto") {
  return compileOmpPluginHooks({ exists: p => p in files, readFile: p => {
    if (!(p in files)) throw new Error(`missing ${p}`);
    return files[p]!;
  }, writeFile() {}, mkdirp() {} }, "/plugin", "fixture", type);
}
const registry = (event: string, command = "true") => ({ hooks: { [event]: [{ hooks: [{ type: "command", command }] }] } });

describe("OMP plugin hook selection", () => {
  it("loads an external hook registry once and prefers Claude over a dual manifest", () => {
    const result = compile({
      "/plugin/.claude-plugin/plugin.json": JSON.stringify({ hooks: "./hooks/hooks.json" }),
      "/plugin/.codex-plugin/plugin.json": JSON.stringify({ hooks: registry("Stop", "wrong") }),
      "/plugin/hooks/hooks.json": JSON.stringify(registry("PreToolUse", "right")),
    });
    expect(result).toMatchObject({ format: "claude", hooks: [{ event: "PreToolUse", command: "right" }] });
    expect(result.hooks).toHaveLength(1);
  });
  it("compiles HTTP, model and background handlers with their execution options", () => {
    const handlers = [
      { type: "http", url: "https://hooks.invalid/check", headers: { Authorization: "$TOKEN" }, allowedEnvVars: ["TOKEN"] },
      { type: "prompt", prompt: "Check $ARGUMENTS", model: "provider/model" },
      { type: "agent", prompt: "Inspect" },
      { type: "command", command: "true", args: [], async: true, once: true, onFailure: "block" },
    ];
    const result = compile({ "/plugin/.claude-plugin/plugin.json": JSON.stringify({ hooks: { hooks: { Stop: [{ hooks: handlers }] } } }) });
    expect(result.hooks.map(h => h.type)).toEqual(["http", "prompt", "agent", "command"]);
    expect(result.hooks.map(h => h.timeout)).toEqual([600, 30, 60, 600]);
    expect(result.hooks[3]).toMatchObject({ async: true, args: [], onFailure: "block" });
  });
  it("honors explicit Codex selection and inline registries", () => {
    expect(compile({
      "/plugin/.claude-plugin/plugin.json": JSON.stringify({ hooks: registry("Stop", "wrong") }),
      "/plugin/.codex-plugin/plugin.json": JSON.stringify({ hooks: registry("Stop", "right") }),
    }, "codex").hooks[0]?.command).toBe("right");
  });
  it.each([
    { hooks: "../outside.json" },
    { hooks: { hooks: { PreToolUse: [{ matcher: "[", hooks: [{ type: "command", command: "true" }] }] } } },
  ])("refuses incompatible hooks instead of projecting a silently incomplete plugin (%j)", manifest => {
    expect(() => compile({ "/plugin/.claude-plugin/plugin.json": JSON.stringify(manifest) })).toThrow();
  });
});

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<any> | any;
function fixture(hooks: Array<Record<string, unknown>>, format = "claude", stock = false) {
  const handlers: Record<string, Handler> = {};
  const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  const pi = { setHandlerTimeout: stock ? undefined : vi.fn(), sendMessage: vi.fn(), on: (name: string, handler: Handler) => { handlers[name] = handler; }, appendEntry: vi.fn() };
  const ctx = { cwd: "/work", sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/session.jsonl" },
    ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(false) }, hasUI: true, abort: vi.fn() };
  bridge(pi, { plans: [{ id: "fixture", root: "/plugin", format, hooks: hooks.map(h => ({ command: "true", timeout: 10, ...h })) }], run, env: {} });
  return { handlers, run, ctx, pi };
}
const tool = { toolName: "bash", toolCallId: "call-1", input: { command: "echo old" } };

describe("OMP native hook bridge", () => {
  it("matches Claude tool names, denies exit 2, and supplies the real conversation identity", async () => {
    const f = fixture([{ event: "PreToolUse", matcher: "^Bash$" }]);
    f.run.mockResolvedValue({ code: 2, stdout: "", stderr: "blocked by policy" });
    expect(await f.handlers.tool_call!(tool, f.ctx)).toEqual({ block: true, reason: "blocked by policy" });
    expect(f.run.mock.calls[0]![1]).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: tool.input, session_id: "session-1", transcript_path: "/session.jsonl", cwd: "/work" });
    await f.handlers.tool_call!({ ...tool, toolName: "read" }, f.ctx);
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("applies Codex command revisions and carries trusted pre-tool context", async () => {
    const f = fixture([{ event: "PreToolUse", matcher: "Bash" }], "codex");
    f.run.mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "echo new" }, additionalContext: "pre context" } }) });
    expect(await f.handlers.tool_call!(tool, f.ctx)).toEqual({ input: { command: "echo new" }, additionalContext: "pre context" });
  });
  it("blocks prompt submission without injecting its context into a later prompt", async () => {
    const f = fixture([{ event: "UserPromptSubmit" }]);
    f.run.mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ decision: "block", reason: "no", hookSpecificOutput: { additionalContext: "do not leak" } }) });
    expect(await f.handlers.input!({ text: "blocked prompt" }, f.ctx)).toEqual({ handled: true });
    expect(await f.handlers.before_agent_start!({ reason: "prompt" }, f.ctx)).toBeUndefined();
  });
  it("delivers session/prompt context exactly once and clears it across session changes", async () => {
    const f = fixture([{ event: "SessionStart", matcher: "startup" }, { event: "UserPromptSubmit" }]);
    f.run.mockResolvedValue({ code: 0, stderr: "", stdout: "context" });
    await f.handlers.session_start!({}, f.ctx);
    await f.handlers.input!({ text: "hello" }, f.ctx);
    expect(await f.handlers.before_agent_start!({ reason: "revive" }, f.ctx)).toBeUndefined();
    expect(await f.handlers.before_agent_start!({ reason: "prompt" }, f.ctx)).toMatchObject({ message: { content: "context\n\ncontext" } });
    expect(await f.handlers.before_agent_start!({ reason: "prompt" }, f.ctx)).toBeUndefined();
    await f.handlers.input!({ text: "old session" }, f.ctx);
    await f.handlers.session_switch!({ reason: "resume" }, f.ctx);
    expect(await f.handlers.before_agent_start!({ reason: "prompt" }, f.ctx)).toBeUndefined();
  });
  it("separates successful and failed tool hooks and preserves their additional context", async () => {
    const f = fixture([{ event: "PostToolUse" }, { event: "PostToolUseFailure" }]);
    f.run.mockImplementation(async (_hook, input) => ({ code: 0, stderr: "", stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: input.hook_event_name } }) }));
    expect(await f.handlers.tool_result!({ ...tool, isError: false, content: [{ type: "text", text: "ok" }] }, f.ctx)).toEqual({ additionalContext: "PostToolUse" });
    expect(await f.handlers.tool_result!({ ...tool, isError: true, content: [{ type: "text", text: "failed" }] }, f.ctx)).toEqual({ additionalContext: "PostToolUseFailure" });
  });
  it("honors stop continuation and reports the continuation guard to the hook", async () => {
    const f = fixture([{ event: "Stop" }]);
    f.run.mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ decision: "block", reason: "finish verification" }) });
    expect(await f.handlers.session_stop!({ stop_hook_active: true, last_assistant_message: { content: [{ type: "text", text: "done" }] } }, f.ctx)).toEqual({ decision: "block", reason: "finish verification" });
    expect(f.run.mock.calls[0]![1]).toMatchObject({ stop_hook_active: true, last_assistant_message: "done" });
  });
  it("routes child stop separately and includes its identity", async () => {
    const f = fixture([{ event: "SubagentStop", matcher: "explore" }, { event: "Stop" }]);
    f.run.mockResolvedValue({ code: 2, stdout: "", stderr: "inspect one more file" });
    expect(await f.handlers.subagent_stop!({ stop_hook_active: true }, { ...f.ctx, agent: { kind: "sub", id: "child-1", name: "explore" } })).toEqual({ decision: "block", reason: "inspect one more file" });
    expect(f.run.mock.calls[0]![1]).toMatchObject({ hook_event_name: "SubagentStop", agent_id: "child-1", agent_type: "explore", stop_hook_active: true });
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("preserves normalized inputs and responses in Codex PostToolBatch", async () => {
    const f = fixture([{ event: "PostToolBatch" }], "codex");
    await f.handlers.tool_call!(tool, f.ctx);
    await f.handlers.tool_result!({ ...tool, content: [{ type: "text", text: "done" }] }, f.ctx);
    await f.handlers.turn_end!({ toolResults: [{ toolCallId: tool.toolCallId }] }, f.ctx);
    expect(f.run.mock.calls[0]![1].tool_calls).toEqual([{ tool_name: "Bash", tool_input: tool.input, tool_use_id: tool.toolCallId, tool_response: [{ type: "text", text: "done" }] }]);
  });
  it("runs background hooks without blocking and discards stale context on session switch", async () => {
    const f = fixture([{ event: "PreToolUse", async: true }]);
    const deferred = Promise.withResolvers();
    f.run.mockReturnValueOnce(deferred.promise);
    await f.handlers.tool_call!(tool, f.ctx);
    const signal = f.run.mock.calls[0]![2].signal as AbortSignal;
    await f.handlers.session_switch!({ reason: "resume" }, f.ctx);
    expect(signal.aborted).toBe(true);
    deferred.resolve({ code: 0, stdout: JSON.stringify({ additionalContext: "stale" }), stderr: "" });
    await Promise.resolve();
    expect(await f.handlers.context!({ messages: [] }, f.ctx)).toBeUndefined();
  });
  it("delivers background context and only rewakes for asyncRewake exit 2", async () => {
    const f = fixture([{ event: "PreToolUse", asyncRewake: true }]);
    f.run.mockResolvedValue({ code: 2, stdout: JSON.stringify({ decision: "block", additionalContext: "background context" }), stderr: "needs attention" });
    expect(await f.handlers.tool_call!(tool, f.ctx)).toEqual({});
    await Promise.resolve();
    expect(f.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "needs attention" }), { deliverAs: "nextTurn", triggerTurn: true });
    expect(await f.handlers.context!({ messages: [] }, f.ctx)).toMatchObject({ messages: [{ content: "background context" }] });
  });
  it("honors explicit block-on-failure without converting ordinary failures to denials", async () => {
    const f = fixture([{ event: "PreToolUse", onFailure: "block" }]);
    f.run.mockResolvedValue({ code: null, stdout: "", stderr: "", error: "HTTP unavailable" });
    expect(await f.handlers.tool_call!(tool, f.ctx)).toEqual({ block: true, reason: "HTTP unavailable" });
  });
  it("runs pre/post compaction hooks and compact-matched session hooks in order", async () => {
    const f = fixture([{ event: "PreCompact", matcher: "auto" }, { event: "PostCompact" }, { event: "SessionStart", matcher: "compact" }]);
    await f.handlers.auto_compaction_start!({}, f.ctx);
    await f.handlers.session_before_compact!({ customInstructions: "preserve work" }, f.ctx);
    await f.handlers.session_compact!({ compactionEntry: { summary: "summary" } }, f.ctx);
    expect(f.run.mock.calls.map(call => call[1].hook_event_name)).toEqual(["PreCompact", "PostCompact", "SessionStart"]);
    expect(f.run.mock.calls[0]![1]).toMatchObject({ trigger: "auto", custom_instructions: "preserve work" });
  });
  it("delivers batch context on the next model request without waiting for another user prompt", async () => {
    const f = fixture([{ event: "PostToolBatch" }]);
    f.run.mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ additionalContext: "batch context" }) });
    await f.handlers.turn_end!({ toolResults: [{ toolCallId: "call-1" }] }, f.ctx);
    expect(await f.handlers.context!({ messages: [] }, f.ctx)).toMatchObject({ messages: [{ content: "batch context" }] });
    expect(await f.handlers.context!({ messages: [] }, f.ctx)).toBeUndefined();
  });
  it.each(["allow", "deny"])("returns PermissionRequest %s decisions to OMP's approval gate", async behavior => {
    const f = fixture([{ event: "PermissionRequest" }]);
    f.run.mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ hookSpecificOutput: { decision: { behavior, message: "policy" } } }) });
    expect(await f.handlers.tool_approval_requested!({ ...tool, canResolve: true }, f.ctx)).toEqual({ decision: behavior, reason: behavior === "deny" ? "policy" : "" });
  });
  it("carries PreToolUse allow into an ordinary gate without overriding a protected gate", async () => {
    const f = fixture([{ event: "PreToolUse" }, { event: "PermissionRequest" }]);
    f.run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }) });
    await f.handlers.tool_call!(tool, f.ctx);
    expect(await f.handlers.tool_approval_requested!({ ...tool, canResolve: true }, f.ctx)).toMatchObject({ decision: "allow" });
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(await f.handlers.tool_approval_requested!({ ...tool, canResolve: false }, f.ctx)).toBeUndefined();
    expect(f.run).toHaveBeenCalledTimes(2);
    await f.handlers.tool_result!({ ...tool, isError: false }, f.ctx);
    expect(await f.handlers.tool_approval_requested!({ ...tool, canResolve: true }, f.ctx)).toBeUndefined();
  });
  it("refuses a persistent permission update instead of pretending it was applied", async () => {
    const f = fixture([{ event: "PermissionRequest" }]);
    f.run.mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ hookSpecificOutput: { decision: { behavior: "allow", updatedPermissions: [{ type: "addRules" }] } } }) });
    expect(await f.handlers.tool_approval_requested!({ ...tool, canResolve: true }, f.ctx)).toMatchObject({ decision: "deny", reason: expect.stringContaining("persistent grant") });
    expect(f.pi.appendEntry).toHaveBeenCalledOnce();
  });
  it("reports an incompatible approval API and aborts instead of claiming the decision took effect", async () => {
    const f = fixture([{ event: "PermissionRequest" }]);
    f.run.mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ hookSpecificOutput: { decision: { behavior: "deny" } } }) });
    await f.handlers.tool_approval_requested!(tool, f.ctx);
    expect(f.ctx.abort).toHaveBeenCalledOnce();
    expect(f.pi.appendEntry).toHaveBeenCalledOnce();
  });
  it("reports failed commands and malformed output without silently claiming a decision", async () => {
    const f = fixture([{ event: "PreToolUse" }]);
    f.run.mockResolvedValueOnce({ code: null, error: "timed out", stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "{bad", stderr: "" });
    await f.handlers.tool_call!(tool, f.ctx); await f.handlers.tool_call!(tool, f.ctx);
    expect(f.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(2);
  });
});


describe("HTTP hook execution", () => {
  it("posts the original payload and interpolates only allowed environment variables", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ decision: "block", reason: "policy" })));
    const result = await runHttpHook({ url: "https://hooks.invalid/check", timeout: 1,
      headers: { Authorization: "Bearer ${TOKEN}", Hidden: "$SECRET" }, allowedEnvVars: ["TOKEN"] },
      { hook_event_name: "PreToolUse", tool_input: { command: "echo test" } },
      { fetch, env: { TOKEN: "allowed", SECRET: "not-allowed" } });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer allowed", Hidden: "" }, body: JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { command: "echo test" } }) });
    expect(JSON.parse(result.stdout)).toEqual({ decision: "block", reason: "policy" });
  });
  it("reports HTTP failures and oversized output", async () => {
    expect((await runHttpHook({ url: "https://hooks.invalid/check", timeout: 1 }, {}, {
      fetch: vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    })).error).toBe("HTTP 503");
    expect((await runHttpHook({ url: "https://hooks.invalid/check", timeout: 1 }, {}, {
      fetch: vi.fn().mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1))),
    })).error).toContain("1 MiB");
  });
});


describe("stock OMP compatibility", () => {
  it("keeps supported hooks alongside unsupported events and conditional handlers", () => {
    const plan = compile({ "/plugin/.claude-plugin/plugin.json": JSON.stringify({ hooks: { hooks: {
      UnknownEvent: [{ hooks: [{ type: "command", command: "unsupported" }] }],
      Stop: [{ hooks: [{ type: "command", command: "conditional", if: "test" },
        { type: "mcp_tool" }, { type: "command", command: "supported" }] }],
    } } }) });
    expect(plan.hooks.map(h => h.command)).toEqual(["supported"]);
    expect(plan.warnings).toHaveLength(3);
  });
  it("warns at startup, skips unavailable gates, and retains native approval after PreToolUse allow", async () => {
    const f = fixture([{ event: "SubagentStop" }, { event: "PermissionRequest" }, { event: "PreToolUse" }], "claude", true);
    await f.handlers.session_start!({}, f.ctx);
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("SubagentStop"), "warning");
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PermissionRequest"), "warning");
    expect(f.handlers.subagent_stop).toBeUndefined();
    f.run.mockResolvedValue({ code: 0, stderr: "", stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }) });
    await f.handlers.tool_call!(tool, f.ctx);
    expect(await f.handlers.tool_approval_requested!(tool, f.ctx)).toBeUndefined();
    expect(f.ctx.abort).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
  });
});
