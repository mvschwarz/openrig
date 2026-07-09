// OPR.0.4.6.MH3 C4 — the consolidated BR-1 negative (plan §4 C4, QA2 note 10
// unit-tier twin): after a FULL cross-host walk (local create, cross-host
// create, cross-host handoff, local handoff, cross-host handoff-and-complete),
// NO persisted session-string carrier anywhere in the queue schema carries an
// `@host` extension — `destination_session`, `source_session`, `blocked_on`,
// `handed_off_to`/`handed_off_from`, the transition log's `actor_session`,
// AND the transition log's free-text `transition_note` (rev1-r2 B1: the note
// is a durable audit carrier too — swept per-TOKEN, since a note may honestly
// mention two separate 2-part sessions) all stay free of the 3-part form. The
// ONLY columns allowed (and, for the cross-host closes, REQUIRED) to carry
// the opaque 3-part form are `closure_target` on queue_items and its verbatim
// mirror on queue_transitions (arch R1) — asserted positively so the
// exemption is a pinned contract, not an accident.
//
// The VM proof's leg-7 grep runs the same negative over BOTH daemon homes;
// this unit twin locks the A-side writer paths at the source.

import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH3B" }],
};
process.env["MH3B"] = "remote-token";

const atParts = (s: string): number => s.split("@").length - 1;

describe("MH-3 C4 — BR-1 sweep: no @host in ANY persisted session carrier after a full cross-host walk", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it("session carriers stay ≤2-part everywhere; closure_target alone carries the opaque 3-part form on cross-host closes", async () => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
    const bus = new EventBus(db);
    const repo = new QueueRepository(db, bus, { validateRig: () => true });
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (k: string, v: unknown) => void;
      set("eventBus", bus);
      set("queueRepo", repo);
      set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
      set("remoteFetchImpl", (async (_u: unknown, init?: RequestInit) => {
        const b = JSON.parse(String((init as { body?: unknown })?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ qitemId: b["qitemId"] ?? "qitem-origin" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    const post = (path: string, body: Record<string, unknown>) =>
      app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    // The walk: every writer path MH-3 touches, local and cross-host.
    expect((await post("/api/queue/create", { sourceSession: "orch@rig-a", destinationSession: "w1@rig-a", body: "local", nudge: false })).status).toBe(201);
    expect((await post("/api/queue/create", { sourceSession: "orch@rig-a", destinationSession: "dev@rig-b", body: "xh", hostId: "vps-b", nudge: false })).status).toBe(201);
    await repo.create({ qitemId: "qitem-xh-src", sourceSession: "orch@rig-a", destinationSession: "w2@rig-a", body: "src", nudge: false });
    expect((await post("/api/queue/qitem-xh-src/handoff", { fromSession: "w2@rig-a", toSession: "dev@rig-b", hostId: "vps-b", nudge: false })).status).toBe(201);
    await repo.create({ qitemId: "qitem-local-src", sourceSession: "orch@rig-a", destinationSession: "w3@rig-a", body: "src2", nudge: false });
    expect((await post("/api/queue/qitem-local-src/handoff", { fromSession: "w3@rig-a", toSession: "w4@rig-a", nudge: false })).status).toBe(201);
    await repo.create({ qitemId: "qitem-xh-src2", sourceSession: "orch@rig-a", destinationSession: "w5@rig-a", body: "src3", nudge: false });
    expect((await post("/api/queue/qitem-xh-src2/handoff-and-complete", { fromSession: "w5@rig-a", toSession: "dev@rig-b", hostId: "vps-b", nudge: false })).status).toBe(201);

    // THE SWEEP — every persisted session-string carrier, every row.
    const items = db
      .prepare("SELECT qitem_id id, source_session s, destination_session d, blocked_on b, handed_off_to ht, handed_off_from hf, closure_target ct FROM queue_items")
      .all() as Array<{ id: string; s: string; d: string; b: string | null; ht: string | null; hf: string | null; ct: string | null }>;
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) {
      for (const carrier of [row.s, row.d, row.b, row.ht, row.hf]) {
        if (carrier) expect(atParts(carrier), `session carrier '${carrier}' on ${row.id} must stay ≤2-part`).toBeLessThanOrEqual(1);
      }
    }
    // rev1-r1 extension: the FULL queue_transitions opaque/free-text column
    // set — actor_session, transition_note, closure_reason, closure_target —
    // is enumerated here; nothing in the table is left unswept or unpinned.
    const transitions = db
      .prepare("SELECT qitem_id id, actor_session a, transition_note n, closure_reason cr, closure_target ct FROM queue_transitions")
      .all() as Array<{ id: string; a: string; n: string | null; cr: string | null; ct: string | null }>;
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      expect(atParts(t.a), `actor_session '${t.a}' must stay ≤2-part`).toBeLessThanOrEqual(1);
      if (t.cr) expect(atParts(t.cr), `closure_reason '${t.cr}' must carry no session form at all`).toBe(0);
      // rev1-r2 B1: transition_note is a DURABLE carrier — no single token in
      // it may be the 3-part member@rig@host form. Per-token, not per-string:
      // a note may legitimately name two separate 2-part sessions (the
      // fallback-routed note does exactly that).
      if (t.n) {
        for (const token of t.n.split(/\s+/)) {
          expect(atParts(token), `transition_note token '${token}' on ${t.id} must not be 3-part`).toBeLessThanOrEqual(1);
        }
      }
    }

    // THE EXEMPTION, pinned positively (R1): both cross-host source closes
    // carry the opaque 3-part closure_target — and nothing else does. The
    // transitions row mirrors the SAME closure_target column verbatim; that
    // mirror is the only other 3-part site, pinned here so it can never
    // widen silently.
    const threePartCts = items.filter((r) => r.ct && atParts(r.ct) === 2).map((r) => r.id).sort();
    expect(threePartCts).toEqual(["qitem-xh-src", "qitem-xh-src2"]);
    for (const row of items) {
      if (row.ct) expect(atParts(row.ct)).toBeLessThanOrEqual(2);
    }
    // Guard G-MH3-BR1-FIXBACK-1: "verbatim mirror" must be proven on VALUES,
    // not ids/counts — compare the exact (qitem_id, closure_target) sets so a
    // wrong 3-part value on the right qitem (or a swap) cannot pass.
    const itemClosureTargets = items
      .filter((r) => r.ct && atParts(r.ct) === 2)
      .map((r) => `${r.id}:${r.ct}`)
      .sort();
    const transitionClosureTargets = transitions
      .filter((t) => t.ct && atParts(t.ct) === 2)
      .map((t) => `${t.id}:${t.ct}`)
      .sort();
    expect(transitionClosureTargets).toEqual(itemClosureTargets);
    expect(itemClosureTargets).toEqual(["qitem-xh-src2:dev@rig-b@vps-b", "qitem-xh-src:dev@rig-b@vps-b"]);
    for (const t of transitions) {
      if (t.ct) expect(atParts(t.ct)).toBeLessThanOrEqual(2);
    }

    // The B1 regression, pinned at its sharpest point: the cross-host source
    // closes minted a DEFAULT note (no caller note on this walk) — it must
    // reference the 2-part toSession and must NOT contain the 3-part form.
    const xhCloseNotes = transitions.filter(
      (t) => (t.id === "qitem-xh-src" || t.id === "qitem-xh-src2") && t.n?.startsWith("cross-host handoff to ")
    );
    expect(xhCloseNotes.length).toBe(2);
    for (const t of xhCloseNotes) {
      expect(t.n).toContain("dev@rig-b");
      expect(t.n).not.toContain("dev@rig-b@vps-b");
    }
  });
});
