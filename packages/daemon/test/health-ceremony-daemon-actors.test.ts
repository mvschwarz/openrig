import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { HealthPolicyStore } from "../src/domain/health-policy.js";
import { PassiveCeremonySource } from "../src/domain/health-passive-ceremony.js";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
import { delegatedPostureFixture } from "./helpers/delegated-posture.js";

// Follow-up to #2762/#2889: `daemon@kernel` and every `system:*` actor are the same class of daemon bookkeeping as
// `*@system`, so process.ceremony-amplification leaves them out of the count, the basis and the reported ids.
// The families are read-only captures of a live daemon (fixtures/health-ceremony-daemon-actors/family-*.json).
// The contract under test:
//   - a transition whose actor is exactly `daemon@kernel`, or starts with `system:`, is not a coordination transition,
//     whatever its note says;
//   - other kernel seats (`human@kernel`, `advisor-lead@kernel`) and seats that merely look alike still count;
//   - the #2889 exclusions (`*@system`, daemon note prefixes) and the candidate threshold are unchanged.
// Handoff notes (`handed off to`, `handoff from`) and the `created` the compaction notice writes under the seat are left
// open: this file neither counts nor forbids them.

type FixtureTransition = { transitionId: number; qitemId: string; ts: string; state: string; actorSession: string; transitionNote: string | null; identityProvenance: string | null };
type Family = {
  family: string; lineageId: string; now: string; observationWindowSeconds: number;
  members: Array<{ qitemId: string; handedOffFrom: string | null; sourceSession: string; destinationSession: string; tags: string[] }>;
  transitions: FixtureTransition[];
};
type Expected = { seat: number[]; daemon: number[]; open?: number[] };

const load = (name: string): Family =>
  JSON.parse(readFileSync(new URL(`./fixtures/health-ceremony-daemon-actors/${name}.json`, import.meta.url), "utf8")) as Family;

// Per captured family: what a seat decided (must count), what the daemon wrote as daemon@kernel or system:* (must not),
// and what this contract leaves open. Everything else in the capture is a #2889 exclusion (must not count either).
const EXPECTED: Record<string, Expected> = {
  fallback: {
    seat: [179738, 180992, 181141, 182507, 183598, 184736, 184774, 184937, 185898, 187008, 187571, 187893, 187923],
    daemon: [180991],
    open: [184760, 184761, 187880, 187881, 187913, 187914],
  },
  kernel: { seat: [], daemon: [129426, 129501] },
  mixed: { seat: [177214], daemon: [176433, 177190] },
  compaction: { seat: [54813, 54814], daemon: [54774], open: [54758, 54804, 54805] },
  human: { seat: [38763, 38775, 38776, 38858, 41895], daemon: [] },
  advisor: { seat: [72302, 85090], daemon: [] },
};

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((f) => f()); });

async function setup(family: Family, ceremonyTransitions?: number) {
  const home = mkdtempSync(join(tmpdir(), "ceremony-daemon-actors-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "project.yaml"), "kind: project\nmetadata: {id: project}\n");
  writeFileSync(join(workspace, "SPEC.md"), "# Product intent\nCaptured coordination families.");
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  for (const m of family.members) {
    await queue.create({ qitemId: m.qitemId, sourceSession: m.sourceSession, destinationSession: m.destinationSession, body: "captured family member", tags: m.tags, nudge: false });
    db.prepare("DELETE FROM queue_transitions WHERE qitem_id = ?").run(m.qitemId);
    db.prepare("UPDATE queue_items SET handed_off_from = ? WHERE qitem_id = ?").run(m.handedOffFrom, m.qitemId);
  }
  const insert = db.prepare("INSERT INTO queue_transitions(transition_id,qitem_id,ts,state,actor_session,transition_note,identity_provenance) VALUES(?,?,?,?,?,?,?)");
  for (const t of family.transitions) insert.run(t.transitionId, t.qitemId, t.ts, t.state, t.actorSession, t.transitionNote, t.identityProvenance);
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const p = policy.read().policy;
  policy.apply({ ...p, observationWindowSeconds: family.observationWindowSeconds,
    thresholds: { ...p.thresholds, ...(ceremonyTransitions ? { ceremonyTransitions } : {}) },
    diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "operator@rig");
  const source = new PassiveCeremonySource(workspace, queue, policy, () => family.now);
  const projection = new HealthProjectionService(source, () => policy.read(), delegatedPostureFixture);
  const observation = () => source.read().filter((o) => o.lineageId === family.lineageId);
  const candidates = () => projection.list().records.filter((r) => r.detector === "process.ceremony-amplification" && r.ceremony?.lineageId === family.lineageId);
  return { db, queue, observation, candidates };
}

/** The reported ids hold every seat decision, no daemon or #2889 exclusion, and the count is their length. */
function expectSeatDecided(o: ReturnType<Awaited<ReturnType<typeof setup>>["observation"]>[number] | undefined, e: Expected) {
  const ids = o?.ceremony?.transitionIds ?? [];
  expect(ids).toEqual(expect.arrayContaining(e.seat));
  expect(ids.filter((id) => !e.seat.includes(id) && !(e.open ?? []).includes(id))).toEqual([]);
  expect(e.daemon.filter((id) => ids.includes(id))).toEqual([]);
  expect(o?.coordinationTransitions).toBe(ids.length);
}

const at = (base: string, i: number) => new Date(Date.parse(base) + i * 1000).toISOString();

/** The captured `mixed` family (daemon@kernel creates, system:queue-fallback reroutes, the seat closes) plus later steps. */
function extendMixed(name: string, steps: Array<Pick<FixtureTransition, "actorSession" | "transitionNote" | "identityProvenance">>, firstId: number) {
  const mixed = load("family-mixed");
  const added = steps.map((s, i) => ({ ...s, transitionId: firstId + i, qitemId: mixed.lineageId, ts: at("2026-11-11T02:17:00.000Z", i), state: "blocked" }));
  return { family: { ...mixed, family: name, now: "2026-11-11T02:30:00.000Z", transitions: [...mixed.transitions, ...added] }, added };
}

/** The mixed family plus the seat's own later steps: a real coordination chain that must stay visible. */
function regressionChain(seatSteps: number): { family: Family; expected: number[] } {
  // Synthetic (not in the capture), marked: ordinary seat decisions, kernel seats among them, and notes that only quote
  // the daemon's actor names.
  const steps = [
    { actorSession: "qa@team", transitionNote: "reopened: the fallback seat needs the original evidence", identityProvenance: "transport:v1" },
    { actorSession: "human@kernel", transitionNote: "operator decision: keep the escalation open", identityProvenance: "claimed:v1" },
    { actorSession: "coordinator@team", transitionNote: "checked what daemon@kernel created before acting", identityProvenance: "transport:v1" },
    { actorSession: "coordinator@team", transitionNote: "rerouted by hand after system:queue-fallback picked the wrong slot", identityProvenance: "transport:v1" },
    { actorSession: "qa@team", transitionNote: null, identityProvenance: "transport:v1" },
    { actorSession: "operator@kernel", transitionNote: "operator acknowledged the escalation", identityProvenance: "transport:v1" },
    { actorSession: "qa@team", transitionNote: "parked on qitem-review-2", identityProvenance: "transport:v1" },
    { actorSession: "coordinator@team", transitionNote: "owner decision recorded", identityProvenance: null },
    { actorSession: "qa@team", transitionNote: "evidence attached", identityProvenance: "transport:v1" },
    { actorSession: "builder@team", transitionNote: "fix pushed for review", identityProvenance: "transport:v1" },
    { actorSession: "qa@team", transitionNote: "proof rerun on the new head", identityProvenance: "transport:v1" },
    { actorSession: "coordinator@team", transitionNote: "routed the fix back to the builder", identityProvenance: "transport:v1" },
    { actorSession: "builder@team", transitionNote: "second fix pushed", identityProvenance: "transport:v1" },
    { actorSession: "qa@team", transitionNote: "proof green", identityProvenance: "transport:v1" },
    { actorSession: "reviewer@team", transitionNote: "review returned with one finding", identityProvenance: "transport:v1" },
    { actorSession: "coordinator@team", transitionNote: "finding accepted, back to the builder", identityProvenance: "transport:v1" },
    { actorSession: "builder@team", transitionNote: "finding fixed", identityProvenance: "transport:v1" },
    { actorSession: "reviewer@team", transitionNote: "approved", identityProvenance: "transport:v1" },
    { actorSession: "coordinator@team", transitionNote: "owner decision: release window kept", identityProvenance: "transport:v1" },
  ].slice(0, seatSteps);
  const { family, added } = extendMixed("regression", steps, 177300);
  return { family, expected: [...EXPECTED.mixed!.seat, ...added.map((t) => t.transitionId)] };
}

describe("ceremony-amplification ignores daemon@kernel and system:* actors (#2889 follow-up)", () => {
  it("family fallback: the fixture is the whole captured family inside the observation window", async () => {
    const family = load("family-fallback");
    const t = await setup(family);
    const start = new Date(Date.parse(family.now) - family.observationWindowSeconds * 1000).toISOString();
    const ids = family.members.flatMap((m) => t.queue.transitionLog.listForQitemWindow(m.qitemId, start, family.now, 10001).map((x) => x.transitionId));
    expect(ids.sort((x, y) => x - y)).toEqual(family.transitions.map((x) => x.transitionId));
    // 25 captured: 5 watchdog@system wakes (#2889), 1 system:queue-fallback routing, 19 under seat actors.
    expect(family.transitions.filter((x) => x.actorSession === "system:queue-fallback").map((x) => x.transitionId)).toEqual(EXPECTED.fallback!.daemon);
    expect(family.transitions.filter((x) => !x.actorSession.endsWith("@system") && !x.actorSession.startsWith("system:"))).toHaveLength(19);
  });

  it("family fallback: the queue fallback routing no longer lifts the captured family to the threshold", async () => {
    const t = await setup(load("family-fallback"));
    expect(t.observation()).toEqual([]);
    expect(t.candidates()).toEqual([]);
  });

  it("family fallback: only seat-decided transitions are counted", async () => {
    const t = await setup(load("family-fallback"), 1);
    const [o, ...rest] = t.observation();
    expect(rest).toEqual([]);
    expectSeatDecided(o, EXPECTED.fallback!);
  });

  it("family kernel: a family only daemon@kernel and the wake ladder touched is never a candidate", async () => {
    const t = await setup(load("family-kernel"), 1);
    expect(t.observation()).toEqual([]);
    expect(t.candidates()).toEqual([]);
  });

  it("family mixed: daemon@kernel creation and fallback routing do not count, the seat's closure does", async () => {
    const t = await setup(load("family-mixed"), 1);
    const [o, ...rest] = t.observation();
    expect(rest).toEqual([]);
    expect(o?.ceremony?.transitionIds).toEqual(EXPECTED.mixed!.seat);
    expect(o?.coordinationTransitions).toBe(1);
  });

  it("family compaction: the compaction restore notice does not count", async () => {
    const t = await setup(load("family-compaction"), 1);
    const [o, ...rest] = t.observation();
    expect(rest).toEqual([]);
    expectSeatDecided(o, EXPECTED.compaction!);
  });

  for (const name of ["human", "advisor"]) {
    it(`family ${name}: a kernel seat other than daemon@kernel still counts`, async () => {
      const t = await setup(load(`family-${name}`), 1);
      const [o, ...rest] = t.observation();
      expect(rest).toEqual([]);
      expect(o?.ceremony?.transitionIds).toEqual(EXPECTED[name]!.seat);
      expect(o?.coordinationTransitions).toBe(EXPECTED[name]!.seat.length);
    });
  }

  it("every system:* actor and only the exact daemon@kernel are excluded; seats that merely look alike still count", async () => {
    const neutral = "notice delivered to the owner";
    // Synthetic (not in the capture), marked: system:* names the base writes or tests with (system:watchdog is the actor
    // of health-correction.test.ts), a system:* name nothing writes yet (the rule is the prefix, not a list), daemon@kernel
    // with a neutral note, and seats whose names only resemble them.
    const { family, added } = extendMixed("look-alikes", [
      { actorSession: "system:watchdog", transitionNote: neutral, identityProvenance: null },
      { actorSession: "system:health", transitionNote: "created", identityProvenance: null },
      { actorSession: "system:compaction", transitionNote: neutral, identityProvenance: null },
      { actorSession: "system:queue-fallback", transitionNote: neutral, identityProvenance: null },
      { actorSession: "system:future-subsystem", transitionNote: neutral, identityProvenance: null },
      { actorSession: "daemon@kernel", transitionNote: neutral, identityProvenance: null },
      { actorSession: "system-admin@team", transitionNote: "owner decision recorded", identityProvenance: "transport:v1" },
      { actorSession: "ops-1@system-tools", transitionNote: "routed to the next reviewer", identityProvenance: "transport:v1" },
      { actorSession: "daemon@team", transitionNote: "owner decision recorded", identityProvenance: "transport:v1" },
      { actorSession: "daemon-x@team", transitionNote: null, identityProvenance: "transport:v1" },
      { actorSession: "operator@kernel", transitionNote: "operator acknowledged the escalation", identityProvenance: "transport:v1" },
      { actorSession: "build-dev-1@kernel-tools", transitionNote: null, identityProvenance: "transport:v1" },
    ], 177400);
    const t = await setup(family, 1);
    const [o, ...rest] = t.observation();
    expect(rest).toEqual([]);
    const expected = [...EXPECTED.mixed!.seat, ...added.slice(6).map((x) => x.transitionId)];
    expect(o?.ceremony?.transitionIds).toEqual(expected);
    expect(o?.coordinationTransitions).toBe(expected.length);
  });

  it("the health-correction shape: system:watchdog bookkeeping does not lift an owner family over the threshold", async () => {
    // Synthetic, marked: the family health-correction.test.ts built before this change (one `created`, then 23 in-progress
    // transitions alternating owner@rig and system:watchdog). Only the owner's 13 count.
    const now = "2026-11-11T02:30:00.000Z";
    const transitions: FixtureTransition[] = [{ transitionId: 1, qitemId: "plan", ts: now, state: "pending", actorSession: "owner@rig", transitionNote: "created", identityProvenance: null }];
    for (let i = 0; i < 23; i++) transitions.push({ transitionId: i + 2, qitemId: "plan", ts: now, state: "in-progress", actorSession: i % 2 ? "system:watchdog" : "owner@rig", transitionNote: null, identityProvenance: null });
    const family: Family = { family: "plan", lineageId: "plan", now, observationWindowSeconds: 3600,
      members: [{ qitemId: "plan", handedOffFrom: null, sourceSession: "owner@rig", destinationSession: "owner@rig", tags: ["mission:family-plan"] }], transitions };
    const below = await setup(family);
    expect(below.observation()).toEqual([]);
    expect(below.candidates()).toEqual([]);
    const counted = await setup(family, 1);
    const owner = transitions.filter((x) => x.actorSession === "owner@rig").map((x) => x.transitionId);
    expect(owner).toHaveLength(13);
    expect(counted.observation()[0]?.ceremony?.transitionIds).toEqual(owner);
  });

  it("a real coordination chain at the threshold is still a candidate", async () => {
    const { family } = regressionChain(19);
    const t = await setup(family);
    expect(t.observation()).toHaveLength(1);
    expect(t.candidates()).toHaveLength(1);
  });

  it("a real coordination chain counts every seat-decided transition, including notes that only quote daemon actors", async () => {
    const { family, expected } = regressionChain(19);
    expect(expected).toHaveLength(20);
    const t = await setup(family);
    const [o] = t.observation();
    expect(o?.ceremony?.transitionIds).toEqual(expected);
    expect(o?.coordinationTransitions).toBe(20);
    expect(t.candidates()[0]?.ceremony?.transitionIds).toEqual(expected);
  });

  it("one seat decision below the threshold is not a candidate", async () => {
    const { family, expected } = regressionChain(18);
    expect(expected).toHaveLength(19);
    const t = await setup(family);
    expect(t.observation()).toEqual([]);
    expect(t.candidates()).toEqual([]);
  });
});
