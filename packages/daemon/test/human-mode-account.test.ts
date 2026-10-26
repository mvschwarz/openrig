// The facts for a person's "back" account, read for one ended mode: how it ended, each effect, what was decided for them,
// what's waiting (valid, held and stale apart, as slice 08's release tells them), and what no record can say. Through the
// real gateway and queue routes with a temp home (real person records) and the real SQLite schema.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { queueRoutes } from "../src/routes/queue.js";
import { addHumanFragment, loadHumanRegistry } from "../src/domain/gateway/human-registry.js";
import { HumanQuietStore } from "../src/domain/gateway/human-quiet-windows.js";
import { formatQuietHoldNote, holdForQuiet } from "../src/domain/policies/quiet-release.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { NOT_TRACKED } from "../src/domain/gateway/human-mode-account.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "mode-account-")); homes.push(home);
  for (const id of ["alex", "sam"]) {
    expect(addHumanFragment({ entityId: id, class: "human", displayName: id, address: `${id}@external`, prefs: { deliveryClass: "B" },
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://fixture", role: "primary", handle: `U-${id.toUpperCase()}` }] }, home).ok).toBe(true);
  }
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => loadHumanRegistry(home) });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("db" as never, db as never); c.set("queueRepo" as never, repo as never); await next(); });
  app.route("/api/gateway", gatewayRoutes({ home }));
  app.route("/api/queue", queueRoutes());
  const call = async (method: string, path: string, body?: unknown, session = "operator@kernel") => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json", ...(session ? { "X-OpenRig-Session": session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const ask = (summary: string, extra: Record<string, unknown> = {}) => repo.create({ sourceSession: "designer@rig", destinationSession: "alex@external",
    summary, body: summary, humanIntent: "decision", nudge: false, ...extra } as never) as Promise<QueueItem>;
  const hold = (qitemId: string) => repo.update({ qitemId, actorSession: "daemon@kernel",
    transitionNote: formatQuietHoldNote({ windowId: "w-1", occurrence: "until", revision: 1, notificationKey: `${qitemId}:1` }) });
  const account = (entityId: string, applicationId: string) => call("GET", `/api/gateway/human/${entityId}/mode/applications/${applicationId}/account`);
  return { db, home, repo, call, ask, hold, account };
}

describe("the account's facts", () => {
  it("asleep, ended by \"I'm back\": the mode and its times, what ended and what stays, the decision made for them, and what's waiting apart", async () => {
    const f = fixture();
    await f.call("PUT", "/api/gateway/human/alex/modes/asleep", { availability: "away", decisionRoom: "design choices", exclusions: ["publishing"] });
    const app = (await f.call("POST", "/api/gateway/human/alex/modes/asleep/apply", { until: "2099-01-01T07:00:00Z" })).body.application;
    // Overnight: a design choice decided for them; a publish waits; one held ask closed in the meantime; quiet extended by hand.
    const design = await f.ask("Which layout?", { humanQuestions: [{ id: "design", question: "Which layout?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] });
    expect((await f.call("POST", `/api/queue/${design.qitemId}/delegated-decision`, { applicationId: app.applicationId,
      choices: [{ questionId: "design", chosen: "a" }], reason: "A was recommended", reversible: false }, "designer@rig")).status).toBe(200);
    const publish = await f.ask("Publish the release?");
    const heldThenClosed = await f.ask("Rename the repo?");
    await f.hold(heldThenClosed.qitemId);
    await f.repo.update({ qitemId: heldThenClosed.qitemId, actorSession: "designer@rig", state: "done", closureReason: "no-follow-on" } as never);
    const heldNow = await f.ask("Review the copy?");
    await f.hold(heldNow.qitemId);
    new HumanQuietStore(f.db).setUntil("alex", { until: new Date(Date.now() + 3_600_000), timezone: "UTC", setBy: "alex", now: new Date(), source: "manual" });
    await f.call("POST", "/api/gateway/human/alex/mode/end", {});

    const res = await f.account("alex", app.applicationId);
    expect(res.status).toBe(200);
    const a = res.body.account;
    expect(a.mode).toMatchObject({ modeName: "asleep", endReason: "back", scheduledEnd: "2099-01-01T07:00:00.000Z", endedAt: expect.any(String) });
    expect(a.effects).toEqual(expect.arrayContaining([expect.objectContaining({ consumer: "availability", state: "ended" }),
      expect.objectContaining({ consumer: "decision-room", state: "ended" })]));
    expect(a.now).toBeNull(); // at desk
    expect(a.decisions).toEqual([expect.objectContaining({ qitemId: design.qitemId, askedBy: "designer@rig",
      decision: expect.objectContaining({ reversible: false, reason: "A was recommended", choices: [expect.objectContaining({ chosen: "a" })] }) })]);
    const standing = Object.fromEntries((a.waiting as Array<Record<string, any>>).map((w) => [w.qitemId, [w.standing, w.reason]]));
    expect(standing).toEqual({
      [publish.qitemId]: ["valid", null],
      [heldNow.qitemId]: ["held", "quiet hours are still on"],
      [heldThenClosed.qitemId]: ["stale", "row-not-active"],
    });
    expect(a.notTracked).toEqual(NOT_TRACKED);
  });

  it("with nothing decided it says so; a mode still on is refused, and another person's application isn't found", async () => {
    const f = fixture();
    await f.call("PUT", "/api/gateway/human/sam/modes/asleep", { availability: "off" });
    const app = (await f.call("POST", "/api/gateway/human/sam/modes/asleep/apply", {})).body.application;
    expect(await f.account("sam", app.applicationId)).toMatchObject({ status: 409, body: { error: "still_on" } });
    await f.call("POST", "/api/gateway/human/sam/mode/end", {});
    expect((await f.account("sam", app.applicationId)).body.account).toMatchObject({ decisions: [], waiting: [], mode: { scheduledEnd: null } });
    expect((await f.account("alex", app.applicationId)).status).toBe(404);
  });

  it("only the person's own asks are waiting for them: not another person's held ask, nor a seat that shares their name", async () => {
    const f = fixture();
    await f.call("PUT", "/api/gateway/human/alex/modes/asleep", { availability: "away" });
    const app = (await f.call("POST", "/api/gateway/human/alex/modes/asleep/apply", {})).body.application;
    const theirs = await f.ask("Approve the copy?");
    await f.ask("Rebase your branch", { destinationSession: "alex@build-rig", humanIntent: undefined });
    const samsAsk = await f.ask("Sam's private review", { destinationSession: "sam@external" });
    holdForQuiet({ queueRepo: f.repo, jobsRepo: new WatchdogJobsRepository(f.db), qitemId: samsAsk.qitemId, entityId: "sam",
      hold: { windowId: "w-sam", occurrence: "until", revision: 1, notificationKey: `${samsAsk.qitemId}:1` } });
    await f.repo.update({ qitemId: samsAsk.qitemId, actorSession: "designer@rig", state: "done", closureReason: "no-follow-on" } as never);
    await f.call("POST", "/api/gateway/human/alex/mode/end", {});
    expect((await f.account("alex", app.applicationId)).body.account.waiting.map((w: { qitemId: string }) => w.qitemId)).toEqual([theirs.qitemId]);
  });

  it("an ask held for them that was re-parked on someone else shows none of its current text, and is never valid", async () => {
    for (const ending of ["disposed", "posted"] as const) {
      const f = fixture();
      for (const id of ["human-alex", "human-sam"]) {
        expect(addHumanFragment({ entityId: id, class: "human", displayName: id, address: `${id}@external`, prefs: { deliveryClass: "B" },
          connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://fixture", role: "primary", handle: `U-${id.toUpperCase()}` }] }, f.home).ok).toBe(true);
      }
      await f.call("PUT", "/api/gateway/human/human-alex/modes/asleep", { availability: "away" });
      const applied = await f.call("POST", "/api/gateway/human/human-alex/modes/asleep/apply", {});
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      const app = applied.body.application;
      const work = await f.repo.create({ sourceSession: "designer@rig", destinationSession: "designer@rig", summary: "Alex: approve the layout",
        body: "work", evidenceRef: "/proof/layout.md", nudge: false } as never) as QueueItem;
      await f.repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "human-alex@host", summary: "Alex: approve the layout" } as never);
      const key = `${work.qitemId}:1`;
      holdForQuiet({ queueRepo: f.repo, jobsRepo: new WatchdogJobsRepository(f.db), qitemId: work.qitemId, entityId: "human-alex",
        hold: { windowId: "w-alex", occurrence: "until", revision: 1, notificationKey: key } });
      await f.repo.update({ qitemId: work.qitemId, actorSession: "daemon@kernel", transitionNote: ending === "disposed"
        ? `quiet-release-disposition window=w-alex notification_key=${key} reason=recipient-changed`
        : `slack-owner-notification-posted notification_key=${key}` });
      await f.repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "human-sam@host", summary: "Sam: private salary review" } as never);
      await f.call("POST", "/api/gateway/human/human-alex/mode/end", {});
      const account = (await f.account("human-alex", app.applicationId)).body.account;
      expect(JSON.stringify(account), ending).not.toContain("Sam: private salary review");
      // Set aside by the release: stale, with none of its current fields. Posted to them: delivered, so nothing is owed here.
      expect(account.waiting, ending).toEqual(ending === "disposed"
        ? [{ qitemId: work.qitemId, summary: null, state: null, standing: "stale", reason: "recipient-changed" }] : []);
    }
  });

  it("an ask held for them, posted when quiet ended, answered and unblocked, isn't listed as set aside", async () => {
    const f = fixture();
    for (const id of ["human-alex"]) {
      expect(addHumanFragment({ entityId: id, class: "human", displayName: id, address: `${id}@external`, prefs: { deliveryClass: "B" },
        connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://fixture", role: "primary", handle: `U-${id.toUpperCase()}` }] }, f.home).ok).toBe(true);
    }
    await f.call("PUT", "/api/gateway/human/human-alex/modes/asleep", { availability: "away" });
    const app = (await f.call("POST", "/api/gateway/human/human-alex/modes/asleep/apply", {})).body.application;
    const work = await f.repo.create({ sourceSession: "designer@rig", destinationSession: "designer@rig", summary: "Alex: approve the layout",
      body: "work", evidenceRef: "/proof/layout.md", nudge: false } as never) as QueueItem;
    await f.repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "human-alex@host", summary: "Alex: approve the layout" } as never);
    const key = `${work.qitemId}:1`;
    holdForQuiet({ queueRepo: f.repo, jobsRepo: new WatchdogJobsRepository(f.db), qitemId: work.qitemId, entityId: "human-alex",
      hold: { windowId: "w-alex", occurrence: "until", revision: 1, notificationKey: key } });
    await f.repo.update({ qitemId: work.qitemId, actorSession: "daemon@kernel", transitionNote: `slack-owner-notification-posted notification_key=${key}` });
    await f.repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "in-progress" } as never); // answered: the agent carries on
    expect(f.repo.getById(work.qitemId)!.blockedOn).toBeNull();
    await f.call("POST", "/api/gateway/human/human-alex/mode/end", {});
    expect((await f.account("human-alex", app.applicationId)).body.account.waiting).toEqual([]);
  });
});
