// A cheap attention read for a polled needs-you badge: `kind=action` reads only the queue's asks and parks, and gives
// exactly the asks the full Feed gives for the same view; a view is applied before a row's further reads; a view naming
// no registered person answers at once. Real SQLite (all migrations), people registered in a temporary home, the real
// queue and the real attention route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { addHumanFragment } from "../src/domain/gateway/human-registry.js";
import { setDefaultPerson } from "../src/domain/gateway/participants.js";
import { attentionRoutes } from "../src/routes/attention.js";
import type { AttentionRead } from "../src/attention-surface.js";

describe("the Feed's asks, read on their own for a badge", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "attention-asks-only-"));
    workspace = mkdtempSync(join(tmpdir(), "attention-asks-only-ws-"));
    vi.stubEnv("OPENRIG_HOME", home);
    mkdirSync(join(workspace, "a"), { recursive: true });
    writeFileSync(join(workspace, "workspace.yaml"), YAML.stringify({ projects: [{ id: "a", root: "./a" }] }));
    writeFileSync(join(workspace, "a", "project.yaml"), YAML.stringify({ metadata: { id: "a" } }));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    for (const entityId of ["mike", "sarah"]) expect(addHumanFragment({
      entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: `vault://slack/${entityId}`, role: "primary", handle: `U${entityId.toUpperCase()}` }],
      prefs: { deliveryClass: "B" },
    }, home)).toMatchObject({ ok: true });
    expect(setDefaultPerson("mike", home).ok).toBe(true);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); db.close(); rmSync(home, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });

  const read = async (query = ""): Promise<AttentionRead> => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, repo as never);
      c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? workspace : join(workspace, "workspace.yaml") }) } as never);
      await next();
    });
    app.route("/api/attention", attentionRoutes());
    return await (await app.request(`/api/attention${query}`)).json() as AttentionRead;
  };
  const askTo = (destinationSession: string, summary: string) =>
    repo.create({ sourceSession: "orch-lead@r", destinationSession, body: `${summary} body`, summary, evidenceRef: "/fixture/ask", tags: ["project:a"], nudge: false });
  const parkOn = async (blockedOn: string, summary: string) => {
    const work = await repo.create({ sourceSession: "orch-lead@r", destinationSession: "designer@r", body: summary, summary, nudge: false });
    await repo.update({ qitemId: work.qitemId, actorSession: "designer@r", state: "blocked", blockedOn, summary, evidenceRef: "/fixture/park" } as never);
    return work;
  };
  const seed = async () => {
    await askTo("mike@external", "Mike's ask");
    await askTo("sarah@external", "Sarah's ask");
    // A registered person addressed as a seat: an ask to them by its classification.
    await askTo("sarah@kernel", "Sarah's ask at a seat");
    await askTo("human@host", "A bare human seat's ask");
    await parkOn("sarah@external", "Parked on Sarah");
    await parkOn("mike@external", "Parked on Mike");
    db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,summary,human_intent) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("sarah-open-update", "2026-10-25T10:00:00Z", "2026-10-25T10:00:00Z", "worker@rig", "sarah@external", "pending", "routine", "Update", "Sarah's update", "update");
  };

  it("kind=action gives exactly the full Feed's asks and perspective, in every view", async () => {
    await seed();
    for (const view of ["", "view=all", "view=default", "view=mike", "view=sarah", "view=sarah%40external"]) {
      const full = await read(view ? `?${view}` : "");
      const asks = await read(`?kind=action${view ? `&${view}` : ""}`);
      expect(full.items.filter((i) => i.kind === "action").length).toBeGreaterThan(0);
      expect(asks.items).toEqual(full.items.filter((i) => i.kind === "action"));
      expect(asks.perspective).toEqual(full.perspective);
      // It says what it didn't read, and reads none of it.
      expect(asks.sources).toContainEqual(expect.objectContaining({ source: "kind", state: "partial" }));
      expect(asks.sources.map((s) => s.source)).not.toContain("queue updates");
      // kind=update gives the rest.
      const updates = await read(`?kind=update${view ? `&${view}` : ""}`);
      expect(updates.items).toEqual(full.items.filter((i) => i.kind === "update"));
    }
    // Sarah's view counts her seat-addressed ask and the row parked on her.
    const sarah = (await read("?kind=action&view=sarah")).items.map((i) => i.summary).sort();
    expect(sarah).toEqual(["Parked on Sarah", "Sarah's ask", "Sarah's ask at a seat"]);
  });

  it("any other kind reads the whole Feed, as no kind does", async () => {
    await seed();
    const full = await read();
    const other = await read("?kind=everything");
    expect(other.items).toEqual(full.items);
    expect(other.sources.map((s) => s.source)).toEqual(full.sources.map((s) => s.source));
  });

  it("a view reads no further into a row outside it", async () => {
    await seed();
    const revisions = vi.spyOn(repo, "decisionRevision");
    const sarah = await read("?kind=action&view=sarah");
    expect(revisions).toHaveBeenCalledTimes(sarah.items.length);
    // A row outside the view, opened by id, is still read in full.
    const mike = (await read("?kind=action")).items.find((i) => i.summary === "Mike's ask")!;
    const opened = await read(`?kind=action&view=sarah&item=${encodeURIComponent(mike.id)}`);
    expect(opened.detail?.item).toEqual(mike);
    expect(opened.items.map((i) => i.id)).not.toContain(mike.id);
  });

  it("a view naming no registered person answers at once, with its perspective and no items", async () => {
    await seed();
    const listed = vi.spyOn(repo, "listAttention");
    const r = await read("?view=ana");
    expect(listed).not.toHaveBeenCalled();
    expect(r.items).toEqual([]);
    expect(r.perspective).toEqual({ viewing: null, basis: "unknown", requested: "ana", defaultSource: "chosen",
      actingAs: { person: "mike@external", authority: "primary-user" } });
    expect(r.sources).toEqual([expect.objectContaining({ source: "view", state: "available" })]);
    expect(await read("?kind=action&view=ana")).toMatchObject({ items: [], perspective: r.perspective });
    // An item opened by id is shown in full whatever the view, so that read still happens.
    const mike = (await read()).items.find((i) => i.summary === "Mike's ask")!;
    expect((await read(`?view=ana&item=${encodeURIComponent(mike.id)}`)).detail?.item).toEqual(mike);
  });
});
