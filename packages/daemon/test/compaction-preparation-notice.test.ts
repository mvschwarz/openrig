import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeCompactionEnforcer, COMPACTION_RECORD_FILE, type PreparationFailure } from "../src/domain/claude-compaction-enforcer.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const input = { sessionName: "writer@test", runtime: "claude-code", usedPercentage: 90 };
function fixture() {
  let clock = 10000, generation = "g1", restarts = 0;
  const home = mkdtempSync(join(tmpdir(), "prep-notice-")); homes.push(home);
  const send = vi.fn(async (): Promise<any> => { clock++; return { ok: false, sent: false, inputPhase: "not_reached", reason: "draft_input_busy" }; });
  const notice = vi.fn(async (_failure: PreparationFailure) => {});
  const policy = { enabled: true, thresholdPercent: 80, preCompactInstruction: "Write a map.", compactInstruction: "" };
  const opts = { openrigHome: home, now: () => clock, resolveOccupantGeneration: () => generation,
    autoRetryAfterStopMs: 1, onPreparationFailure: notice };
  const transport = { send, waitUntilIdle: vi.fn(async () => ({ ok: true })) } as unknown as SessionTransport;
  let e = new ClaudeCompactionEnforcer({ resolveClaudeCompactionPolicy: () => policy } as any, transport, opts);
  return { get e() { return e; }, send, notice, advance: (n = 2) => { clock += n; },
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
