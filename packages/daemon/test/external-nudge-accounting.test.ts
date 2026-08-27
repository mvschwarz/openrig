import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

// DEFECT qitem-20260827065907-b9ae334c (S1-class, desk-verified live, 3 specimens): the
// queue NUDGE path fell through to tmux resolution for @external human destinations and
// recorded `failed: Session 'human-founder@external' not found: tmux reports no session`
// while the gateway subsystem (the Slack connector's queue-polling bridge) delivered the
// actual message. Two halves: (a) an @external wake is GATEWAY-OWNED — the row itself is
// the connector's input and the connector's ledger is the delivery record; tmux must
// never be consulted; (b) the recorded wording must be honest for an address class tmux
// can never hold. The poisoned `failed:` literal also corrupted the undelivered surface
// (a delivered founder message read as a failed wake — the dogfood-aggregation caveat).

const FOUNDER = "human-founder@external";

describe("external-nudge accounting (gateway-owned, never tmux)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let sends: Array<{ session: string; text: string }>;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, outboxEntriesSchema]);
    bus = new EventBus(db);
    sends = [];
    repo = new QueueRepository(db, bus, {
      transport: {
        // The live specimens' exact transport behavior for the class: tmux cannot hold it.
        send: async (sessionName: string, text: string) => {
          sends.push({ session: sessionName, text });
          return sessionName.endsWith("@external")
            ? { ok: false, error: `Session '${sessionName}' not found: tmux reports no session with this name. No text was sent. Check available sessions with: rig ps --nodes` }
            : { ok: true, verified: true };
        },
      },
    });
    repo.attachOutbox(new OutboxHandler(db));
  });

  it("SPECIMEN SHAPE: a create nudging @external never touches tmux transport and records a gateway-owned result", async () => {
    const item = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: FOUNDER,
      body: "L1 alert for the founder",
      summary: "Founder alert: plain-language decision ask",
      evidenceRef: "shared-docs/rigs/v-openrig-build/state/evidence-a.md",
    });
    // (a) tmux was NOT consulted — the row itself is the gateway's input:
    expect(sends).toHaveLength(0);
    const fresh = repo.getById(item.qitemId)!;
    // (b) honest wording: names the owning subsystem AND that tmux was not consulted,
    // and never claims positive tmux evidence for an address class tmux can never hold.
    expect(fresh.lastNudgeResult).toMatch(/^gateway-owned/);
    expect(fresh.lastNudgeResult).toMatch(/tmux was not consulted/i);
    expect(fresh.lastNudgeResult).not.toMatch(/^failed:/);
    expect(fresh.lastNudgeResult).not.toMatch(/tmux reports no session/);
    expect(fresh.lastNudgeAttempt).not.toBeNull(); // the attempt is still recorded
  });

  it("DOGFOOD SURFACE HEALED: an @external row never appears on the undelivered (failed-nudge) surface", async () => {
    const item = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: FOUNDER,
      body: "founder message that DID deliver via slack",
      summary: "Founder message: delivered on the phone",
      evidenceRef: "shared-docs/rigs/v-openrig-build/state/evidence-b.md",
    });
    const undelivered = repo.findUndelivered({});
    expect(undelivered.map((u) => u.qitemId)).not.toContain(item.qitemId);
  });

  it("HANDOFF INTENT PATH: a wake intent to @external drains as gateway-owned without touching transport", async () => {
    const item = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "dev50-driver@v-openrig-build",
      body: "work",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "dev50-driver@v-openrig-build" });
    await repo.handoff({
      qitemId: item.qitemId,
      fromSession: "dev50-driver@v-openrig-build",
      toSession: FOUNDER,
      summary: "Escalation to the founder in plain language",
      evidenceRef: "shared-docs/rigs/v-openrig-build/state/evidence-c.md",
    });
    await repo.drainPendingWakeIntents();
    expect(sends.filter((s) => s.session === FOUNDER)).toHaveLength(0);
    const successor = repo
      .list({ destinationSession: FOUNDER, limit: 10 })
      .find((r) => r.handedOffFrom === item.qitemId)!;
    expect(successor).toBeDefined();
    expect(successor.lastNudgeResult ?? "").toMatch(/^gateway-owned/);
  });

  it("CONTROL: an ordinary agent destination still nudges through tmux transport exactly as before", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "ping",
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.session).toBe("bob@rig");
    expect(repo.getById(item.qitemId)!.lastNudgeResult).toBe("verified");
  });

  it("CONTROL: a human-CLASS seat with a REAL pane (human-*@kernel) keeps tmux transport — only the virtual @external domain is gateway-owned", async () => {
    const item = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-operator@kernel",
      body: "operator ping",
      summary: "Operator ping in plain language",
      evidenceRef: "shared-docs/rigs/v-openrig-build/state/evidence-d.md",
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.session).toBe("human-operator@kernel");
    expect(repo.getById(item.qitemId)!.lastNudgeResult).toBe("verified");
  });
});
