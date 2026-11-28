import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AUTO_PREP_WAIT_MS_DEFAULT, ClaudeCompactionEnforcer, COMPACTION_RECORD_FILE, type PreparationFailure } from "../src/domain/claude-compaction-enforcer.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import { TerminalPolicyRefusal } from "../src/domain/terminal-policy.js";
import { Hono } from "hono";
import { compactionRoutes } from "../src/routes/compaction.js";
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const input = { sessionName: "writer@test", runtime: "claude-code", usedPercentage: 90 };
function fixture(extra: Record<string, unknown> = {}) {
  let clock = 10000, generation = "g1", restarts = 0;
  const home = mkdtempSync(join(tmpdir(), "prep-notice-")); homes.push(home);
  const send = vi.fn(async (): Promise<any> => { clock++; return { ok: false, sent: false, inputPhase: "not_reached", reason: "draft_input_busy" }; });
  const notice = vi.fn(async (_failure: PreparationFailure) => {});
  const policy = { enabled: true, thresholdPercent: 80, preCompactInstruction: "Write a map.", compactInstruction: "" };
  const opts = { openrigHome: home, now: () => clock, resolveOccupantGeneration: () => generation,
    autoRetryAfterStopMs: 1, onPreparationFailure: notice, ...extra };
  const transport = { send, waitUntilIdle: vi.fn(async () => ({ ok: true })) } as unknown as SessionTransport;
  let e = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => policy } as any, transport, opts);
  return { get e() { return e; }, send, notice, transport, advance: (n = 2) => { clock += n; },
    generation: (s: string) => { generation = s; },
    restart: () => { e = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => policy } as any, transport, { ...opts, daemonInstance: `restarted-${++restarts}` }); } };
}
async function end(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 4; i++) {
    await f.e.maybeAutoCompact(input);
    if (f.e.getPreparationState(input.sessionName)?.status === "stopped") {
      const id = f.e.getPreparationState(input.sessionName)!.attemptId; f.advance(); return id;
    }
  }
  throw new Error("attempt did not end");
}

it("counts three ended automatic attempts across ids/restart, not their nine send calls", async () => {
  const f = fixture(); const ids = [await end(f)];
  expect(f.send).toHaveBeenCalledTimes(3); expect(f.notice).not.toHaveBeenCalled();
  ids.push(await end(f)); expect(f.notice).not.toHaveBeenCalled();
  f.restart(); ids.push(await end(f)); expect(new Set(ids).size).toBe(3);
  await f.e.maybeAutoCompact(input);
  expect(f.notice).toHaveBeenCalledTimes(1);
  expect(f.notice).toHaveBeenCalledWith(expect.objectContaining({ occupantGeneration: "g1", attemptId: ids[2], endedAttempts: 3, reason: "draft_input_busy" }));
  const evidence = JSON.parse(readFileSync(f.notice.mock.calls[0]![0].statePath, "utf8"));
  expect(evidence).toMatchObject({ phase: "ended", delivery: "not_sent", attemptId: ids[2], preparationFailures: { endedAttempts: 3 } });
  await f.e.maybeAutoCompact(input); expect(f.notice).toHaveBeenCalledTimes(1);
});

it.each(["below", "cancel", "generation", "uncertain", "progress"])("%s interrupts the failure run", async kind => {
  const f = fixture(); await end(f); await end(f);
  if (kind === "below") await f.e.maybeAutoCompact({ ...input, usedPercentage: 20 });
  if (kind === "cancel") { f.e.cancelPreparation(input.sessionName); await f.e.maybeAutoCompact(input); expect(f.notice).not.toHaveBeenCalled(); return; }
  if (kind === "generation") f.generation("g2");
  if (kind === "uncertain" || kind === "progress") {
    f.send.mockResolvedValue(kind === "uncertain" ? { ok: false, sent: true, inputPhase: "attempted", reason: "send_failed" } : { ok: true });
    await f.e.maybeAutoCompact(input); await f.e.maybeAutoCompact(input);
    const count = f.send.mock.calls.length;
    await f.e.maybeAutoCompact(input); expect(f.send).toHaveBeenCalledTimes(count);
    expect(f.notice).not.toHaveBeenCalled(); return;
  }
  await end(f); await f.e.maybeAutoCompact(input); expect(f.notice).not.toHaveBeenCalled();
});

it("a notice callback cannot restore a run that cancellation cleared", async () => {
  const f = fixture(); await end(f); await end(f); await end(f);
  const state = f.e.getPreparationState(input.sessionName)!;
  f.notice.mockImplementationOnce(async () => { f.e.cancelPreparation(input.sessionName); });
  await f.e.maybeAutoCompact(input);
  const saved = JSON.parse(readFileSync(join(dirname(state.mapPath), COMPACTION_RECORD_FILE), "utf8"));
  expect(saved.preparationFailures).toBeUndefined();
  await f.e.maybeAutoCompact(input); expect(f.notice).toHaveBeenCalledTimes(1);
});

it("the run that opens the notice is the seat's recovery inability, with the context sample the notice carries", async () => {
  const f = fixture();
  await end(f); await end(f);
  expect(f.e.recoveryInability(input.sessionName)).toBeNull();
  const last = await end(f);
  await f.e.maybeAutoCompact({ ...input, sampledAt: "2026-11-26T19:00:00Z" });
  expect(f.notice).toHaveBeenCalledWith(expect.objectContaining({ context: { usedPercentage: 90, sampledAt: "2026-11-26T19:00:00Z" } }));
  expect(f.e.recoveryInability(input.sessionName)).toBe(
    `its own managed compaction ended 3 automatic attempts without /compact while its context stayed above the compaction threshold (latest attempt ${last})`);
  expect(f.e.recoveryInability("other@test")).toBeNull();
});

it.each(["below", "cancel", "generation"])("no inability after %s", async kind => {
  const f = fixture(); await end(f); await end(f); await end(f); await f.e.maybeAutoCompact(input);
  expect(f.e.recoveryInability(input.sessionName)).not.toBeNull();
  if (kind === "below") await f.e.maybeAutoCompact({ ...input, usedPercentage: 20 });
  if (kind === "cancel") f.e.cancelPreparation(input.sessionName);
  // Another occupant, or a live occupant the daemon can't read, is not the seat the run was about.
  if (kind === "generation") f.generation("g2");
  expect(f.e.recoveryInability(input.sessionName)).toBeNull();
});

/** One automatic attempt whose request is delivered and whose map never completes: it ends preparation_incomplete at its
 *  deadline. A poll while it waits neither counts it nor clears the run. */
async function endDelivered(f: ReturnType<typeof fixture>, waiting?: () => void) {
  f.send.mockResolvedValueOnce({ ok: true });
  await f.e.maybeAutoCompact(input);
  const state = f.e.getPreparationState(input.sessionName)!;
  expect(state).toMatchObject({ status: "waiting", delivery: "delivered" });
  await f.e.maybeAutoCompact(input);
  waiting?.();
  f.advance(AUTO_PREP_WAIT_MS_DEFAULT + 1);
  f.e.reconcilePreparations();
  expect(f.e.getPreparationState(input.sessionName)).toMatchObject({ status: "stopped", reason: "preparation_incomplete" });
  f.advance(); return state.attemptId;
}

it("a delivered request whose map never completes counts toward the notice: the context wall", async () => {
  const f = fixture();
  await endDelivered(f); await endDelivered(f); const last = await endDelivered(f);
  await f.e.maybeAutoCompact(input);
  expect(f.notice).toHaveBeenCalledTimes(1);
  expect(f.notice).toHaveBeenCalledWith(expect.objectContaining({ attemptId: last, endedAttempts: 3, reason: "preparation_incomplete", delivered: true }));
  expect(f.e.recoveryInability(input.sessionName)).toContain("ended 3 automatic attempts without /compact");
});

it("the third delivered attempt counts before the seat reads idle again: the notice opens while a fresh request waits", async () => {
  const f = fixture();
  await endDelivered(f); await endDelivered(f); const last = await endDelivered(f);
  vi.mocked(f.transport.waitUntilIdle).mockResolvedValue({ ok: false } as never); // the seat at its wall doesn't read idle again
  expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: false, reason: "waiting_for_idle" });
  expect(f.notice).toHaveBeenCalledTimes(1);
  expect(f.notice).toHaveBeenCalledWith(expect.objectContaining({ attemptId: last, endedAttempts: 3, delivered: true }));
  expect(f.e.getPreparationState(input.sessionName)?.attemptId).toBe(last); // no fresh request went out
});

it("unsent and delivered-incomplete attempts share one run, and an attempt still waiting for its map decides nothing", async () => {
  const f = fixture();
  await end(f); await end(f);
  await endDelivered(f, () => {
    expect(f.notice).not.toHaveBeenCalled();
    expect(f.e.recoveryInability(input.sessionName)).toBeNull();
  });
  await f.e.maybeAutoCompact(input);
  expect(f.notice).toHaveBeenCalledWith(expect.objectContaining({ endedAttempts: 3, delivered: true }));
});

it("an attempt that ended while its send was still pending, as across a daemon stop, interrupts the run like an uncertain send", async () => {
  let refuse = false;
  const f = fixture({ terminalPolicies: { check: () => { if (refuse) throw new TerminalPolicyRefusal("openrig" as never, "compaction" as never); } } });
  const at = { ...input, nodeId: "writer-node" };
  await end(f); await end(f);
  let stopped!: () => void; const midSend = new Promise<void>((resolve) => { stopped = resolve; });
  f.send.mockImplementationOnce(async (_session: string, _text: string, opts: { beforeWrite: () => void }) => {
    opts.beforeWrite(); // the prompt is being written: from here its delivery is pending
    f.advance(); refuse = true; await f.e.maybeAutoCompact(at); // later, a poll stops the attempt during the send
    stopped(); return new Promise(() => {}); // and the daemon stops before the send's result is recorded
  });
  void f.e.maybeAutoCompact(at); await midSend;
  const third = f.e.getPreparationState(input.sessionName)!;
  const file = join(dirname(third.mapPath), COMPACTION_RECORD_FILE);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ phase: "ended", delivery: "pending", reason: "terminal_policy_refused" });
  refuse = false; f.restart(); await f.e.maybeAutoCompact(at);
  expect(f.notice).not.toHaveBeenCalled();
  expect(f.e.recoveryInability(input.sessionName)).toBeNull();
  expect(JSON.parse(readFileSync(file, "utf8")).preparationFailures).toBeUndefined();
});

it("a delivered request whose map completes interrupts the run", async () => {
  const f = fixture();
  await end(f); await end(f);
  f.send.mockResolvedValueOnce({ ok: true });
  await f.e.maybeAutoCompact(input);
  const state = f.e.getPreparationState(input.sessionName)!;
  writeFileSync(state.mapPath, `# map\n${state.marker}\n`);
  // /compact is refused before input (the fixture's default send), so the complete map is held: the seat can recover.
  await f.e.maybeAutoCompact(input); await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(input.sessionName)?.attemptId).toBe(state.attemptId);
  const saved = JSON.parse(readFileSync(join(dirname(state.mapPath), COMPACTION_RECORD_FILE), "utf8"));
  expect(saved.preparationFailures).toBeUndefined();
  expect(f.notice).not.toHaveBeenCalled();
});

it("cancelling a recovered ended record resets the run across another restart", async () => {
  const f = fixture(); await end(f); await end(f);
  const state = f.e.getPreparationState(input.sessionName)!;
  const file = join(dirname(state.mapPath), COMPACTION_RECORD_FILE);
  f.restart(); f.e.recoverAfterRestart(input, null);
  expect(f.e.getPreparationState(input.sessionName)).toBeNull();
  f.e.cancelPreparation(input.sessionName);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ reason: "preparation_cancelled" });
  expect(JSON.parse(readFileSync(file, "utf8")).preparationFailures).toBeUndefined();
  f.restart(); await end(f); await end(f);
  await f.e.maybeAutoCompact(input); expect(f.notice).not.toHaveBeenCalled();
  await end(f); await f.e.maybeAutoCompact(input);
  expect(f.notice).toHaveBeenCalledTimes(1);
  expect(f.notice).toHaveBeenCalledWith(expect.objectContaining({ endedAttempts: 3 }));
});

it("a notice nobody can receive is recorded on the run and shown, tried again on later polls, and opened once someone can receive it", async () => {
  const f = fixture(); await end(f); await end(f); await end(f);
  f.notice.mockResolvedValue({ unaddressed: "No recovery recipient could be resolved" } as never);
  await f.e.maybeAutoCompact(input);
  expect(f.notice).toHaveBeenCalledWith(expect.objectContaining({ endedAttempts: 3 }));
  expect(f.e.getPreparationNotice(input.sessionName)).toEqual({ status: "not_addressed",
    failure: expect.stringContaining("ended 3 automatic attempts"), detail: "No recovery recipient could be resolved" });
  const saved = JSON.parse(readFileSync(f.notice.mock.calls[0]![0].statePath, "utf8"));
  expect(saved.preparationFailures).toMatchObject({ endedAttempts: 3, unaddressed: "No recovery recipient could be resolved" });
  expect(saved.preparationFailures.reportedAttempts).toBeUndefined();
  const tries = f.notice.mock.calls.length;
  await end(f); await f.e.maybeAutoCompact(input);
  expect(f.notice.mock.calls.length).toBeGreaterThan(tries); // still owed: later polls try again
  expect(f.e.getPreparationNotice(input.sessionName)?.status).toBe("not_addressed");
  f.notice.mockResolvedValue(undefined as never); // a recipient resolves
  await end(f); await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationNotice(input.sessionName)).toEqual({ status: "opened", failure: expect.stringContaining("automatic attempts") });
  const opened = f.notice.mock.calls.length;
  await f.e.maybeAutoCompact(input); expect(f.notice).toHaveBeenCalledTimes(opened);
  expect(f.e.getPreparationNotice("other@test")).toBeNull();
});

it("re-checks the seat's held notices on its first poll, on every poll while it can't act, and once when it can again", async () => {
  const recheck = vi.fn();
  const f = fixture({ onHeldNoticesRecheck: recheck });
  await f.e.maybeAutoCompact(input);
  expect(recheck).toHaveBeenCalledTimes(1); // the first poll since this daemon started
  await end(f); await end(f); await end(f);
  expect(recheck).toHaveBeenCalledTimes(1); // able to act throughout: nothing to re-check
  await f.e.maybeAutoCompact(input); // counts the third ended attempt: unable from this poll on
  expect(recheck).toHaveBeenCalledTimes(2);
  await f.e.maybeAutoCompact(input); expect(recheck).toHaveBeenCalledTimes(3);
  f.e.cancelPreparation(input.sessionName);
  await f.e.maybeAutoCompact(input); expect(recheck).toHaveBeenCalledTimes(4); // it can act again
  await f.e.maybeAutoCompact(input); expect(recheck).toHaveBeenCalledTimes(4);
  f.restart(); await f.e.maybeAutoCompact(input); expect(recheck).toHaveBeenCalledTimes(5);
  expect(recheck.mock.calls.every(([session]) => session === input.sessionName)).toBe(true);
});

it("a seat at its context wall, held at the idle gate on every poll, still has its held notices re-checked", async () => {
  const recheck = vi.fn();
  const f = fixture({ onHeldNoticesRecheck: recheck });
  await endDelivered(f); await endDelivered(f); await endDelivered(f);
  vi.mocked(f.transport.waitUntilIdle).mockResolvedValue({ ok: false } as never);
  const before = recheck.mock.calls.length;
  expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: false, reason: "waiting_for_idle" });
  expect(await f.e.maybeAutoCompact(input)).toMatchObject({ triggered: false, reason: "waiting_for_idle" });
  expect(f.e.recoveryInability(input.sessionName)).not.toBeNull();
  expect(recheck).toHaveBeenCalledTimes(before + 2);
});

it("a re-check that fails is tried again on the next poll", async () => {
  const recheck = vi.fn().mockRejectedValueOnce(new Error("database busy"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = fixture({ onHeldNoticesRecheck: recheck });
  await f.e.maybeAutoCompact(input); await f.e.maybeAutoCompact(input); await f.e.maybeAutoCompact(input);
  expect(recheck).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("held-notice re-check failed"), expect.objectContaining({ errorClass: "Error" }));
  warn.mockRestore();
});

it("rig compact --state shows the seat's own preparation notice while its run stands, and nothing without one", async () => {
  const f = fixture();
  const stateOf = async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("compactionEnforcer" as never, f.e); await next(); });
    app.route("/api/compaction", compactionRoutes());
    return (await app.request(`/api/compaction/state?session=${input.sessionName}`)).json() as Promise<Record<string, unknown>>;
  };
  await end(f); await end(f); await end(f);
  expect(await stateOf()).not.toHaveProperty("preparationNotice");
  f.notice.mockResolvedValue({ unaddressed: "No recovery recipient could be resolved" } as never);
  await f.e.maybeAutoCompact(input);
  expect((await stateOf()).preparationNotice).toEqual({ status: "not_addressed",
    failure: expect.stringContaining("ended 3 automatic attempts"), detail: "No recovery recipient could be resolved" });
  f.e.cancelPreparation(input.sessionName);
  expect(await stateOf()).not.toHaveProperty("preparationNotice");
});

it("an unsampled poll re-checks the held notices too, with the same dedupe, and only for a Claude seat", async () => {
  const recheck = vi.fn();
  const f = fixture({ onHeldNoticesRecheck: recheck });
  const unsampled = { sessionName: input.sessionName, runtime: "claude-code", cwd: null, lastUsedPercentage: null };
  await f.e.drainPendingPreparedCompact(unsampled); expect(recheck).toHaveBeenCalledTimes(1); // the first poll since this daemon started
  await f.e.drainPendingPreparedCompact(unsampled); expect(recheck).toHaveBeenCalledTimes(1); // able to act: nothing to re-check
  await end(f); await end(f); await end(f); await f.e.maybeAutoCompact(input); // the third ended attempt counts: unable
  const calls = recheck.mock.calls.length;
  await f.e.drainPendingPreparedCompact(unsampled); await f.e.drainPendingPreparedCompact(unsampled);
  expect(recheck).toHaveBeenCalledTimes(calls + 2);
  await f.e.drainPendingPreparedCompact({ ...unsampled, runtime: "codex" });
  expect(recheck).toHaveBeenCalledTimes(calls + 2);
});
