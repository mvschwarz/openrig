// #2006's registered-person resolve repair, composed with main's typed gates.
// Real route + SQLite + registry in a disposable home; no daemon or agent starts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { addHumanFragment } from "../src/domain/gateway/human-registry.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";

describe("Steering resolves a registered person's park without changing its owner", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let log: MissionControlActionLog;
  let app: Hono;
  let home: string;
  let nudges: Array<{ session: string; text: string }>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "parked-person-"));
    vi.stubEnv("OPENRIG_HOME", home);
    for (const entityId of ["fixture-person", "other-person"]) {
      expect(addHumanFragment({ entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
        connectorBindings: [{ kind: "slack", connectorRef: "fixture", secretsRef: `fixture:${entityId}`, role: "primary", handle: `U${entityId}` }],
        prefs: { deliveryClass: "D" },
      }, home)).toMatchObject({ ok: true });
    }
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    nudges = [];
    repo = new QueueRepository(db, bus, { validateRig: () => true, transport: {
      send: async (session, text) => { nudges.push({ session, text }); return { ok: true, verified: true }; },
    } });
    log = new MissionControlActionLog(db);
    const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: log });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, repo as never);
      c.set("eventBus" as never, bus as never);
      c.set("missionControlWriteContract" as never, contract as never);
      await next();
    });
    app.route("/api/mission-control", missionControlRoutes());
  });
  afterEach(() => { db?.close(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  async function park(blockedOn = "fixture-person@external") {
    const row = await repo.create({ sourceSession: "old-creator@fixture", destinationSession: "current-owner@fixture",
      body: "Which layout?", summary: "Which layout?", evidenceRef: "fixture/layout", nudge: false });
    repo.claim({ qitemId: row.qitemId, destinationSession: "current-owner@fixture" });
    repo.update({ qitemId: row.qitemId, actorSession: "current-owner@fixture", state: "blocked", blockedOn });
    return row.qitemId;
  }
  async function act(qitemId: string, actor = "fixture-person@external", verb = "resolve", decision = "Use the wide layout", claimedActor = actor) {
    const response = await app.request("/api/mission-control/action", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": actor },
      body: JSON.stringify({ verb, qitemId, actorSession: claimedActor, decision }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("records the registered actor and decision, clears the blocker, and nudges the current owner once across a lost-response retry", async () => {
    const id = await park();
    const sibling = await park("other-person@external");
    const siblingBefore = repo.getById(sibling);
    expect((await act(id)).status).toBe(200);
    expect(repo.getById(id)).toMatchObject({ state: "in-progress", blockedOn: null,
      destinationSession: "current-owner@fixture", sourceSession: "old-creator@fixture", closureReason: null });
    const transition = repo.transitionLog.listForQitem(id).find((t) => t.state === "in-progress" && t.transitionNote?.includes("Use the wide layout"))!;
    expect(transition).toMatchObject({ actorSession: "fixture-person@external", transitionNote: "Use the wide layout",
      ownerNotificationKind: "human-decision-resolved" });
    expect(log.listForQitem(id)).toMatchObject([{ actionVerb: "resolve", actorSession: "fixture-person@external",
      reason: "Use the wide layout", identityProvenance: "transport:v1" }]);
    const history = repo.transitionLog.listForQitem(id);
    expect(await act(id)).toMatchObject({ status: 409, body: { error: "qitem_not_leg1_parked" } });
    expect(repo.transitionLog.listForQitem(id)).toEqual(history);
    expect(log.listForQitem(id)).toHaveLength(1);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({ session: "current-owner@fixture" });
    expect(nudges[0].text).toContain("Use the wide layout");
    expect(repo.getById(sibling)).toEqual(siblingBefore);
  });

  it("refuses a different registered person before any transition, audit or nudge, even if the body claims the asked person", async () => {
    const id = await park();
    const before = repo.getById(id);
    const history = repo.transitionLog.listForQitem(id);
    expect(await act(id, "other-person@external", "resolve", "No", "fixture-person@external"))
      .toMatchObject({ status: 400, body: { error: "answer_not_recorded", asked: "fixture-person@external" } });
    expect(repo.getById(id)).toEqual(before);
    expect(repo.transitionLog.listForQitem(id)).toEqual(history);
    expect(log.listForQitem(id)).toHaveLength(0);
    expect(nudges).toHaveLength(0);
  });

  it.each(["human@host", "human-review@kernel"])("keeps the legacy park %s settleable by an agent", async (blockedOn) => {
    const id = await park(blockedOn);
    expect((await act(id, "orch@fixture")).status).toBe(200);
    expect(repo.getById(id)).toMatchObject({ state: "in-progress", blockedOn: null });
  });

  it.each(["external:qa-pass", "fold:review-complete", "auth:access-granted"])("keeps typed gate %s as evidence, not a person answer", async (blockedOn) => {
    const id = await park(blockedOn);
    expect((await act(id, "orch@fixture")).status).toBe(200);
    expect(repo.getById(id)).toMatchObject({ state: "in-progress", blockedOn: null });
    const transition = repo.transitionLog.listForQitem(id).find((t) => t.state === "in-progress" && t.transitionNote?.includes("Use the wide layout"))!;
    expect(transition.transitionNote).toBe(`Blocker ${blockedOn} resolved: Use the wide layout`);
    expect(transition.ownerNotificationKind).not.toBe("human-decision-resolved");
  });

  it("keeps direct answers repeat-safe and addressed to the asker", async () => {
    const ask = await repo.create({ sourceSession: "asker@fixture", destinationSession: "fixture-person@external",
      body: "Ship?", summary: "Ship?", humanIntent: "decision", evidenceRef: "fixture/ship", nudge: false });
    expect(await act(ask.qitemId, "other-person@external", "answer")).toMatchObject({ status: 400 });
    const first = await act(ask.qitemId, "fixture-person@external", "answer", "Ship it");
    expect(first.status).toBe(200);
    const replay = await act(ask.qitemId, "fixture-person@external", "answer", "Different words");
    expect(replay.status).toBe(200);
    expect(replay.body.createdQitemId).toBe(first.body.createdQitemId);
    expect(repo.getById(first.body.createdQitemId as string)).toMatchObject({ sourceSession: "fixture-person@external", destinationSession: "asker@fixture" });
    expect(repo.getById(ask.qitemId)?.state).toBe("done");
    expect(nudges).toHaveLength(1);
  });
});
