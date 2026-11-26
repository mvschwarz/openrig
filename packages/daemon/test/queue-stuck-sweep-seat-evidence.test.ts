// #331 (item 1): a stall finding names what OpenRig already knows about the seat it's about, as observations: the messages
// its delivery guard holds and its latest context sample, with whether a percentage is used or remaining and when it was
// sampled. Whatever couldn't be read says unknown, never a cause.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";
import { seatEvidenceReader, type SeatEvidence } from "../src/domain/seat-evidence.js";
import type { ContextUsage } from "../src/domain/types.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";

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

  it("reports an unreadable seat lookup as unknown, not as a known non-seat destination", async () => {
    const body = await stalledFindingBody((session) => {
      const prepare = db.prepare.bind(db);
      const failing = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.startsWith("SELECT node_id FROM sessions WHERE session_name")) throw new Error("seat lookup unavailable");
        return prepare(sql);
      });
      try { return seatEvidenceReader(db)(session); } finally { failing.mockRestore(); }
    });
    expect(body).toContain("- messages held for it: unknown (couldn't be read)");
    expect(body).toContain("- context: unknown");
  });

  it("joins real held counts and context through the current seat alias without exposing message or transcript contents", async () => {
    const physical = "old-worker@r";
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'worker')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-1', 'node-1', ?, 'running')").run(physical);
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES ('binding-1', 'node-1', ?)").run(physical);
    const insert = db.prepare("INSERT INTO outbox_entries (outbox_id, sender_session, destination_session, body, ts_dispatched, delivery_state, guard_binding) VALUES (?, 'sender@r', ?, 'PRIVATE_MESSAGE_SENTINEL', ?, ?, ?)");
    for (const [id, state, nodeId] of [["one", "retained", "node-1"], ["two", "retained", "node-1"],
      ["other-seat", "retained", "node-2"], ["delivered", "delivered", "node-1"]]) {
      insert.run(id, physical, new Date().toISOString(), state, JSON.stringify({ nodeId }));
    }
    const store = new ContextUsageStore(db, { stateDir: "." });
    store.persist("node-1", usage({ sessionName: physical, sampledAt: new Date().toISOString(), usedPercentage: 0,
      remainingPercentage: 100, transcriptPath: "PRIVATE_TRANSCRIPT_SENTINEL" }));
    const body = await stalledFindingBody(seatEvidenceReader(db, store));
    expect(body).toContain(`- messages held for it: 2 (rig seat held-messages ${SEAT})`);
    expect(body).toContain("- context: 0% used, 100% remaining, sampled ");
    expect(body).not.toContain("PRIVATE_MESSAGE_SENTINEL");
    expect(body).not.toContain("PRIVATE_TRANSCRIPT_SENTINEL");
  });

  it("retains the real context store's session and generation checks", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'worker')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-1', 'node-1', ?, 'running')").run(SEAT);
    const store = new ContextUsageStore(db, { stateDir: ".", resolveOccupantBootAt: () => "2026-11-26T12:00:00Z" });
    const read = seatEvidenceReader(db, store);
    store.persist("node-1", usage({ sessionName: "different@r", sampledAt: "2026-11-26T13:00:00Z", usedPercentage: 99 }));
    expect(read(SEAT)?.context).toMatchObject({ availability: "unknown", reason: "session_mismatch", usedPercentage: null });
    store.persist("node-1", usage({ sampledAt: "2026-11-26T11:00:00Z", usedPercentage: 99 }));
    expect(read(SEAT)?.context).toMatchObject({ availability: "unknown", reason: "stale_generation", usedPercentage: null });
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
