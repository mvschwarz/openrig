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
const WAKE = "park wake fired: watchdog job-1; delivery=delivered; awaiting owner consumption";
const BLOCKER = "human@kernel";
type Step = { state: string; actor: string; note?: string; target?: string | null };
const park = (note = PARK, target: string | null = BLOCKER): Step => ({ state: "blocked", actor: "owner@rig", note, target });
const wake: Step = { state: "blocked", actor: "watchdog@system", note: WAKE, target: BLOCKER };

/** One family whose in-window history is `substantive` seat transitions followed by `steps`; returns the counted transition ids. */
async function counted(substantive: number, steps: Step[]): Promise<number[] | null> {
  const home = mkdtempSync(join(tmpdir(), "wake-ack-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "project.yaml"), "kind: project\nmetadata: {id: project}\n");
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const queue = new QueueRepository(db, new EventBus(db));
  const start = "2026-09-05T12:00:00.000Z";
  await queue.create({ qitemId: "root", sourceSession: "builder@rig", destinationSession: "owner@rig", body: "Build product", tags: ["mission:mission"], nudge: false });
  db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(start, "root");
  db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(start, "root");
  const insert = db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session,transition_note,closure_target) VALUES('root',?,?,?,?,?)");
  let at = 0;
  const add = (s: Step) => insert.run(new Date(Date.parse(start) + ++at * 1000).toISOString(), s.state, s.actor, s.note ?? null, s.target ?? null);
  for (let i = 1; i < substantive; i++) add({ state: "in-progress", actor: "builder@rig" });
  steps.forEach(add);
  const now = new Date(Date.parse(start) + (at + 1) * 1000).toISOString();
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const projection = new HealthProjectionService(new PassiveCeremonySource(workspace, queue, policy, () => now), () => policy.read(), delegatedPostureFixture);
  const listed = projection.list();
  const unavailable = listed.coverage?.find((c) => c.status === "unavailable");
  if (unavailable) throw new Error(`ceremony source unavailable: ${unavailable.reason}`);
  return listed.records[0]?.ceremony?.transitionIds ?? null;
}

const episodes = (n: number, ack: Step = park()) => Array.from({ length: n }, () => [wake, ack]).flat();

it("an unchanged wait does not count its wake acknowledgements: 19 plus three stays below the threshold", async () => {
  // 18 seat transitions plus the owner's park make 19 counted.
  expect(await counted(18, [park(), ...episodes(3)])).toBeNull();
});

it("excluded acknowledgements leave the other counted transitions intact; one more substantive transition qualifies", async () => {
  const ids = await counted(19, [park(), ...episodes(3)]);
  expect(ids).toHaveLength(20);
});

it("a substantive owner note during the same wait still counts", async () => {
  const progress = park("migration verified on staging; still waiting on the decision");
  expect(await counted(18, [park(), wake, park(), wake, park(), wake, progress])).toHaveLength(20);
});

it("an acknowledgement after the continuation changes still counts", async () => {
  expect(await counted(18, [park(), wake, park(), wake, park(), wake, park("continuation: resume after the revised decision")])).toHaveLength(20);
});

it("an acknowledgement after the blocker changes still counts", async () => {
  expect(await counted(18, [park(), wake, park(), wake, park(), wake, park(PARK, "operator@kernel")])).toHaveLength(20);
});

it("an acknowledgement after a state change still counts", async () => {
  const resumed: Step = { state: "in-progress", actor: "owner@rig" };
  expect(await counted(17, [park(), wake, park(), resumed, wake, park()])).toHaveLength(20);
});

it("a note-only acknowledgement with no wake before it still counts", async () => {
  expect(await counted(18, [park(), park(), park(), park()])).toHaveLength(22);
});

it("a different seat repeating the same continuation after a wake still counts", async () => {
  const peer: Step = { ...park(), actor: "peer@rig" };
  expect(await counted(18, [park(), wake, peer])).toHaveLength(20);
});

it("a different seat's park becomes the parking seat: its own later unchanged acknowledgement is excluded", async () => {
  const peer: Step = { ...park(), actor: "peer@rig" };
  // 18 substantive + owner park + peer's park (counts) = 20; the peer's acknowledgement after the next wake adds nothing.
  expect(await counted(18, [park(), wake, peer, wake, peer])).toHaveLength(20);
  // The owner's acknowledgement now follows the peer's park, so it counts.
  expect(await counted(18, [park(), wake, peer, wake, park()])).toHaveLength(21);
});

it("a park after the parked-owner episode closed is a new park, not an acknowledgement", async () => {
  const closed: Step = { state: "blocked", actor: "owner@rig", note: "parked-owner episode closed: wait ended", target: BLOCKER };
  expect(await counted(18, [park(), wake, park(), closed, park()])).toHaveLength(20);
});

it("a parked-owner wake note is a wake: the owner's unchanged acknowledgement is excluded", async () => {
  const reminder: Step = { state: "blocked", actor: "owner@rig", note: "parked-owner wake delivered: reminder sent", target: BLOCKER };
  expect(await counted(18, [park(), reminder, park()])).toBeNull();
});
