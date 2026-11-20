import { delegatedPostureFixture } from "./helpers/delegated-posture.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { HealthPolicyStore } from "../src/domain/health-policy.js";
import { PassiveCeremonySource } from "../src/domain/health-passive-ceremony.js";
import { HealthProjectionService } from "../src/domain/health-detectors.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));

const PARK = "continuation: resume once the decision is made";

/** Parks through the real writer, fires the real park wake, then writes `ack`; returns the counted ids and the ack's id. */
async function afterRealWake(ack: Record<string, unknown>, legacyPark = false, firstPark: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "real-park-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "project.yaml"), "kind: project\nmetadata: {id: fixture}\n");
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const queue = new QueueRepository(db, new EventBus(db));
  await queue.create({ qitemId: "root", sourceSession: "builder@rig", destinationSession: "owner@rig", body: "Build product", tags: ["mission:fixture"], nudge: false });
  for (let i = 0; i < 18; i++) queue.update({ qitemId: "root", actorSession: "builder@rig", transitionNote: `progress ${i}` });
  queue.update({ qitemId: "root", actorSession: "owner@rig", state: "blocked", blockedOn: "external:first", transitionNote: PARK, wakeAfterSeconds: 60, ...firstPark });
  // A park written before transitions recorded their blocker has no target.
  if (legacyPark) db.prepare("UPDATE queue_transitions SET closure_target = NULL WHERE qitem_id = 'root' AND state = 'blocked'").run();
  const timer = db.prepare("SELECT wake_ref FROM queue_transition_wakes WHERE qitem_id = 'root' AND phase = 'armed' ORDER BY transition_id DESC LIMIT 1").get() as { wake_ref: string };
  queue.recordWatchdogWakeAttempt(timer.wake_ref, "verified");
  queue.update({ qitemId: "root", actorSession: "owner@rig", transitionNote: PARK, ...ack });
  const acknowledged = queue.listTransitions("root").at(-1)!;
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const now = () => new Date(Date.now() + 1000).toISOString();
  const projection = new HealthProjectionService(new PassiveCeremonySource(workspace, queue, policy, now), () => policy.read(), delegatedPostureFixture);
  const listed = projection.list();
  const unavailable = listed.coverage?.find((c) => c.status === "unavailable");
  if (unavailable) throw new Error(`ceremony source unavailable: ${unavailable.reason}`);
  return { ids: listed.records[0]?.ceremony?.transitionIds ?? [], acknowledged };
}

const SAME_BLOCKER_ACKS: Array<[string, Record<string, unknown>]> = [
  ["a re-park on the same blocker", { state: "blocked", blockedOn: "external:first", wakeAfterSeconds: 60 }],
  ["a note-only acknowledgement", {}],
  ["a same-state note", { state: "blocked" }],
];

for (const [name, ack] of SAME_BLOCKER_ACKS) {
  it(`${name} after a real park and wake is excluded`, async () => {
    const { ids, acknowledged } = await afterRealWake(ack);
    expect(ids).toHaveLength(20);
    expect(ids).not.toContain(acknowledged.transitionId);
  });
}

it("a re-park on a different blocker after a real wake counts", async () => {
  const { ids, acknowledged } = await afterRealWake({ state: "blocked", blockedOn: "external:second", wakeAfterSeconds: 60 });
  expect(ids).toHaveLength(21);
  expect(ids).toContain(acknowledged.transitionId);
});

it("a park-record re-park on a different blocker with a stale closure target counts", async () => {
  const { ids, acknowledged } = await afterRealWake({
    state: "blocked", blockedOn: "external:second", closureReason: "blocked_on", closureTarget: "external:first", wakeAfterSeconds: 60,
  });
  expect(acknowledged.closureTarget).toBe("external:second");
  expect(ids).toHaveLength(21);
  expect(ids).toContain(acknowledged.transitionId);
});

it("a park-record re-park on the same blocker is excluded", async () => {
  const { ids, acknowledged } = await afterRealWake({
    state: "blocked", blockedOn: "external:first", closureReason: "blocked_on", closureTarget: "external:first", wakeAfterSeconds: 60,
  });
  expect(ids).toHaveLength(20);
  expect(ids).not.toContain(acknowledged.transitionId);
});

it("a park-record whose closure target disagrees with its blocker logs the blocker, so a matching re-park is excluded", async () => {
  const inconsistent = { closureReason: "blocked_on", closureTarget: "external:stale" };
  const { ids, acknowledged } = await afterRealWake(
    { state: "blocked", blockedOn: "external:first", wakeAfterSeconds: 60, ...inconsistent }, false, inconsistent,
  );
  expect(acknowledged.closureTarget).toBe("external:first");
  expect(ids).toHaveLength(20);
  expect(ids).not.toContain(acknowledged.transitionId);
});

const UNKNOWN_FIRST = { blockedOn: undefined, closureReason: "blocked_on", closureTarget: "external:first" };

it("a park whose blocker was unknown, re-parked on a known blocker, counts", async () => {
  const { ids, acknowledged } = await afterRealWake({ state: "blocked", blockedOn: "external:first", wakeAfterSeconds: 60 }, false, UNKNOWN_FIRST);
  expect(acknowledged.closureTarget).toBe("external:first");
  expect(ids).toHaveLength(21);
  expect(ids).toContain(acknowledged.transitionId);
});

it("a park whose blocker stays unknown counts", async () => {
  const { ids, acknowledged } = await afterRealWake(
    { state: "blocked", blockedOn: undefined, closureReason: "blocked_on", closureTarget: "external:first", wakeAfterSeconds: 60 }, false, UNKNOWN_FIRST,
  );
  expect(acknowledged.closureTarget).toBeNull();
  expect(ids).toHaveLength(21);
});

it("a park without a recorded blocker is never matched as the same blocker", async () => {
  const { ids, acknowledged } = await afterRealWake({ state: "blocked", blockedOn: "external:first", wakeAfterSeconds: 60 }, true);
  expect(ids).toHaveLength(21);
  expect(ids).toContain(acknowledged.transitionId);
});

for (const [name, ack] of [
  ["a changed continuation", { transitionNote: "continuation: a new plan" }],
  ["a different actor", { actorSession: "peer@rig" }],
  ["a substantive note", { transitionNote: "migration verified; waiting on sign-off" }],
] as const) {
  it(`${name} after a real wake counts`, async () => {
    const { ids, acknowledged } = await afterRealWake(ack);
    expect(ids).toHaveLength(21);
    expect(ids).toContain(acknowledged.transitionId);
  });
}
