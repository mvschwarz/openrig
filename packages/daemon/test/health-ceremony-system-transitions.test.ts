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

// #2762: process.ceremony-amplification counted the daemon's own bookkeeping as coordination.
// Families A, B and C are read-only captures of three 2026-11-08 false positives on a live daemon
// (fixtures/health-ceremony-system-transitions/family-*.json). The contract under test:
//   - a transition whose actor is a system actor (`*@system`) is not a coordination transition;
//   - a daemon-generated note (`auto-unparked:`, `blocker custody moved `, `park wake `, `parked-owner `)
//     is not one either, even when it is recorded under a seat actor;
//   - every other transition still counts, and the candidate threshold is unchanged.

type FixtureTransition = { transitionId: number; qitemId: string; ts: string; state: string; actorSession: string; transitionNote: string | null; identityProvenance: string | null };
type Family = {
  family: string; lineageId: string; now: string; observationWindowSeconds: number; findingTransitionIds: number[];
  members: Array<{ qitemId: string; handedOffFrom: string | null; sourceSession: string; destinationSession: string; tags: string[] }>;
  transitions: FixtureTransition[];
};

const load = (name: string): Family =>
  JSON.parse(readFileSync(new URL(`./fixtures/health-ceremony-system-transitions/${name}.json`, import.meta.url), "utf8")) as Family;

// What the owner decided in each captured family: the captured window minus *@system actors and daemon notes.
const OWNER_DECIDED: Record<string, number[]> = {
  a: [100403, 100422, 100423, 100439, 101046, 101364, 102155, 102246, 102247, 102868, 102906],
  b: [102789, 102791, 102861, 104082, 105091, 105864],
  c: [107582, 107585, 108667, 110353, 111024, 111025, 111846, 111847, 111940, 111941],
};

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((f) => f()); });

async function setup(family: Family, ceremonyTransitions?: number) {
  const home = mkdtempSync(join(tmpdir(), "ceremony-system-"));
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

/** Family C plus the owner's own later steps: a real coordination chain that must stay visible. */
function regressionChain(ownerSteps: number): { family: Family; expected: number[] } {
  const c = load("family-c"); const root = c.lineageId;
  const extra: Array<Pick<FixtureTransition, "state" | "actorSession" | "transitionNote" | "identityProvenance">> = [
    { state: "in-progress", actorSession: "coordenacao-coord-2@fabrica", transitionNote: null, identityProvenance: "transport:v1" },
    { state: "blocked", actorSession: "coordenacao-coord-2@fabrica", transitionNote: "the row was auto-unparked: blocker qitem-x reached terminal state 'handed-off'; re-parking on the successor", identityProvenance: "transport:v1" },
    { state: "blocked", actorSession: "qualidade-revisor-3@fabrica", transitionNote: "review returned with two findings", identityProvenance: "transport:v1" },
    { state: "blocked", actorSession: "coordenacao-coord-2@fabrica", transitionNote: "routed the fix back to the builder", identityProvenance: null },
    { state: "in-progress", actorSession: "coordenacao-coord-2@fabrica", transitionNote: null, identityProvenance: "transport:v1" },
    { state: "blocked", actorSession: "build-dev-1@fabrica", transitionNote: "fix pushed for review", identityProvenance: "transport:v1" },
    { state: "blocked", actorSession: "coordenacao-coord-2@fabrica", transitionNote: "parked on qitem-review-2", identityProvenance: "transport:v1" },
    { state: "in-progress", actorSession: "coordenacao-coord-2@fabrica", transitionNote: null, identityProvenance: "transport:v1" },
    { state: "blocked", actorSession: "coordenacao-coord-2@fabrica", transitionNote: "second review requested after the watchdog@system wake", identityProvenance: "transport:v1" },
    { state: "blocked", actorSession: "coordenacao-coord-2@fabrica", transitionNote: "owner decision: keep the release window", identityProvenance: "transport:v1" },
  ].slice(0, ownerSteps);
  const added = extra.map((t, i) => ({ ...t, transitionId: 111950 + i, qitemId: root, ts: new Date(Date.parse("2026-11-08T16:47:54.000Z") + i * 1000).toISOString() }));
  return { family: { ...c, family: "regression", transitions: [...c.transitions, ...added] }, expected: [...OWNER_DECIDED.c!, ...added.map((t) => t.transitionId)] };
}

describe("ceremony-amplification ignores system actors and daemon bookkeeping (#2762)", () => {
  for (const name of ["a", "b", "c"]) {
    it(`family ${name.toUpperCase()}: the fixture is the captured window of the reported finding`, async () => {
      const family = load(`family-${name}`);
      const t = await setup(family);
      const start = new Date(Date.parse(family.now) - family.observationWindowSeconds * 1000).toISOString();
      const ids = family.members.flatMap((m) => t.queue.transitionLog.listForQitemWindow(m.qitemId, start, family.now, 10001).map((x) => x.transitionId));
      expect(ids.sort((x, y) => x - y)).toEqual(family.findingTransitionIds);
      expect(ids.length).toBeGreaterThanOrEqual(20);
    });

    it(`family ${name.toUpperCase()}: the captured false positive is no longer a candidate`, async () => {
      const t = await setup(load(`family-${name}`));
      expect(t.observation()).toEqual([]);
      expect(t.candidates()).toEqual([]);
    });

    it(`family ${name.toUpperCase()}: only owner-decided transitions are counted`, async () => {
      const t = await setup(load(`family-${name}`), 1);
      const [o, ...rest] = t.observation();
      expect(rest).toEqual([]);
      expect(o?.ceremony?.transitionIds).toEqual(OWNER_DECIDED[name]);
      expect(o?.coordinationTransitions).toBe(OWNER_DECIDED[name]!.length);
    });
  }

  it("a system actor never counts, whatever its note says", async () => {
    const a = load("family-a");
    const reworded = { ...a, transitions: a.transitions.map((t) => t.actorSession.endsWith("@system") ? { ...t, transitionNote: "notice delivered to the owner" } : t) };
    expect(reworded.transitions.filter((t) => t.transitionNote === "notice delivered to the owner").map((t) => t.actorSession).sort())
      .toEqual(["queue@system", "queue@system", "watchdog@system", "watchdog@system", "watchdog@system"]);
    const t = await setup(reworded, 1);
    expect(t.observation()[0]?.ceremony?.transitionIds).toEqual(OWNER_DECIDED.a);
  });

  it("daemon wake notes do not count even when recorded under a seat actor", async () => {
    const b = load("family-b");
    const seat = b.members[0]!.destinationSession;
    // Synthetic (not in the capture): the other wake outcomes the daemon writes, in their literal form.
    const key = `${seat}|0f1e2d3c4b5a6978#00000000-0000-4000-8000-000000002762`;
    const variants = [
      "park wake failed: watchdog 01M6XQA4EVAL0000000000FAIL; delivery=failed; occurrence remains owed; retry at 2026-11-08T10:31:00.000Z",
      "park wake retained: watchdog 01M6XQA4EVAL000000000RETAIN; not delivered; blocked work unchanged",
      `parked-owner wake delivery refused: ${key}; seat is not idle`,
      `parked-owner wake delivery failed: ${key} transport unavailable`,
    ].map((note, i) => ({ transitionId: 105870 + i, qitemId: b.lineageId, ts: new Date(Date.parse("2026-11-08T10:26:40.000Z") + i * 1000).toISOString(),
      state: "blocked", actorSession: seat, transitionNote: note, identityProvenance: null }));
    const moved = { ...b, transitions: [...b.transitions.map((t) => t.actorSession.endsWith("@system") ? { ...t, actorSession: seat } : t), ...variants] };
    expect(moved.transitions.filter((t) => t.actorSession === seat && /^(park wake |parked-owner )/.test(t.transitionNote ?? ""))).toHaveLength(18);
    const t = await setup(moved, 1);
    expect(t.observation()[0]?.ceremony?.transitionIds).toEqual(OWNER_DECIDED.b);
  });

  it("any *@system actor is excluded, a seat whose name merely contains system is not, across handoff members", async () => {
    const c = load("family-c"); const root = c.lineageId; const successor = "qitem-20261108164800-eval2762";
    // Synthetic (not in the capture): other system actors the daemon writes as, seats with "system" in their name,
    // and a handed-off successor member of the same family.
    const at = (i: number) => new Date(Date.parse("2026-11-08T16:47:56.000Z") + i * 1000).toISOString();
    const step = (i: number, qitemId: string, actorSession: string, transitionNote: string | null, identityProvenance: string | null) =>
      ({ transitionId: 111970 + i, qitemId, ts: at(i), state: "blocked", actorSession, transitionNote, identityProvenance });
    const added = [
      step(0, root, "stuck-sweep@system", "stuck-sweep resolved: unclaimed-backlog on coordenacao-coord-2@fabrica: every row it stood for is claimed, parked, closed or has its own finding", null),
      step(1, root, "daemon@system", "closure-overdue", null),
      step(2, root, "wake-ladder@system", "notice delivered to the owner", null),
      step(3, root, "claim@system", "notice delivered to the owner", null),
      step(4, root, "system-admin@fabrica", "owner decision recorded", "transport:v1"),
      step(5, root, "build-dev-1@subsystem", null, "transport:v1"),
      step(6, root, "ops-1@system-tools", "routed to the next reviewer", "transport:v1"),
      step(7, successor, "queue@system", "blocker qitem-20261108164800-eval2762 wake attempted; delivery=delivered-ack-pending", null),
      step(8, successor, "coordenacao-coord-2@fabrica", "owner decision on the successor", "transport:v1"),
    ];
    const family: Family = { ...c, family: "system-actors",
      members: [...c.members, { ...c.members[0]!, qitemId: successor, handedOffFrom: root }],
      transitions: [...c.transitions, ...added] };
    const t = await setup(family, 1);
    const [o, ...rest] = t.observation();
    expect(rest).toEqual([]);
    const expected = [...OWNER_DECIDED.c!, 111974, 111975, 111976, 111978];
    expect(o?.ceremony?.transitionIds).toEqual(expected);
    expect(o?.coordinationTransitions).toBe(expected.length);
  });

  it("a real coordination chain above the threshold is still a candidate", async () => {
    const { family } = regressionChain(10);
    const t = await setup(family);
    expect(t.observation()).toHaveLength(1);
    expect(t.candidates()).toHaveLength(1);
  });

  it("a real coordination chain counts every owner-decided transition, including notes that only quote daemon text", async () => {
    const { family, expected } = regressionChain(10);
    expect(expected).toHaveLength(20);
    const t = await setup(family);
    const [o] = t.observation();
    expect(o?.ceremony?.transitionIds).toEqual(expected);
    expect(o?.coordinationTransitions).toBe(20);
    expect(t.candidates()[0]?.ceremony?.transitionIds).toEqual(expected);
  });

  it("one owner decision below the threshold is not a candidate", async () => {
    const { family, expected } = regressionChain(9);
    expect(expected).toHaveLength(19);
    const t = await setup(family);
    expect(t.observation()).toEqual([]);
    expect(t.candidates()).toEqual([]);
  });
});
