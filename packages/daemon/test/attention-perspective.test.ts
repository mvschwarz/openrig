// The Feed's perspective: whose queue it shows. Viewing a colleague's queue is a view, never an identity: whatever is shown,
// acts on it carry the primary user's authority, the person at the terminal (the default person). Real SQLite (all
// migrations), people registered in a temporary home, the real queue and the real attention route.
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
import { setDefaultPerson, setSharedChannel } from "../src/domain/gateway/participants.js";
import { attentionRoutes } from "../src/routes/attention.js";
import { queueRoutes } from "../src/routes/queue.js";
import type { AttentionRead } from "../src/attention-surface.js";

describe("the Feed shows one person's queue, or everyone's, and acts with the primary user's authority whichever it shows", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "attention-perspective-"));
    vi.stubEnv("OPENRIG_HOME", home);
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => { vi.unstubAllEnvs(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const register = (...ids: string[]) => {
    for (const entityId of ids) expect(addHumanFragment({
      entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: `vault://slack/${entityId}`, role: "primary", handle: `U${entityId.toUpperCase()}` }],
      prefs: { deliveryClass: "B" },
    }, home)).toMatchObject({ ok: true });
  };
  const askTo = (destinationSession: string, summary: string) =>
    repo.create({ sourceSession: "orch-lead@r", destinationSession, body: `${summary} body`, summary, evidenceRef: "/fixture/ask", nudge: false });
  async function get(path: string): Promise<unknown> {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); await next(); });
    app.route("/api/attention", attentionRoutes());
    app.route("/api/queue", queueRoutes());
    return await (await app.request(path)).json();
  }
  const read = async (query = ""): Promise<AttentionRead> => await get(`/api/attention${query}`) as AttentionRead;
  const asked = (r: AttentionRead) => r.items.filter((i) => i.id.startsWith("queue:")).map((i) => i.summary).sort();

  it("with no view it shows every person's asks, as before, and says who acts", async () => {
    register("mike", "sarah");
    await askTo("mike@external", "Mike's ask");
    await askTo("sarah@external", "Sarah's ask");
    const all = await read();
    expect(asked(all)).toEqual(["Mike's ask", "Sarah's ask"]);
    // Two people and no default: the primary user acts, unnamed.
    expect(all.perspective).toEqual({ viewing: null, basis: "all", defaultSource: "none", actingAs: { person: null, authority: "primary-user" } });
  });

  it("viewing one person shows only their asks, and doesn't change who acts or how", async () => {
    register("mike", "sarah");
    expect(setDefaultPerson("mike", home).ok).toBe(true);
    const mike = await askTo("mike@external", "Mike's ask");
    const sarah = await askTo("sarah@external", "Sarah's ask");
    const all = await read("?view=all");
    for (const view of ["sarah", "sarah@external"]) {
      const r = await read(`?view=${encodeURIComponent(view)}`);
      expect(asked(r)).toEqual(["Sarah's ask"]);
      // Viewing Sarah is not acting as Sarah: Mike, the default, acts.
      expect(r.perspective).toEqual({ viewing: "sarah@external", basis: "chosen-here", defaultSource: "chosen",
        actingAs: { person: "mike@external", authority: "primary-user" } });
      // The act on Sarah's ask is the same one the unfiltered Feed offers.
      expect(r.items.find((i) => i.id === `queue:${sarah.qitemId}`)).toEqual(all.items.find((i) => i.id === `queue:${sarah.qitemId}`));
    }
    // An item opened by id is still shown in full, whichever queue is viewed.
    const opened = await read(`?view=sarah&item=${encodeURIComponent(`queue:${mike.qitemId}`)}`);
    expect(opened.detail?.item.id).toBe(`queue:${mike.qitemId}`);
    expect(asked(all)).toEqual(["Mike's ask", "Sarah's ask"]);
  });

  it("with a chosen default, the default view is that person's, and says it was chosen", async () => {
    register("mike", "sarah");
    expect(setDefaultPerson("sarah", home).ok).toBe(true);
    await askTo("mike@external", "Mike's ask");
    await askTo("sarah@external", "Sarah's ask");
    const r = await read("?view=default");
    expect(asked(r)).toEqual(["Sarah's ask"]);
    expect(r.perspective).toEqual({ viewing: "sarah@external", basis: "default", defaultSource: "chosen",
      actingAs: { person: "sarah@external", authority: "primary-user" } });
  });

  it("with one person and no chosen default, they're the default and the primary user, and it says no one chose them", async () => {
    register("mike");
    await askTo("mike@external", "Mike's ask");
    const r = await read("?view=default");
    expect(asked(r)).toEqual(["Mike's ask"]);
    expect(r.perspective).toEqual({ viewing: "mike@external", basis: "default", defaultSource: "only-person",
      actingAs: { person: "mike@external", authority: "primary-user" } });
  });

  it("with several people and no default, the default view is everyone's, and says so", async () => {
    register("mike", "sarah");
    await askTo("mike@external", "Mike's ask");
    await askTo("sarah@external", "Sarah's ask");
    const r = await read("?view=default");
    expect(asked(r)).toEqual(["Mike's ask", "Sarah's ask"]);
    expect(r.perspective).toMatchObject({ viewing: null, basis: "all", defaultSource: "none" });
  });

  it("a view naming no registered person shows no one's asks, and names what was asked for", async () => {
    register("mike");
    await askTo("mike@external", "Mike's ask");
    const r = await read("?view=ana");
    expect(asked(r)).toEqual([]);
    expect(r.perspective).toEqual({ viewing: null, basis: "unknown", requested: "ana", defaultSource: "only-person",
      actingAs: { person: "mike@external", authority: "primary-user" } });
  });

  it("a row parked on a person is resolved from the Feed in words, as an ask to them is answered", async () => {
    register("mike", "sarah");
    const work = await repo.create({ sourceSession: "orch-lead@r", destinationSession: "designer@rig", body: "Layout", summary: "Layout", nudge: false });
    await repo.update({ qitemId: work.qitemId, actorSession: "designer@rig", state: "blocked", blockedOn: "sarah@external" } as never);
    const item = (await read("?view=sarah")).items.find((i) => i.id === `queue:${work.qitemId}`);
    expect(item).toMatchObject({ recipient: "sarah@external", answer: { verb: "resolve", actorSession: "sarah@external" } });
  });

  it("delivered updates follow the same view", async () => {
    register("mike", "sarah");
    for (const person of ["mike", "sarah"]) {
      db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,summary,human_intent) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(`${person}-update`, "2026-10-25T10:00:00Z", "2026-10-25T10:00:00Z", "worker@rig", `${person}@external`, "done", "routine", "Done", `${person}'s update`, "update");
      repo.transitionLog.append({ qitemId: `${person}-update`, state: "done", actorSession: "worker@rig", transitionNote: "slack-owner-notification-posted 1000.0001" });
    }
    const updates = async (query: string) => ((await get(`/api/queue/human-updates?limit=20${query}`)) as { items: Array<{ qitemId: string }> }).items.map((i) => i.qitemId).sort();
    expect(await updates("")).toEqual(["mike-update", "sarah-update"]);
    expect(await updates("&view=sarah")).toEqual(["sarah-update"]);
    expect(await updates("&view=all")).toEqual(["mike-update", "sarah-update"]);
    expect(await updates("&view=ana")).toEqual([]);
  });

  it("with no registered person there is no perspective, and the Feed is as before", async () => {
    await askTo("human@host", "A seat's ask");
    const r = await read("?view=default");
    expect(r.perspective).toBeUndefined();
    expect(asked(r)).toEqual(["A seat's ask"]);
  });

  it("with only a shared channel registered, the Feed serves the person at the terminal as the actor, never the channel", async () => {
    const CHANNEL = "acme-customers@external";
    expect(setSharedChannel("acme-customers", { displayName: "Acme customers", policy: "Customers of Acme.",
      channel: { connector: "slack", connectorRef: "primary", secretsRef: "vault://slack/bot", channelId: "CACME" } }, {}, home).ok).toBe(true);
    const ask = await askTo(CHANNEL, "The channel's ask");
    const work = await repo.create({ sourceSession: "orch-lead@r", destinationSession: "designer@r", body: "Plan", summary: "Parked on the channel", evidenceRef: "/fixture/plan", nudge: false });
    await repo.update({ qitemId: work.qitemId, actorSession: "designer@r", state: "blocked", blockedOn: CHANNEL } as never);
    const r = await read();
    expect(r.perspective).toBeUndefined();
    const item = (qitemId: string) => r.items.find((i) => i.id === `queue:${qitemId}`);
    expect(item(ask.qitemId)).toMatchObject({ recipient: CHANNEL, answer: { verb: "approve", actorSession: "human@host" } });
    expect(item(work.qitemId)).toMatchObject({ recipient: CHANNEL, answer: { verb: "resolve", actorSession: "human@host" } });
  });
});
