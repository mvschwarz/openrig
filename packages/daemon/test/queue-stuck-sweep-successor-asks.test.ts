import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { deriveCrossHostSuccessorId, type QueueRepository } from "../src/domain/queue-repository.js";
import {
  custodyClosureTargets, custodyRowAsksSuccessor, custodySkipsRecordedHandoff, targetAsksSuccessor, type CustodyRowFields,
} from "../src/domain/queue-stuck-sweep.js";

// The sweep's view of the repository module: the pass's successor index records the sources it loads and the ones the
// custody check asks it about, and the per-row successor query counts the sweep's own calls. Calls made inside the
// repository module (a row's handoff advisory) keep the module's own bindings and are not counted.
const seen = vi.hoisted(() => ({ loaded: [] as string[][], asked: [] as string[], perRow: [] as string[] }));
vi.mock("../src/domain/queue-repository.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/domain/queue-repository.js")>();
  return {
    ...original,
    hasLinkedSuccessor: (db: Database.Database, source: string, target: string) => {
      seen.perRow.push(source);
      return original.hasLinkedSuccessor(db, source, target);
    },
    createLinkedSuccessorLookup: (...args: Parameters<typeof original.createLinkedSuccessorLookup>) => {
      const lookup = original.createLinkedSuccessorLookup(...args);
      seen.loaded.push([...args[1]]);
      return { ...lookup, has: (source: string, target: string) => { seen.asked.push(source); return lookup.has(source, target); } };
    },
  };
});

const row = (fields: Partial<CustodyRowFields>): CustodyRowFields => ({
  qitemId: "qitem-source", state: "done", handedOffTo: null, closureTarget: null, closureReason: "handed_off_to", ...fields,
});

describe("which custody rows the stuck sweep's successor read loads", () => {
  it("splits the targets the custody check verifies and asks the successor read only for the non-qitem ones", () => {
    expect(custodyClosureTargets(row({ closureTarget: "qitem-a, next@rig-a , ,other@rig-b" })))
      .toEqual(["qitem-a", "next@rig-a", "other@rig-b"]);
    expect(custodyClosureTargets(row({ handedOffTo: "prior@rig-a" }))).toEqual(["prior@rig-a"]);
    expect(custodyClosureTargets(row({}))).toEqual(["(unspecified)"]);
    expect(custodyClosureTargets(row({ closureReason: "no-follow-on" }))).toEqual([]);
    expect(custodyClosureTargets(row({ closureReason: null }))).toEqual([]);
    expect(["qitem-a", "qitem-a@host-b", "next@rig-a", "(unspecified)"].map(targetAsksSuccessor))
      .toEqual([false, false, true, true]);

    const remote = `${deriveCrossHostSuccessorId("qitem-source", "next@rig-a", "host-b")}@host-b`;
    expect(custodySkipsRecordedHandoff(row({ state: "handed-off", handedOffTo: "next@rig-a", closureTarget: remote }))).toBe(true);
    expect(custodySkipsRecordedHandoff(row({ state: "done", handedOffTo: "next@rig-a", closureTarget: remote }))).toBe(false);
    expect(custodySkipsRecordedHandoff(row({ state: "handed-off", handedOffTo: "prior@rig-a", closureTarget: "next@rig-a" }))).toBe(false);

    expect([
      row({ closureTarget: "qitem-a" }),
      row({ closureTarget: "qitem-a, qitem-b@host-b" }),
      row({ closureTarget: "qitem-a, next@rig-a" }),
      row({ closureTarget: "next@rig-a" }),
      row({}),
      row({ closureReason: "no-follow-on" }),
      row({ handedOffTo: "prior@rig-a" }),
      row({ state: "handed-off", handedOffTo: "next@rig-a", closureTarget: remote }),
    ].map(custodyRowAsksSuccessor)).toEqual([false, false, true, true, true, false, true, false]);
  });

  describe("in a pass", () => {
    let db: Database.Database;
    let repo: QueueRepository;
    let runStuckSweep: typeof import("../src/domain/queue-stuck-sweep.js").runStuckSweep;

    // A module the test setup already loaded keeps the repository's original bindings; the sweep and the repository are
    // imported again so the sweep sees the mock.
    let fresh: () => { db: Database.Database; repo: QueueRepository };
    beforeAll(async () => {
      vi.resetModules();
      const { createDb } = await import("../src/db/connection.js");
      const { migrate } = await import("../src/db/migrate.js");
      const { ALL_MIGRATIONS } = await import("../src/db/all-migrations.js");
      const { EventBus } = await import("../src/domain/event-bus.js");
      const { QueueRepository } = await import("../src/domain/queue-repository.js");
      ({ runStuckSweep } = await import("../src/domain/queue-stuck-sweep.js"));
      fresh = () => {
        const d = createDb();
        migrate(d, ALL_MIGRATIONS);
        return { db: d, repo: new QueueRepository(d, new EventBus(d), { validateRig: () => true }) };
      };
    });

    beforeEach(() => {
      ({ db, repo } = fresh());
      seen.loaded.length = 0;
      seen.asked.length = 0;
      seen.perRow.length = 0;
    });
    afterEach(() => db.close());

    const open = async () => (await repo.create({ sourceSession: "sender@rig-a", destinationSession: "worker@rig-a",
      body: "work", nudge: false })).qitemId;
    const close = (id: string, f: { state?: string; handedOffTo?: string | null; closureTarget?: string | null; closureReason?: string | null }) => {
      db.prepare("UPDATE queue_items SET state = ?, handed_off_to = ?, closure_target = ?, closure_reason = ? WHERE qitem_id = ?")
        .run(f.state ?? "done", f.handedOffTo ?? null, f.closureTarget ?? null, "closureReason" in f ? f.closureReason : "handed_off_to", id);
    };

    it("loads every row the custody check asks about, so no unchanged row falls back to the per-row query", async () => {
      const existing = await open();
      const ids: Record<string, string> = {};
      const add = async (name: string, f: Parameters<typeof close>[1]) => { ids[name] = await open(); close(ids[name]!, f); };
      // The custody check asks the successor read about these.
      await add("session", { closureTarget: "next@rig-a" });
      await add("mixed", { closureTarget: `${existing}, next@rig-a , other@rig-b` });
      await add("unspecified", {});
      await add("handoffOnly", { handedOffTo: "prior@rig-a" });
      await add("reclosed", { state: "handed-off", handedOffTo: "prior@rig-a", closureTarget: "next@rig-a" });
      // Each of their targets has a linked successor, so no finding is created and nothing re-checks a row live.
      const successor = async (source: string, target: string) => {
        const { qitemId } = await repo.create({ sourceSession: "worker@rig-a", destinationSession: "next@rig-a",
          body: "follow-on", chainOfRecord: [source], nudge: false });
        db.prepare("UPDATE queue_items SET destination_session = ? WHERE qitem_id = ?").run(target, qitemId);
      };
      await successor(ids.session!, "next@rig-a");
      await successor(ids.mixed!, "next@rig-a");
      await successor(ids.mixed!, "other@rig-b");
      await successor(ids.unspecified!, "(unspecified)");
      await successor(ids.handoffOnly!, "prior@rig-a");
      await successor(ids.reclosed!, "next@rig-a");
      // ...and not about these.
      await add("qitem", { closureTarget: existing });
      await add("qitems", { closureTarget: `${existing}, qitem-elsewhere@host-b` });
      await add("foreign", { closureTarget: "qitem-elsewhere@host-b" });
      const asking = ["session", "mixed", "unspecified", "handoffOnly", "reclosed"].map((name) => ids[name]!);
      ids.remote = await open();
      repo.closeCrossHostHandoffSource({ qitemId: ids.remote, fromSession: "worker@rig-a", toSession: "next@rig-a",
        closureTarget: `${deriveCrossHostSuccessorId(ids.remote, "next@rig-a", "host-b")}@host-b`, terminalState: "handed-off" });
      // Loaded but not asked: its only target is custody-verified (the load is a superset of the asks).
      ids.verified = await open();
      repo.update({ qitemId: ids.verified, actorSession: "worker@rig-a", transitionNote: "custody-verified: done@rig-a checked by hand" });
      close(ids.verified, { closureTarget: "done@rig-a" });

      const sweep = await runStuckSweep({ db, queueRepo: repo, resolveOrchestrator: () => null, isRegisteredHost: () => false, log: () => {} });
      expect(sweep.findings.filter((f) => asking.includes(f.qitemId) || f.qitemId === ids.verified)).toEqual([]);

      expect(seen.loaded).toHaveLength(1);
      expect(new Set(seen.loaded[0])).toEqual(new Set([...asking, ids.verified]));
      expect(new Set(seen.asked)).toEqual(new Set(asking));
      expect(seen.asked.every((source) => seen.loaded[0]!.includes(source))).toBe(true);
      expect(seen.perRow).toEqual([]);
    });
  });
});
