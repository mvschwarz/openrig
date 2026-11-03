// One trusted workspace, distinct people with equal authority: any registered person settles an ask that went to
// another, recorded as themselves with the asked person kept, exactly once; the terminal's act, which names no
// responder, is unattributed rather than credited to the default person; and a person with no connector binding is
// registered, asked in the Feed and Steering, and never claimed as reached in Slack. Real SQLite (all migrations),
// people registered in a temporary home, and the real Mission Control route and write contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { attentionRoutes } from "../src/routes/attention.js";
import { addHumanFragment, humansDir, loadHumanRegistry, writeProjection } from "../src/domain/gateway/human-registry.js";
import { resolveHumanDeliveryReadiness } from "../src/domain/gateway/human-readiness.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";

const ASKER = "writer@rig";

describe("shared-workspace people", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  let app: Hono;
  let contract: MissionControlWriteContract;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "shared-workspace-humans-"));
    vi.stubEnv("OPENRIG_HOME", home);
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never); c.set("missionControlWriteContract" as never, contract as never); await next(); });
    app.route("/api/mission-control", missionControlRoutes());
  });
  afterEach(() => { vi.unstubAllEnvs(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const register = (...ids: string[]) => {
    for (const entityId of ids) expect(addHumanFragment({
      entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: `vault://slack/${entityId}`, role: "primary", handle: `U${entityId.toUpperCase()}` }],
      prefs: { deliveryClass: "B" },
    }, home)).toMatchObject({ ok: true });
  };
  const ask = (to: string, extra: Record<string, unknown> = {}) => repo.create({ sourceSession: ASKER, destinationSession: to, body: "Ship the draft?",
    summary: "Ship the draft?", humanIntent: "decision", evidenceRef: "/fixture/ask", nudge: false, ...extra } as never);
  async function act(body: Record<string, unknown>) {
    const response = await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const transitions = (qitemId: string) => db.prepare("SELECT state, actor_session, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id")
    .all(qitemId) as Array<{ state: string; actor_session: string; transition_note: string }>;
  const audit = (qitemId: string) => {
    const row = db.prepare("SELECT action_verb, actor_session, audit_notes_json FROM mission_control_actions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { action_verb: string; actor_session: string; audit_notes_json: string | null };
    return { verb: row.action_verb, actor: row.actor_session, notes: row.audit_notes_json ? JSON.parse(row.audit_notes_json) : null };
  };
  const replies = (qitemId: string) => repo.list({ limit: 100 }).filter((item) => item.replyTo === qitemId);

  describe("any registered person settles an ask that went to another, recorded as themselves", () => {
    it("Bob answers Sarah's ask in his words: recorded as Bob on Sarah's ask, and the asker reads exactly that", async () => {
      register("sarah", "bob");
      const sarahs = await ask("sarah@external");
      const result = await act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "bob@external", decision: "Ship it" });
      expect(result.status).toBe(200);
      expect(repo.getById(sarahs.qitemId)?.state).toBe("done");
      expect(transitions(sarahs.qitemId).at(-1)).toMatchObject({ state: "done", actor_session: "bob@external" });
      expect(transitions(sarahs.qitemId).at(-1)!.transition_note)
        .toContain("reply from bob@external, a registered person, on sarah@external's ask; not answered by sarah@external");
      expect(audit(sarahs.qitemId)).toEqual({ verb: "answer", actor: "bob@external", notes: { asked: "sarah@external" } });
      const [reply] = replies(sarahs.qitemId);
      expect(reply).toMatchObject({ sourceSession: "bob@external", destinationSession: ASKER, summary: "bob@external answered sarah@external's ask: Ship the draft?" });
      expect(reply!.body).toContain("Answered by bob@external, a registered person, on sarah@external's ask in OpenRig.");
    });

    it("Bob approves Sarah's pending ask and resolves a row parked on her, recorded as Bob on her ask", async () => {
      register("sarah", "bob");
      const pending = await ask("sarah@external");
      expect((await act({ verb: "approve", qitemId: pending.qitemId, actorSession: "bob@external" })).status).toBe(200);
      expect(transitions(pending.qitemId).at(-1)).toMatchObject({ state: "done", actor_session: "bob@external",
        transition_note: "mission-control:approve; by bob@external, a registered person, on sarah@external's ask" });
      expect(audit(pending.qitemId)).toEqual({ verb: "approve", actor: "bob@external", notes: { asked: "sarah@external" } });

      const work = await repo.create({ sourceSession: ASKER, destinationSession: "designer@rig", body: "Layout", summary: "Layout", evidenceRef: "/fixture/layout", nudge: false });
      await repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "sarah@external" } as never);
      expect((await act({ verb: "resolve", qitemId: work.qitemId, actorSession: "bob@external", decision: "Use the wide layout" })).status).toBe(200);
      expect(transitions(work.qitemId).at(-1)).toMatchObject({ state: "in-progress", actor_session: "bob@external",
        transition_note: "Use the wide layout; by bob@external, a registered person, on sarah@external's ask" });
    });

    it("settles once: answering at the same time, one answer returns and closes it, and the other is told who answered", async () => {
      register("sarah", "bob");
      const sarahs = await ask("sarah@external");
      const results = await Promise.all([
        act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "sarah@external", decision: "Ship it" }),
        act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "bob@external", decision: "Hold it" }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const refused = results.find((r) => r.status !== 200)!;
      expect(refused).toMatchObject({ status: 409, body: { error: "qitem_already_terminal" } });
      expect(replies(sarahs.qitemId)).toHaveLength(1);
      expect(transitions(sarahs.qitemId).filter((t) => t.state === "done")).toHaveLength(1);
      // A later answer settles nothing and sends nothing.
      expect(await act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "bob@external", decision: "Hold it" }))
        .toMatchObject({ status: 409, body: { error: "qitem_already_terminal" } });
      expect(replies(sarahs.qitemId)).toHaveLength(1);
    });

    // One answer per ask on every surface, including a process stopped between a committed answer and the close.
    const ports = () => makeQueuePorts(repo, { loadHumanRegistry: () => loadHumanRegistry(home), sharedChannels: () => [] });
    const slackAnswer = (askId: string, who: string, words: string) => ports().createQitem({ qitemId: `qitem-slack-inbound-${who.split("@")[0]}-${askId}`,
      source: who, destination: ASKER, summary: words, body: words, inReplyTo: askId, humanAnswer: true });

    it("Bob's Slack answer committed before Sarah answers in the Feed: Sarah is told Bob answered, and it settles once, as Bob's", async () => {
      register("sarah", "bob");
      const sarahs = await ask("sarah@external");
      await slackAnswer(sarahs.qitemId, "bob@external", "Hold it"); // the process stops before Slack's close runs
      expect(await act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "sarah@external", decision: "Ship it" }))
        .toMatchObject({ status: 409, body: { error: "qitem_already_terminal", answeredBy: "bob@external" } });
      expect(transitions(sarahs.qitemId).at(-1)).toMatchObject({ state: "done", actor_session: "bob@external" });
      expect(replies(sarahs.qitemId).map((r) => [r.sourceSession, r.body])).toEqual([["bob@external", "Hold it"]]);
    });

    it("Sarah's Feed answer committed before Bob's Slack reply: Bob's words stay conversation, and it settles once, as Sarah's", async () => {
      register("sarah", "bob");
      const sarahs = await ask("sarah@external");
      // Sarah's return committed, then the process stopped before the close.
      await repo.createHumanAnswer({ sourceSession: "sarah@external", destinationSession: ASKER, body: "Ship it", summary: "Ship it",
        inboundReplyTo: sarahs.qitemId, nudge: false } as never);
      const bobs = await slackAnswer(sarahs.qitemId, "bob@external", "Hold it");
      expect(await makeHumanReplyResolver(repo, contract)({ qitemId: sarahs.qitemId, actorSession: "bob@external", decision: "Hold it",
        messageTs: "2.2", typedReply: true } as never)).toBe("not-applicable");
      expect(transitions(sarahs.qitemId).at(-1)).toMatchObject({ state: "done", actor_session: "sarah@external" });
      const answers = replies(sarahs.qitemId).filter((r) => r.tags?.includes("human-answer"));
      expect(answers.map((r) => r.sourceSession)).toEqual(["sarah@external"]);
      expect(repo.getById(bobs)).toMatchObject({ sourceSession: "bob@external", body: "Hold it" });
    });

    it("Sarah's typed answer committed before Bob picks an option: Bob's choice isn't recorded, and it settles as Sarah's", async () => {
      register("sarah", "bob");
      const sarahs = await ask("sarah@external", { humanQuestions: [{ id: "go", question: "Ship?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }] });
      await repo.createHumanAnswer({ sourceSession: "sarah@external", destinationSession: ASKER, body: "Do not ship", summary: "Do not ship",
        inboundReplyTo: sarahs.qitemId, nudge: false } as never);
      expect(await act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "bob@external", questionId: "go", optionId: "yes" }))
        .toMatchObject({ status: 409, body: { error: "qitem_already_terminal", answeredBy: "sarah@external" } });
      const closed = repo.getById(sarahs.qitemId)!;
      expect(closed.state).toBe("done");
      expect(closed.humanAnswers?.go).not.toBe("yes");
      expect(transitions(sarahs.qitemId).at(-1)).toMatchObject({ state: "done", actor_session: "sarah@external" });
      expect(replies(sarahs.qitemId).map((r) => r.sourceSession)).toEqual(["sarah@external"]);
    });

    it("a person answering their own ask through the same path is recorded as themselves", async () => {
      register("sarah");
      const sarahs = await ask("sarah@external");
      expect((await act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "sarah@external", decision: "Ship it" })).status).toBe(200);
      expect(transitions(sarahs.qitemId).at(-1)).toMatchObject({ state: "done", actor_session: "sarah@external" });
      expect(replies(sarahs.qitemId)[0]?.sourceSession).toBe("sarah@external");
    });
  });

  describe("the terminal's act names no responder, so it's unattributed", () => {
    it("is recorded as human@host, explicitly unattributed, never the default person, even with one registered person", async () => {
      register("sarah");
      const sarahs = await ask("sarah@external");
      // The Feed serves the asked person's address as the actor, and the TUI sends it with the authority: that's whose ask
      // it is, not who typed.
      const result = await act({ verb: "answer", qitemId: sarahs.qitemId, actorSession: "sarah@external", authority: "primary-user", decision: "Ship it" });
      expect(result.status).toBe(200);
      expect(transitions(sarahs.qitemId).at(-1)).toMatchObject({ state: "done", actor_session: "human@host" });
      expect(transitions(sarahs.qitemId).at(-1)!.transition_note)
        .toContain("reply from someone at the terminal OpenRig can't name (human@host), unattributed, on sarah@external's ask; not answered by sarah@external");
      expect(audit(sarahs.qitemId)).toEqual({ verb: "answer", actor: "human@host", notes: { authority: "primary-user", asked: "sarah@external" } });
      const [reply] = replies(sarahs.qitemId);
      expect(reply).toMatchObject({ sourceSession: "human@host", summary: "Unattributed (human@host) answered sarah@external's ask: Ship the draft?" });
      expect(reply!.body).toContain("Answered at the terminal by someone OpenRig can't name (human@host), unattributed, on sarah@external's ask in OpenRig.");
    });
  });

  it("with no one registered, the terminal's act is still unattributed, whatever address it claims", async () => {
    const legacy = await ask("human-review@kernel");
    expect((await act({ verb: "approve", qitemId: legacy.qitemId, actorSession: "human-review@kernel", authority: "primary-user" })).status).toBe(200);
    expect(transitions(legacy.qitemId).at(-1)).toMatchObject({ state: "done", actor_session: "human@host",
      transition_note: "mission-control:approve; by someone at the terminal OpenRig can't name (human@host), unattributed, on human-review@kernel's ask" });
  });

  describe("a person with no connector binding", () => {
    const dana = { entityId: "dana", class: "human" as const, displayName: "Dana", address: "dana@external", connectorBindings: [], prefs: { deliveryClass: "B" as const } };

    it("an open ask to them owes no Slack post, so it never reads never-posted or undelivered; one to a Slack person does", async () => {
      register("sarah");
      expect(addHumanFragment(dana, home)).toMatchObject({ ok: true });
      const danas = await ask("dana@external");
      const sarahs = await ask("sarah@external");
      vi.useFakeTimers({ now: Date.now() + 10 * 60_000, toFake: ["Date"] });
      try {
        expect(repo.deliveryOutcomeFor(sarahs.qitemId)?.outcome).toBe("never-posted");
        expect(repo.deliveryOutcomeFor(danas.qitemId)).toBeNull();
        expect(repo.findUndelivered().map((item) => item.qitemId)).not.toContain(danas.qitemId);
      } finally {
        vi.useRealTimers();
      }
    });

    it("registers and loads beside people with Slack, and a hand-written fragment with no bindings loads too", () => {
      register("sarah");
      expect(addHumanFragment(dana, home)).toMatchObject({ ok: true });
      mkdirSync(humansDir(home), { recursive: true });
      writeFileSync(join(humansDir(home), "eli.yaml"), "entityId: eli\nclass: human\ndisplayName: Eli\naddress: eli@external\nprefs:\n  deliveryClass: B\n");
      // A hand-written fragment joins the registry through the supported re-projection.
      expect(writeProjection(home)).toMatchObject({ ok: true });
      const loaded = loadHumanRegistry(home);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.entities.map((e) => [e.entityId, e.connectorBindings.length]).sort()).toEqual([["dana", 0], ["eli", 0], ["sarah", 1]]);
    });

    it("is asked in the Feed and answers there, and nothing posts or claims Slack delivery for them", async () => {
      register("sarah");
      expect(addHumanFragment(dana, home)).toMatchObject({ ok: true });
      // A decision parked on each person: Slack's open asks list Sarah's and never Dana's.
      const parkOn = async (person: string) => {
        const row = await repo.create({ sourceSession: ASKER, destinationSession: "designer@rig", body: `Choose for ${person}`, nudge: false });
        repo.update({ qitemId: row.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: person, summary: `Choose for ${person}`,
          evidenceRef: "/fixture/choose", transitionNote: "parked" } as never);
        return row;
      };
      await parkOn("dana@external");
      const sarahsPark = await parkOn("sarah@external");
      const open = await makeQueuePorts(repo, { loadHumanRegistry: () => loadHumanRegistry(home), sharedChannels: () => [] }).listOpenAsks({ minimumLevel: "NOTICE" });
      expect(open.map((o) => o.item.qitemId)).toEqual([sarahsPark.qitemId]);
      const danas = await ask("dana@external");
      const loaded = loadHumanRegistry(home);
      const record = loaded.ok ? loaded.entities.find((e) => e.entityId === "dana")! : null;
      const readiness = await resolveHumanDeliveryReadiness({ human: record!, gatewayState: "active", botToken: "xoxb-fixture",
        config: { enabled: true, channel: "CFIXTURE", outboundDestinations: [], requiredScopes: [] } as never });
      expect(readiness).toMatchObject({ state: "not-ready", ready: false, configured: false });
      expect(readiness.connector).toBeUndefined();
      expect(readiness.reason).toContain("Feed and Steering");
      expect((await act({ verb: "answer", qitemId: danas.qitemId, actorSession: "dana@external", decision: "Ship it" })).status).toBe(200);
      expect(repo.getById(danas.qitemId)?.state).toBe("done");
    });

    it("isn't told in the Feed to follow an ask or a park in Slack, and a Slack person still is", async () => {
      register("sarah");
      expect(addHumanFragment(dana, home)).toMatchObject({ ok: true });
      app.route("/api/attention", attentionRoutes());
      const feed = async (qitemId: string) => ((await (await app.request(`/api/attention?item=${encodeURIComponent(`queue:${qitemId}`)}`)).json()) as
        { detail: { lines: string[] } }).detail.lines;
      const park = await repo.create({ sourceSession: ASKER, destinationSession: "designer@rig", body: "Choose for Dana", nudge: false });
      repo.update({ qitemId: park.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "dana@external", summary: "Choose for Dana",
        evidenceRef: "/fixture/choose", transitionNote: "parked" } as never);
      for (const row of [await ask("dana@external"), park]) {
        const lines = await feed(row.qitemId);
        expect(lines).toContain("Slack: not sent: this person has no connector binding, so they're asked on Steering and in the Feed only");
        expect(lines.some((line) => line.startsWith("Decision route: answer on Steering; it wasn't sent to Slack."))).toBe(true);
      }
      const sarahs = await feed((await ask("sarah@external")).qitemId);
      expect(sarahs.some((line) => line.startsWith("Decision route: follow the correlated human request in Slack."))).toBe(true);
      expect(sarahs.find((line) => line.startsWith("Slack: "))).not.toContain("no connector binding");
    });
  });
});
