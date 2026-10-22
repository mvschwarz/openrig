import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { humanNotificationIntentSchema } from "../src/db/migrations/081_human_notification_intent.js";
import { humanQuestionsSchema } from "../src/db/migrations/091_human_questions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";

describe("Issue #1040: update existing queue summary without changing qitem state", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      inboxEntriesSchema,
      outboxEntriesSchema,
      queueTargetRepoSchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
      humanNotificationIntentSchema,
      humanQuestionsSchema,
    ]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
  });

  afterEach(() => db.close());

  it("allows updating summary on a pending human-intent row without changing its state", async () => {
    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "founder@external",
      body: "Decision request",
      humanIntent: "decision",
      summary: "Original summary",
      evidenceRef: "/docs/brief.md",
    });

    expect(item.state).toBe("pending");
    expect(item.summary).toBe("Original summary");

    const updated = repo.update({
      qitemId: item.qitemId,
      actorSession: "orch@rig",
      summary: "Corrected operator-facing summary",
      transitionNote: "corrected wording in brief",
    });

    expect(updated.state).toBe("pending");
    expect(updated.summary).toBe("Corrected operator-facing summary");
    expect(updated.evidenceRef).toBe("/docs/brief.md");
    expect(updated.humanIntent).toBe("decision");
    expect(updated.destinationSession).toBe("founder@external");

    // Check transition log
    const transitions = repo.transitionLog.listForQitem(item.qitemId);
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition?.state).toBe("pending");
    expect(lastTransition?.transitionNote).toBe("corrected wording in brief (summary updated)");
  });

  it("allows updating summary on an in-progress row without state transition", async () => {
    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "worker@rig",
      body: "Build task",
      summary: "Build step 1",
    });

    repo.update({
      qitemId: item.qitemId,
      actorSession: "worker@rig",
      state: "in-progress",
    });

    const updated = repo.update({
      qitemId: item.qitemId,
      actorSession: "worker@rig",
      summary: "Build step 1 (refined scope)",
    });

    expect(updated.state).toBe("in-progress");
    expect(updated.summary).toBe("Build step 1 (refined scope)");

    const transitions = repo.transitionLog.listForQitem(item.qitemId);
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition?.state).toBe("in-progress");
    expect(lastTransition?.transitionNote).toBe("summary updated");
  });

  it("allows updating summary on a blocked row without altering its blocker or wake", async () => {
    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "worker@rig",
      body: "Blocked item",
    });

    repo.update({
      qitemId: item.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "human@kernel",
      summary: "Initial park summary",
      evidenceRef: "/proof.md",
    });

    const updated = repo.update({
      qitemId: item.qitemId,
      actorSession: "worker@rig",
      summary: "Refined park summary",
    });

    expect(updated.state).toBe("blocked");
    expect(updated.blockedOn).toBe("human@kernel");
    expect(updated.summary).toBe("Refined park summary");
    expect(updated.evidenceRef).toBe("/proof.md");
  });

  it("allows updating summary on a non-human-blocked row without state transition", async () => {
    const blocker = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "worker-b@rig",
      body: "Blocker task",
    });

    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "worker@rig",
      body: "Waiting item",
    });

    repo.update({
      qitemId: item.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
    });

    const updated = repo.update({
      qitemId: item.qitemId,
      actorSession: "worker@rig",
      summary: "Waiting on blocker task with updated notes",
    });

    expect(updated.state).toBe("blocked");
    expect(updated.blockedOn).toBe(blocker.qitemId);
    expect(updated.summary).toBe("Waiting on blocker task with updated notes");
  });

  it("still rejects other state-write fields if supplied alongside summary without state change", async () => {
    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "worker@rig",
      body: "Item",
      summary: "S",
    });

    expect(() => {
      repo.update({
        qitemId: item.qitemId,
        actorSession: "worker@rig",
        summary: "New S",
        blockedOn: "another@seat",
      });
    }).toThrow(QueueRepositoryError);
    expect(repo.getById(item.qitemId)?.summary).toBe("S");
  });

  it("allows updating summary in terminal states without reopening or mutating other fields", async () => {
    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "worker@rig",
      body: "Terminal task",
      summary: "Initial summary",
      tags: ["qa", "release"],
    });

    repo.update({
      qitemId: item.qitemId,
      actorSession: "worker@rig",
      state: "in-progress",
    });

    repo.update({
      qitemId: item.qitemId,
      actorSession: "worker@rig",
      state: "done",
      closureReason: "no-follow-on",
    });

    expect(repo.getById(item.qitemId)?.state).toBe("done");

    const updated = repo.update({
      qitemId: item.qitemId,
      actorSession: "orch@rig",
      summary: "Updated post-close brief",
    });

    expect(updated.state).toBe("done");
    expect(updated.closureReason).toBe("no-follow-on");
    expect(updated.summary).toBe("Updated post-close brief");
    expect(updated.body).toBe("Terminal task");
    expect(updated.destinationSession).toBe("worker@rig");
    expect(updated.tags).toEqual(["qa", "release"]);
  });

  describe("malformed summaries write nothing (issue #1040)", () => {
    it("refuses summary: null with no note or state and writes nothing", async () => {
      const item = await repo.create({
        sourceSession: "orch@rig",
        destinationSession: "worker@rig",
        body: "Task",
        summary: "Original summary",
      });
      const initialTransitions = repo.transitionLog.listForQitem(item.qitemId);

      expect(() => {
        repo.update({
          qitemId: item.qitemId,
          actorSession: "worker@rig",
          summary: null,
        });
      }).toThrow(QueueRepositoryError);

      const after = repo.getById(item.qitemId);
      expect(after?.summary).toBe("Original summary");
      expect(after?.state).toBe("pending");
      expect(repo.transitionLog.listForQitem(item.qitemId)).toHaveLength(initialTransitions.length);
    });

    it("refuses a non-string summary with no note or state and writes nothing", async () => {
      const item = await repo.create({
        sourceSession: "orch@rig",
        destinationSession: "worker@rig",
        body: "Task",
        summary: "Original summary",
      });
      const initialTransitions = repo.transitionLog.listForQitem(item.qitemId);

      expect(() => {
        repo.update({
          qitemId: item.qitemId,
          actorSession: "worker@rig",
          summary: 123 as unknown as string,
        });
      }).toThrow(QueueRepositoryError);

      const after = repo.getById(item.qitemId);
      expect(after?.summary).toBe("Original summary");
      expect(after?.state).toBe("pending");
      expect(repo.transitionLog.listForQitem(item.qitemId)).toHaveLength(initialTransitions.length);
    });

    it("refuses an empty or whitespace-only summary and writes nothing", async () => {
      const item = await repo.create({
        sourceSession: "orch@rig",
        destinationSession: "worker@rig",
        body: "Task",
        summary: "Original summary",
      });
      const initialTransitions = repo.transitionLog.listForQitem(item.qitemId);

      // Empty string
      expect(() => {
        repo.update({
          qitemId: item.qitemId,
          actorSession: "worker@rig",
          summary: "",
        });
      }).toThrow(QueueRepositoryError);

      expect(repo.getById(item.qitemId)?.summary).toBe("Original summary");
      expect(repo.transitionLog.listForQitem(item.qitemId)).toHaveLength(initialTransitions.length);

      // Whitespace only
      expect(() => {
        repo.update({
          qitemId: item.qitemId,
          actorSession: "worker@rig",
          summary: "   \t\n  ",
        });
      }).toThrow(QueueRepositoryError);

      expect(repo.getById(item.qitemId)?.summary).toBe("Original summary");
      expect(repo.transitionLog.listForQitem(item.qitemId)).toHaveLength(initialTransitions.length);
    });

    it("refuses a malformed summary supplied alongside a transition note and writes nothing", async () => {
      const item = await repo.create({
        sourceSession: "orch@rig",
        destinationSession: "worker@rig",
        body: "Task",
        summary: "Original summary",
      });
      const initialTransitions = repo.transitionLog.listForQitem(item.qitemId);

      expect(() => {
        repo.update({
          qitemId: item.qitemId,
          actorSession: "worker@rig",
          summary: "",
          transitionNote: "some note",
        });
      }).toThrow(QueueRepositoryError);

      expect(repo.getById(item.qitemId)?.summary).toBe("Original summary");
      expect(repo.transitionLog.listForQitem(item.qitemId)).toHaveLength(initialTransitions.length);

      expect(() => {
        repo.update({
          qitemId: item.qitemId,
          actorSession: "worker@rig",
          summary: 456 as unknown as string,
          transitionNote: "some note",
        });
      }).toThrow(QueueRepositoryError);

      expect(repo.getById(item.qitemId)?.summary).toBe("Original summary");
      expect(repo.transitionLog.listForQitem(item.qitemId)).toHaveLength(initialTransitions.length);
    });
  });

  describe("summary sent with explicit same state is refused (issue #1040)", () => {
    it("refuses summary sent with same state on a done item and writes nothing", async () => {
      const item = await repo.create({
        sourceSession: "orch@rig",
        destinationSession: "worker@rig",
        body: "Terminal task",
        summary: "Original summary",
      });

      repo.update({
        qitemId: item.qitemId,
        actorSession: "worker@rig",
        state: "done",
        closureReason: "no-follow-on",
      });

      const initialTransitions = repo.transitionLog.listForQitem(item.qitemId);

      expect(() => {
        repo.update({
          qitemId: item.qitemId,
          actorSession: "worker@rig",
          state: "done",
          summary: "Attempted summary update with same state",
        });
      }).toThrow(QueueRepositoryError);

      const after = repo.getById(item.qitemId);
      expect(after?.state).toBe("done");
      expect(after?.summary).toBe("Original summary");
      expect(repo.transitionLog.listForQitem(item.qitemId)).toHaveLength(initialTransitions.length);
    });

    it("refuses summary sent with same state on a canceled item and writes nothing", async () => {
      const item = await repo.create({
        sourceSession: "orch@rig",
        destinationSession: "worker@rig",
        body: "Canceled task",
        summary: "Original summary",
      });

      repo.update({
        qitemId: item.qitemId,
        actorSession: "worker@rig",
        state: "canceled",
      });

      const initialTransitions = repo.transitionLog.listForQitem(item.qitemId);

      expect(() => {
        repo.update({
          qitemId: item.qitemId,
          actorSession: "worker@rig",
          state: "canceled",
          summary: "Attempted summary update with same state",
        });
      }).toThrow(QueueRepositoryError);

      const after = repo.getById(item.qitemId);
      expect(after?.state).toBe("canceled");
      expect(after?.summary).toBe("Original summary");
      expect(repo.transitionLog.listForQitem(item.qitemId)).toHaveLength(initialTransitions.length);
    });

    it("refuses summary sent with same state on a handed-off item and writes nothing", async () => {
      const item = await repo.create({
        sourceSession: "orch@rig",
        destinationSession: "worker@rig",
        body: "Handoff task",
        summary: "Original summary",
      });

      repo.update({
        qitemId: item.qitemId,
        actorSession: "worker@rig",
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: "qitem-target",
      });

      const initialTransitions = repo.transitionLog.listForQitem(item.qitemId);

      expect(() => {
        repo.update({
          qitemId: item.qitemId,
          actorSession: "worker@rig",
          state: "handed-off",
          summary: "Attempted summary update with same state",
        });
      }).toThrow(QueueRepositoryError);

      const after = repo.getById(item.qitemId);
      expect(after?.state).toBe("handed-off");
      expect(after?.summary).toBe("Original summary");
      expect(repo.transitionLog.listForQitem(item.qitemId)).toHaveLength(initialTransitions.length);
    });
  });
});
