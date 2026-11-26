// #331 (item 1): a stall finding names what OpenRig already knows about the seat it's about, as observations: the messages
// its delivery guard holds and its latest context sample, with whether a percentage is used or remaining and when it was
// sampled. Whatever couldn't be read says unknown, never a cause.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";
import { seatEvidenceReader, type SeatEvidence } from "../src/domain/seat-evidence.js";
import type { ContextUsage } from "../src/domain/types.js";

const SEAT = "worker@r";

function usage(overrides: Partial<ContextUsage>): ContextUsage {
  return { availability: "known", reason: null, source: "claude_statusline_json", usedPercentage: null, remainingPercentage: null,
    contextWindowSize: null, totalInputTokens: null, totalOutputTokens: null, currentUsage: null, transcriptPath: null,
    sessionId: null, sessionName: SEAT, sampledAt: null, fresh: true, ...overrides };
}

describe("#331: a stall finding names the evidence already held about its seat", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  });
  afterEach(() => db.close());

  /** A row claimed an hour ago and never touched since: the sweep writes a stalled-after-claim finding for it. */
  async function stalledFindingBody(seatEvidence?: (session: string) => SeatEvidence | null): Promise<string> {
    const row = await repo.create({ sourceSession: "sender@r", destinationSession: SEAT, body: "work", nudge: false });
    repo.claim({ qitemId: row.qitemId, destinationSession: SEAT });
    const claimed = new Date(Date.now() - 60 * 60_000).toISOString(), created = new Date(Date.now() - 61 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ? WHERE qitem_id = ?").run(claimed, created, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'claimed'").run(claimed, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'created'").run(created, row.qitemId);
    await runStuckSweep({ db, queueRepo: repo, status: createStuckSweepStatus(), resolveOrchestrator: () => null, unclaimedAgeMinutes: 60,
      log: () => {}, isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null,
      ...(seatEvidence ? { seatEvidence } : {}) });
    const finding = repo.list({ limit: 100 }).find((item) => (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG)
      && (item.tags ?? []).some((tag) => tag.endsWith(`:${row.qitemId}`)));
    expect(finding?.body).toContain("STUCK SWEEP FINDING (stalled-after-claim)");
    return finding!.body;
  }

  it("names the messages the seat's guard holds, with the command that lists them", async () => {
    const body = await stalledFindingBody(() => ({ heldMessages: 13, context: null }));
    expect(body).toMatch(/\nseat worker@r as known at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \(observations, not a diagnosis\):\n/);
    expect(body).toContain(`- messages held for it: 13 (rig seat held-messages ${SEAT})`);
    expect(body).toContain("- context: unknown");
  });

  it("names a context sample with whether it's used or remaining, and when and where it was sampled", async () => {
    const body = await stalledFindingBody(() => ({ heldMessages: 0,
      context: usage({ usedPercentage: 0, remainingPercentage: 100, sampledAt: "2026-11-26T15:58:12.000Z" }) }));
    expect(body).toContain("- messages held for it: none");
    expect(body).toContain("- context: 0% used, 100% remaining, sampled 2026-11-26T15:58:12.000Z from claude_statusline_json");
    // A stale sample says so.
    const stale = await stalledFindingBody(() => ({ heldMessages: 0,
      context: usage({ usedPercentage: 91.26, remainingPercentage: null, sampledAt: "2026-11-26T09:00:00.000Z", fresh: false }) }));
    expect(stale).toContain("- context: 91.3% used, sampled 2026-11-26T09:00:00.000Z from claude_statusline_json, not fresh");
  });

  it("says unknown for whatever couldn't be read, and leaves the finding's reason as it was", async () => {
    const without = await stalledFindingBody();
    const body = await stalledFindingBody(() => ({ heldMessages: null, context: usage({ availability: "unknown", reason: "no_data", source: null }) }));
    expect(body).toContain("- messages held for it: unknown (couldn't be read)");
    expect(body).toContain("- context: unknown (no_data)");
    expect(body).toContain("(observations, not a diagnosis)");
    const why = (text: string) => text.split("\n").find((line) => line.startsWith("why: "));
    expect(why(body)).toBe(why(without));
    // A reader that fails outright reads as unknown too.
    const failed = await stalledFindingBody(() => { throw new Error("store unavailable"); });
    expect(failed).toContain("- messages held for it: unknown (couldn't be read)");
    expect(failed).toContain("- context: unknown");
  });

  it("adds nothing for a destination that isn't a seat, or with no reader", async () => {
    expect(await stalledFindingBody(() => null)).not.toContain("as known at");
    expect(await stalledFindingBody()).not.toContain("as known at");
  });

  it("reads the seat behind a session name: its held messages, and its context sample by node and session", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'worker')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-1', 'node-1', ?, 'running')").run(SEAT);
    const asked: Array<[string, string | null]> = [];
    const sample = usage({ usedPercentage: 40, sampledAt: "2026-11-26T15:00:00.000Z" });
    const read = seatEvidenceReader(db, { getForNode: (nodeId, session) => { asked.push([nodeId, session]); return sample; } });
    expect(read(SEAT)).toEqual({ heldMessages: 0, context: sample });
    expect(asked).toEqual([["node-1", SEAT]]);
    expect(read("person@external")).toBeNull();
    const failing = seatEvidenceReader(db, { getForNode: () => { throw new Error("unreadable"); } });
    expect(failing(SEAT)).toEqual({ heldMessages: 0, context: null });
    expect(seatEvidenceReader(db)(SEAT)).toEqual({ heldMessages: 0, context: null });
  });
});
