// The openrig-core plugin's permission-answer hook (Claude Code PermissionRequest, slice 15), with its daemon calls faked:
// it waits only when OpenRig asked someone, returns only an allow or a deny with words, and returns nothing (Claude Code's
// own prompt carries on) for everything else. The real routes and process are driven in native-permission-answer.test.ts.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { deriveRelayEvents } from "../src/domain/claude-activity-hooks.js";

const require = createRequire(import.meta.url);
type Call = { method: string; route: string; body: Record<string, unknown> | null };
type Answer = { status: number; data: Record<string, unknown> } | null;
const hook = require("../assets/plugins/openrig-core/hooks/scripts/permission-answer.cjs") as {
  answerPermission: (opts: Record<string, unknown>) => Promise<{ output: Record<string, unknown> | null; outcome: string }>;
  WINDOW_SECONDS: number;
};
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  claudeToolCallFingerprint: (sessionId: string, agentId: string | null, tool: string, input: unknown) => string | null;
  buildOpenRigPayload: (payload: Record<string, unknown>, env: Record<string, string>) => Record<string, unknown> | null;
};
const MANIFEST = new URL("../assets/plugins/openrig-core/hooks/claude.json", import.meta.url);

const ENV = { OPENRIG_SESSION_NAME: "dev-impl@perm-rig", OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "gen-1" };
const INPUT = { hook_event_name: "PermissionRequest", session_id: "claude-session-1", tool_name: "Bash",
  tool_input: { command: "git push origin docs", description: "Push the docs branch" }, permission_mode: "default" };

/** A fake daemon: the submit's answer, then each read's in turn (the last repeats), and the withdraw's. */
function daemon(submit: Answer, reads: Answer[] = [], withdrawn: Answer = { status: 200, data: { ok: true, state: "withdrawn" } }) {
  const calls: Call[] = [];
  let clock = 0;
  const call = async (method: string, route: string, body: Record<string, unknown> | null) => {
    calls.push({ method, route, body });
    if (route === "/api/activity/permission-requests") return submit;
    if (route.endsWith("/withdraw")) return withdrawn;
    if (route.endsWith("/taken")) return { status: 200, data: { ok: true } };
    clock += 25_000; // each long-poll read waits out its time
    return reads.length > 1 ? reads.shift()! : reads[0] ?? { status: 200, data: { ok: true, state: "pending" } };
  };
  return { calls, opts: { env: ENV, call, now: () => clock, wait: async (ms: number) => { clock += ms; }, windowMs: 60_000 } };
}
const asked = { status: 200, data: { ok: true, askId: "qitem-runner-permission-abc", created: true, askedOf: "mike@external" } };

describe("the permission-answer hook", () => {
  it("submits the exact native request with Allow once and Deny, its window and the call's fingerprint", async () => {
    const d = daemon({ status: 200, data: { ok: true, state: "not_asked", reason: "No one can be asked." } });
    await hook.answerPermission({ ...d.opts, input: INPUT });
    expect(d.calls).toHaveLength(1);
    const body = d.calls[0]!.body!;
    expect(body).toMatchObject({ sessionName: "dev-impl@perm-rig", nodeId: "node-1", generation: "gen-1", nativeHook: "claude-code",
      nativeRef: "claude-session-1", holdSeconds: 60,
      action: { tool: "Bash", input: INPUT.tool_input, agent: null,
        callFingerprint: relay.claudeToolCallFingerprint("claude-session-1", null, "Bash", INPUT.tool_input) },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    expect(body.turnId).toBe(body.requestId);
  });

  it("waits only when someone was asked: not asked means no decision at once", async () => {
    const d = daemon({ status: 200, data: { ok: true, state: "not_asked", reason: "No one can be asked." } });
    expect(await hook.answerPermission({ ...d.opts, input: INPUT })).toMatchObject({ output: null, outcome: "not asked: No one can be asked." });
  });

  it("returns the person's Allow once, after telling the daemon it took it", async () => {
    const d = daemon(asked, [{ status: 200, data: { ok: true, state: "pending" } }, { status: 200, data: { ok: true, state: "answered", optionId: "allow" } }]);
    const result = await hook.answerPermission({ ...d.opts, input: INPUT });
    expect(result.output).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(d.calls.at(-1)).toEqual({ method: "POST", route: "/api/activity/permission-requests/qitem-runner-permission-abc/taken", body: { optionId: "allow" } });
  });

  it("returns a Deny whose message carries the words the daemon gives it", async () => {
    const d = daemon(asked, [{ status: 200, data: { ok: true, state: "answered", optionId: "deny",
      native: { message: "Denied by mike@external in OpenRig: their own answer. They wrote: \"use the test script\"" } } }]);
    expect((await hook.answerPermission({ ...d.opts, input: INPUT })).output).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "Denied by mike@external in OpenRig: their own answer. They wrote: \"use the test script\"" } } });
  });

  it("withdraws at the end of its window and returns nothing, unless the answer landed at the very end", async () => {
    const quiet = daemon(asked);
    expect((await hook.answerPermission({ ...quiet.opts, input: INPUT })).output).toBeNull();
    expect(quiet.calls.filter((c) => c.route.endsWith("/withdraw"))).toEqual([{ method: "POST",
      route: "/api/activity/permission-requests/qitem-runner-permission-abc/withdraw", body: { reason: "answer_window_ended" } }]);
    const last = daemon(asked, [], { status: 200, data: { ok: true, state: "answered", optionId: "allow" } });
    expect((await hook.answerPermission({ ...last.opts, input: INPUT })).output).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
  });

  it.each([
    ["withdrawn", { status: 200, data: { ok: true, state: "withdrawn" } }],
    ["stale", { status: 200, data: { ok: true, state: "stale" } }],
    ["unanswered", { status: 200, data: { ok: true, state: "unanswered" } }],
    ["permitted by an older daemon's default", { status: 200, data: { ok: true, state: "permitted", optionId: "allow" } }],
    ["refused by the daemon", { status: 409, data: { ok: false, code: "activity_grant_stale" } }],
  ])("returns no decision when the ask reads %s", async (_case, read) => {
    const d = daemon(asked, [read as Answer]);
    expect((await hook.answerPermission({ ...d.opts, input: INPUT })).output).toBeNull();
  });

  it.each([
    ["the daemon doesn't answer", null],
    ["the daemon refuses the submit", { status: 409, data: { ok: false, code: "stale_generation" } }],
    ["the daemon permits by default (a runner's rule)", { status: 200, data: { ok: true, state: "permitted", optionId: "allow" } }],
  ])("returns no decision when %s", async (_case, submit) => {
    const d = daemon(submit as Answer);
    expect(await hook.answerPermission({ ...d.opts, input: INPUT })).toMatchObject({ output: null });
    expect(d.calls).toHaveLength(1);
  });

  // claude10 (21:55Z, 22:22Z): the person answered a prompt still open on the seat's screen after the hook's five-minute
  // window, and it was refused as too late. The dialog stays answerable while the hook waits, so the hook waits a day.
  it("takes an answer that comes well after five minutes, with its own window", async () => {
    const pending = { status: 200, data: { ok: true, state: "pending" } };
    const d = daemon(asked, [...Array.from({ length: 16 }, () => pending), { status: 200, data: { ok: true, state: "answered", optionId: "allow" } }]);
    const { windowMs: _fakeWindow, ...ownWindow } = d.opts;
    const result = await hook.answerPermission({ ...ownWindow, input: INPUT });
    expect(result.output).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(d.calls[0]!.body).toMatchObject({ holdSeconds: hook.WINDOW_SECONDS });
    expect(d.calls.filter((c) => c.route.endsWith("/withdraw"))).toEqual([]);
  });

  it("keeps reading through a daemon restart within its window", async () => {
    const d = daemon(asked, [null, { status: 503, data: {} }, { status: 200, data: { ok: true, state: "answered", optionId: "allow" } }]);
    expect((await hook.answerPermission({ ...d.opts, input: INPUT })).output).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
  });

  it.each([
    ["outside an OpenRig seat", { ...INPUT }, {}],
    ["for a question tool whose prompt needs the person's own input", { ...INPUT, tool_name: "AskUserQuestion" }, ENV],
    ["for another hook event", { ...INPUT, hook_event_name: "PreToolUse" }, ENV],
  ])("does nothing %s", async (_case, input, env) => {
    const d = daemon(asked);
    expect(await hook.answerPermission({ ...d.opts, env, input })).toMatchObject({ output: null });
    expect(d.calls).toHaveLength(0);
  });

  it("sends a very large input cut, and says so", async () => {
    const d = daemon({ status: 200, data: { ok: true, state: "not_asked", reason: "x" } });
    await hook.answerPermission({ ...d.opts, input: { ...INPUT, tool_name: "Write", tool_input: { file_path: "/tmp/a", content: "x".repeat(70_000) } } });
    const action = d.calls[0]!.body!.action as Record<string, unknown>;
    expect(action).toMatchObject({ tool: "Write", inputCut: true });
    expect(String(action.inputText)).toHaveLength(65536);
    expect(action).not.toHaveProperty("input");
  });
});

describe("its place in the plugin", () => {
  it("is its own synchronous PermissionRequest hook, with a timeout above its window and nothing that blocks on failure", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const groups = manifest.hooks.PermissionRequest as Array<{ hooks: Array<Record<string, unknown>> }>;
    const answer = groups.flatMap((group) => group.hooks).find((h) => String(h.command).includes("permission-answer.cjs"))!;
    expect(answer).toMatchObject({ type: "command" });
    expect(answer).not.toHaveProperty("async");
    expect(answer).not.toHaveProperty("asyncRewake");
    expect(answer).not.toHaveProperty("onFailure");
    expect(Number(answer.timeout)).toBeGreaterThanOrEqual(hook.WINDOW_SECONDS + 30);
    // Claude Code 2.1.330 caps a hook's timeout at 2^31-1 ms, so the window has to fit under that.
    expect(Number(answer.timeout) * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it("leaves the managed settings copy's relay events as they were (the relay's 5 s PermissionRequest observer)", () => {
    const fs = { exists: () => true, readFile: (p: string) => readFileSync(p, "utf8") };
    expect(deriveRelayEvents(fs, MANIFEST.pathname).find((e) => e.event === "PermissionRequest")).toEqual({ event: "PermissionRequest", timeout: 5 });
  });

  it("matches the relay's PostToolBatch fingerprints, which carry no tool input", () => {
    const payload = relay.buildOpenRigPayload({ hook_event_name: "PostToolBatch", session_id: "claude-session-1",
      tool_calls: [{ tool_name: "Bash", tool_input: { description: "Push the docs branch", command: "git push origin docs" }, tool_use_id: "toolu_1", tool_response: "ok" }] },
      ENV)!;
    expect(payload.toolCallFingerprints).toEqual([relay.claudeToolCallFingerprint("claude-session-1", null, "Bash", INPUT.tool_input)]);
    expect(JSON.stringify(payload)).not.toContain("git push");
    expect(relay.buildOpenRigPayload({ hook_event_name: "Stop", session_id: "claude-session-1" }, ENV)).not.toHaveProperty("toolCallFingerprints");
  });
});
