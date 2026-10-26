import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { addHumanFragment } from "../src/domain/gateway/human-registry.js";
import { setDefaultPerson } from "../src/domain/gateway/participants.js";
import { makeOperatorDeliveryEngine } from "../src/domain/gateway/operator-delivery-engine.js";
import { MissionControlReadLayer } from "../src/domain/mission-control/mission-control-read-layer.js";

// With several people registered, anything that needs a person without naming one goes to the default person, never
// to whoever's fragment sorts first; with none chosen, it says so. One person stays the default without any choice.

const person = (home: string, entityId: string) => expect(addHumanFragment({
  entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
  connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: `vault://slack/${entityId}`, role: "primary", handle: `U${entityId.toUpperCase()}` }],
  prefs: { deliveryClass: "B" },
}, home)).toMatchObject({ ok: true });

describe("the default person, for escalations and Mission Control's my-queue", () => {
  let home: string;
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "default-consumers-"));
    vi.stubEnv("OPENRIG_HOME", home);
    db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => { vi.unstubAllEnvs(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const escalate = async () => {
    const sentTo: string[] = [];
    const engine = makeOperatorDeliveryEngine({ home, queueRepo: repo,
      dispatch: (_op, ref, _payload, opts) => { sentTo.push(ref); return { ok: true, decisionId: opts?.decisionId ?? "d" }; } });
    const row = await repo.create({ sourceSession: "sender@fixture", destinationSession: "worker@fixture", body: "stuck work", summary: "stuck", nudge: false });
    const result = await engine.dispatchEscalation(row as never, "blocked");
    return { result, sentTo };
  };
  const myQueueDefault = () =>
    new MissionControlReadLayer({ queueRepo: repo, viewProjector: {}, fleetCliCapability: {} } as never).getDefaultOperatorSession();

  it("one person: the escalation and my-queue go to them, with nothing chosen", async () => {
    person(home, "mike");
    expect((await escalate()).sentTo).toEqual(["mike@external"]);
    expect(myQueueDefault()).toBe("mike@external");
  });

  it("several people and none chosen: the escalation is undeliverable and says why; my-queue has no default", async () => {
    person(home, "mike"); person(home, "sarah");
    const { result, sentTo } = await escalate();
    expect(result).toMatchObject({ decision: "undeliverable:no-default-person", dispatched: false });
    expect(sentTo).toEqual([]);
    expect(myQueueDefault()).toBe("");
  });

  it("several people with a default: both go to the default, not the first by id", async () => {
    person(home, "mike"); person(home, "sarah");
    expect(setDefaultPerson("sarah", home).ok).toBe(true);
    expect((await escalate()).sentTo).toEqual(["sarah@external"]);
    expect(myQueueDefault()).toBe("sarah@external");
  });
});
