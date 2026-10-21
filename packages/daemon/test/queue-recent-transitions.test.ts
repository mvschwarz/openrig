import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueTransitionsArchiveSchema } from "../src/db/migrations/054_queue_transitions_archive.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("RECENT queue transition projection", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let app: Hono;
  let nextTransitionId: number;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, rigArchiveSchema, queueItemSummarySchema]);
    repo = new QueueRepository(db, new EventBus(db));
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, repo);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    nextTransitionId = 1;
  });

  afterEach(() => db.close());

  function item(
    id: string,
    rig: string,
    state: string,
    tags: string[] = [],
    extra: { handedOffFrom?: string; summary?: string | null; body?: string } = {},
  ): void {
    db.prepare(`INSERT INTO queue_items (
      qitem_id, ts_created, ts_updated, source_session, destination_session,
      state, priority, tags, handed_off_from, summary, body
    ) VALUES (?, ?, ?, ?, ?, ?, 'routine', ?, ?, ?, ?)`).run(
      id,
      "2026-09-03T20:00:00.000Z",
      "2026-09-03T20:00:00.000Z",
      `sender@${rig}`,
      `owner@${rig}`,
      state,
      JSON.stringify(tags),
      extra.handedOffFrom ?? null,
      "summary" in extra ? extra.summary : `Summary for ${id}`,
      extra.body ?? "body text must never classify an event",
    );
  }

  function transition(
    qitemId: string,
    state: string,
    opts: { note?: string; reason?: string; target?: string; actor?: string } = {},
  ): void {
    const id = nextTransitionId++;
    db.prepare(`INSERT INTO queue_transitions (
      transition_id, qitem_id, ts, state, transition_note, actor_session, closure_reason, closure_target
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      qitemId,
      `2026-09-03T20:${String(id).padStart(2, "0")}:00.000Z`,
      state,
      opts.note ?? null,
      opts.actor ?? "dev-qa@rig-a",
      opts.reason ?? null,
      opts.target ?? null,
    );
  }

  it("normalizes only the typed allowlist, stays current-rig scoped, de-duplicates handoff, and orders newest last", async () => {
    item("q-claim", "rig-a", "in-progress", ["mission:release-0.5.9", "slice:OPR.0.5.9.11"], {
      summary: "Canceled wording is presentation context, not a typed outcome",
    });
    transition("q-claim", "pending", { note: "created" });
    transition("q-claim", "in-progress", { note: "words are irrelevant" });
    transition("q-claim", "in-progress", { note: "claimed founder ruling CLEAR" });

    item("q-block", "rig-a", "in-progress");
    transition("q-block", "pending");
    transition("q-block", "blocked", { reason: "blocked_on", target: "q-upstream" });
    transition("q-block", "blocked", { note: "watchdog chatter says completed" });
    transition("q-block", "in-progress", { note: "free-form note says denied" });

    item("q-handoff", "rig-a", "handed-off");
    transition("q-handoff", "pending");
    transition("q-handoff", "in-progress");
    transition("q-handoff", "handed-off", { reason: "handed_off_to", target: "review-r2@rig-a" });
    item("q-successor", "rig-a", "pending", [], { handedOffFrom: "q-handoff" });
    transition("q-successor", "pending", { note: "handoff from q-handoff" });

    item("q-done", "rig-a", "done");
    transition("q-done", "pending");
    transition("q-done", "in-progress");
    transition("q-done", "done", { reason: "no-follow-on" });

    item("q-denied", "rig-a", "denied");
    transition("q-denied", "pending");
    transition("q-denied", "denied", { reason: "denied" });

    item("q-failed", "rig-a", "failed");
    transition("q-failed", "pending");
    transition("q-failed", "failed");

    item("q-canceled", "rig-a", "canceled");
    transition("q-canceled", "pending");
    transition("q-canceled", "canceled", { reason: "canceled" });

    item("q-escalation", "rig-a", "handed-off");
    transition("q-escalation", "pending");
    transition("q-escalation", "handed-off", { reason: "escalation", target: "human@kernel" });

    item("q-other", "rig-b", "in-progress");
    transition("q-other", "pending", { actor: "elsewhere@rig-b" });
    transition("q-other", "in-progress", { actor: "elsewhere@rig-b" });

    const rows = repo.listRecentTransitions("rig-a", 20);
    expect(rows.map((row) => row.change)).toEqual([
      "claimed",
      "blocked on q-upstream",
      "resumed",
      "claimed",
      "handed off to review-r2@rig-a",
      "claimed",
      "completed",
      "denied",
      "failed",
      "canceled",
      "escalation",
    ]);
    expect(rows.filter((row) => row.change.startsWith("handed off"))).toHaveLength(1);
    expect(rows.every((row) => row.rig === "rig-a")).toBe(true);
    expect(rows.every((row) => row.actorSession !== "elsewhere@rig-b")).toBe(true);
    expect(rows[0]).toMatchObject({
      qitemId: "q-claim",
      summary: "Canceled wording is presentation context, not a typed outcome",
      targetKind: "slice",
      target: "OPR.0.5.9.11",
    });
    expect(rows.map((row) => row.transitionId)).toEqual([...rows.map((row) => row.transitionId)].sort((a, b) => a - b));

    const response = await app.request("/api/queue/recent-transitions?rig=rig-a&limit=20");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(rows);
  });

  describe("a row with no summary", () => {
    function claimed(id: string, extra: Parameters<typeof item>[4]): void {
      item(id, "rig-a", "in-progress", [], extra);
      transition(id, "pending");
      transition(id, "in-progress");
    }
    const entry = (id: string) => repo.listRecentTransitions("rig-a").find((row) => row.qitemId === id)!;

    it("keeps summary empty and offers the body's first non-blank line as bodyPreview, whether the summary is null, empty or only spaces", () => {
      claimed("q-null", { summary: null, body: "\n  \n  Review the retry change  \nsecond line" });
      claimed("q-empty", { summary: "", body: "Fix the flaky restore test\nwith detail" });
      claimed("q-spaces", { summary: "  \u00a0\t ", body: "Check the upgrade path" });
      expect(entry("q-null")).toMatchObject({ summary: null, bodyPreview: "Review the retry change" });
      expect(entry("q-empty")).toMatchObject({ summary: null, bodyPreview: "Fix the flaky restore test" });
      expect(entry("q-spaces")).toMatchObject({ summary: null, bodyPreview: "Check the upgrade path" });
    });

    it("gives no preview to a row with an authored summary, an empty or whitespace-only body, or no line within the first 2,000 characters", () => {
      claimed("q-authored", { summary: "  Authored subject  ", body: "Body line that must not appear" });
      claimed("q-empty-body", { summary: null, body: "" });
      claimed("q-blank", { summary: null, body: " \n\t\n\u00a0 " });
      claimed("q-far", { summary: null, body: `${" \n".repeat(1001)}Review the restore path` });
      claimed("q-edge", { summary: null, body: `${" ".repeat(1998)}\nLast line inside the window` });
      expect(entry("q-authored")).toMatchObject({ summary: "Authored subject", bodyPreview: null });
      expect(entry("q-empty-body")).toMatchObject({ summary: null, bodyPreview: null });
      expect(entry("q-blank")).toMatchObject({ summary: null, bodyPreview: null });
      expect(entry("q-far")).toMatchObject({ summary: null, bodyPreview: null });
      // 1,998 spaces + "\n" put "L" at character 2,000: inside the window, so it is found (and cut by the window).
      expect(entry("q-edge").bodyPreview).toBe("L");
      claimed("q-edge-out", { summary: null, body: `${" ".repeat(1999)}\nFirst line after the window` });
      expect(entry("q-edge-out").bodyPreview).toBeNull();
    });

    it("cuts a long first line at 240 code points without splitting a character", () => {
      claimed("q-long", { summary: null, body: `${"é".repeat(300)}\nnext` });
      claimed("q-exact", { summary: null, body: "x".repeat(240) });
      claimed("q-emoji", { summary: null, body: "😀".repeat(241) });
      expect(entry("q-long").bodyPreview).toBe(`${"é".repeat(237)}...`);
      expect(entry("q-exact").bodyPreview).toBe("x".repeat(240));
      expect(entry("q-emoji").bodyPreview).toBe(`${"😀".repeat(237)}...`);
    });

    it("reads the body only for a row whose summary is blank, by the same rule as trim()", () => {
      // The body is read through substr(); replace it with a counting copy to see which rows reach it.
      const reads: string[] = [];
      db.function("substr", (text: unknown, from: unknown, length: unknown) => {
        reads.push(String(text).slice(0, 12));
        return Array.from(String(text)).slice(Number(from) - 1, Number(from) - 1 + Number(length)).join("");
      });
      claimed("q-authored", { summary: "Authored subject", body: "AUTHORED body" });
      claimed("q-padded", { summary: "  \u00a0Padded subject\t ", body: "PADDED body" });
      claimed("q-null", { summary: null, body: "NULL body" });
      claimed("q-empty", { summary: "", body: "EMPTY body" });
      claimed("q-nbsp", { summary: "\u00a0\u00a0", body: "NBSP body" });
      claimed("q-tab", { summary: "\t\t", body: "TAB body" });
      claimed("q-mixed", { summary: " \t\u00a0\r\n\u2003\ufeff", body: "MIXED body" });
      const rows = repo.listRecentTransitions("rig-a");
      expect(reads.sort()).toEqual(["EMPTY body", "MIXED body", "NBSP body", "NULL body", "TAB body"]);
      expect(Object.fromEntries(rows.map((row) => [row.qitemId, row.bodyPreview]))).toEqual({
        "q-authored": null, "q-padded": null,
        "q-null": "NULL body", "q-empty": "EMPTY body", "q-nbsp": "NBSP body", "q-tab": "TAB body", "q-mixed": "MIXED body",
      });
    });

    it("ends the preview at an embedded NUL, and gives none when the NUL comes before any text", () => {
      claimed("q-nul-late", { summary: null, body: "Review the restore\u0000 path\nnext" });
      claimed("q-nul-first", { summary: null, body: "\u0000Review the restore path" });
      claimed("q-nul-after-blank", { summary: null, body: "\n  \u0000Review the restore path" });
      expect(entry("q-nul-late").bodyPreview).toBe("Review the restore");
      expect(entry("q-nul-first").bodyPreview).toBeNull();
      expect(entry("q-nul-after-blank").bodyPreview).toBeNull();
    });

    it("does not let the body change what the event is, and the route serves the same entries", async () => {
      claimed("q-words", { summary: null, body: "Completed, denied, failed and canceled" });
      const [row] = repo.listRecentTransitions("rig-a");
      expect(row).toMatchObject({ qitemId: "q-words", change: "claimed", targetKind: "qitem", target: "q-words", summary: null, bodyPreview: "Completed, denied, failed and canceled" });
      const response = await app.request("/api/queue/recent-transitions?rig=rig-a");
      expect(await response.json()).toEqual([row]);
    });
  });

  it("qualifies complete live/archive histories before selecting the newest twenty", () => {
    migrate(db, [queueTransitionsArchiveSchema]);
    repo = new QueueRepository(db, new EventBus(db));
    const archived = db.prepare(`INSERT INTO queue_transitions_archive
      (transition_id, qitem_id, ts, state, actor_session, archived_at)
      VALUES (?, ?, ?, ?, 'owner@rig-a', '2026-09-01')`);
    const live = db.prepare(`INSERT INTO queue_transitions
      (transition_id, qitem_id, ts, state, actor_session)
      VALUES (?, ?, ?, ?, 'owner@rig-a')`);
    for (let index = 0; index < 25; index += 1) {
      const id = `history-${index}`;
      item(id, "rig-a", "in-progress", ["slice:history"], { summary: `  Item ${index}  ` });
      // ID, not timestamp, defines the predecessor, even across storage tables.
      archived.run(index + 1, id, "2026-12-01", "pending");
      (index % 2 === 0 ? live : archived).run(index + 101, id, "2026-09-02", "in-progress");
      for (let note = 0; note < 30; note += 1) {
        live.run(1001 + note * 25 + index, id, "2026-10-01", "in-progress");
      }
    }
    item("foreign", "rig-b", "failed");
    live.run(5000, "foreign", "2027-01-01", "failed");

    const rows = repo.listRecentTransitions("rig-a");
    expect(rows.map((row) => row.transitionId)).toEqual(Array.from({ length: 20 }, (_, i) => 106 + i));
    expect(rows.map((row) => row.summary)).toEqual(Array.from({ length: 20 }, (_, i) => `Item ${i + 5}`));
    expect(rows.every((row) => row.change === "claimed" && row.target === "history" && row.rig === "rig-a")).toBe(true);
    expect(repo.listRecentTransitions("rig-a", 1).map((row) => row.transitionId)).toEqual([125]);
    expect(repo.listRecentTransitions("rig-b").map((row) => row.transitionId)).toEqual([5000]);
  });

  it("orders by timestamp then ID while deriving state from interleaved ID order", () => {
    migrate(db, [queueTransitionsArchiveSchema]);
    repo = new QueueRepository(db, new EventBus(db));
    for (const id of ["a", "b", "c"]) item(id, "rig-a", "in-progress");
    const add = (id: number, qitem: string, ts: string, state: string, archive = false) => {
      db.prepare(`INSERT INTO ${archive ? "queue_transitions_archive" : "queue_transitions"}
        (transition_id, qitem_id, ts, state, actor_session${archive ? ", archived_at" : ""})
        VALUES (?, ?, ?, ?, 'owner@rig-a'${archive ? ", '2026-09-01'" : ""})`).run(id, qitem, ts, state);
    };
    add(1, "a", "2099-01-01", "pending", true);
    add(2, "b", "2020-01-01", "pending");
    add(3, "a", "2023-01-01", "blocked");
    add(4, "b", "2025-01-01", "in-progress", true);
    add(5, "a", "2022-01-01", "in-progress");
    add(6, "a", "2030-01-01", "in-progress");
    // Same-state terminal events are still qualifying under the existing allowlist.
    add(7, "c", "2026-01-01", "failed", true);
    add(8, "c", "2026-01-01", "failed");

    expect(repo.listRecentTransitions("rig-a").map((row) => [row.transitionId, row.change])).toEqual([
      [5, "resumed"], [3, "blocked"], [4, "claimed"], [7, "failed"], [8, "failed"],
    ]);
  });

  it("walks past a long same-state blocked run without counting it", () => {
    item("q-parked", "rig-a", "blocked");
    transition("q-parked", "pending");
    transition("q-parked", "blocked", { reason: "blocked_on", target: "external:ci" });
    for (let note = 0; note < 40; note += 1) transition("q-parked", "blocked", { note: `still waiting ${note}` });
    item("q-old", "rig-a", "in-progress");
    db.prepare(`INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session)
      VALUES (?, 'q-old', '2026-09-03T19:00:00.000Z', ?, 'owner@rig-a')`).run(nextTransitionId++, "pending");
    db.prepare(`INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session)
      VALUES (?, 'q-old', '2026-09-03T19:01:00.000Z', ?, 'owner@rig-a')`).run(nextTransitionId++, "in-progress");

    expect(repo.listRecentTransitions("rig-a", 20).map((row) => [row.qitemId, row.change])).toEqual([
      ["q-old", "claimed"], ["q-parked", "blocked on external:ci"],
    ]);
    expect(repo.listRecentTransitions("rig-a", 1).map((row) => row.qitemId)).toEqual(["q-parked"]);
  });

  it("selects what the full-history window query selected, across live and archived history", () => {
    migrate(db, [queueTransitionsArchiveSchema]);
    repo = new QueueRepository(db, new EventBus(db));
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r-a', 'rig-a'), ('r-b', 'rig-b')").run();
    let seed = 20261015;
    const random = () => { // mulberry32
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const states = ["pending", "in-progress", "in-progress", "blocked", "blocked", "done", "failed", "canceled", "handed-off"];
    let id = 1;
    for (let index = 0; index < 60; index += 1) {
      const rig = index % 7 === 0 ? "rig-c" : index % 2 === 0 ? "rig-a" : "rig-b";
      item(`gen-${index}`, rig, "in-progress");
      const steps = 1 + Math.floor(random() * 12);
      for (let step = 0; step < steps; step += 1) {
        const state = step === 0 ? "pending" : states[Math.floor(random() * states.length)]!;
        const reason = state === "handed-off" ? "handed_off_to" : state === "done" ? "no-follow-on"
          : state === "blocked" && random() < 0.3 ? "escalation" : null;
        // Coarse minutes make ts ties; a few steps go back in time; early ids land in the archive.
        const ts = `2026-09-03T${String(10 + Math.floor(random() * 12)).padStart(2, "0")}:${String(Math.floor(random() * 4) * 15).padStart(2, "0")}:00.000Z`;
        const table = id < 180 && random() < 0.6 ? "queue_transitions_archive" : "queue_transitions";
        db.prepare(`INSERT INTO ${table} (transition_id, qitem_id, ts, state, actor_session, closure_reason, closure_target${table === "queue_transitions_archive" ? ", archived_at" : ""})
          VALUES (?, ?, ?, ?, ?, ?, ?${table === "queue_transitions_archive" ? ", '2026-09-01'" : ""})`)
          .run(id, `gen-${index}`, ts, state, `owner@${rig}`, reason, reason === "handed_off_to" ? `next@${rig}` : null);
        id += 1;
      }
    }
    // The selection the released query made: LAG over each item's full live+archive history, then the newest N.
    const windowed = (patterns: string[], limit: number) => db.prepare(`
      WITH h AS (
        SELECT t.transition_id, t.ts, t.state, t.closure_reason,
               LAG(t.state) OVER (PARTITION BY t.qitem_id ORDER BY t.transition_id) AS previous_state
        FROM (SELECT transition_id, qitem_id, ts, state, closure_reason FROM queue_transitions
              UNION ALL SELECT transition_id, qitem_id, ts, state, closure_reason FROM queue_transitions_archive) t
        JOIN queue_items q ON q.qitem_id = t.qitem_id
        WHERE ${patterns.map(() => "(q.destination_session LIKE ? ESCAPE '\\' OR q.source_session LIKE ? ESCAPE '\\')").join(" OR ")}
      )
      SELECT transition_id FROM h
      WHERE (state = 'in-progress' AND previous_state IN ('pending', 'blocked'))
         OR (state = 'blocked' AND previous_state IS NOT NULL AND previous_state <> 'blocked')
         OR closure_reason = 'handed_off_to' OR (state = 'done' AND closure_reason = 'no-follow-on')
         OR state IN ('failed', 'denied', 'canceled') OR closure_reason IN ('denied', 'canceled', 'escalation')
      ORDER BY ts DESC, transition_id DESC LIMIT ?
    `).all(...patterns.flatMap((pattern) => [pattern, pattern]), limit).map((row) => (row as { transition_id: number }).transition_id).reverse();

    for (const limit of [1, 7, 20]) {
      expect(repo.listRecentTransitions("rig-a", limit).map((row) => row.transitionId)).toEqual(windowed(["%@rig-a"], limit));
      const log = new QueueTransitionLog(db);
      expect(log.listRecent({ kind: "instance" }, limit).map((row) => row.transitionId)).toEqual(windowed(["%@rig-a", "%@rig-b"], limit));
    }
  });

  it("resolves the scope from the session and primary-key indexes, never from queue_items' rows", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r-a', 'rig-a'), ('r-b', 'rig-b')").run();
    item("q-a", "rig-a", "in-progress");
    transition("q-a", "pending");
    transition("q-a", "in-progress");
    const original = db.prepare;
    const walks: string[] = [];
    db.prepare = function(sql: string) {
      if (sql.includes("scope_rows")) walks.push(sql);
      return original.call(this, sql);
    } as typeof db.prepare;
    try {
      expect(repo.listRecentTransitions("rig-a")).toHaveLength(1);
      expect(new QueueTransitionLog(db).listRecent({ kind: "instance" }, 20)).toHaveLength(1);
    } finally { db.prepare = original; }
    expect(walks).toHaveLength(2);
    for (const sql of walks) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) ?? []).length).fill("%@rig-a")) as Array<{ detail: string }>)
        .map((row) => row.detail);
      const itemReads = plan.filter((detail) => /^(SCAN|SEARCH) q\b/.test(detail));
      expect(itemReads.sort()).toEqual([
        "SCAN q USING COVERING INDEX idx_queue_items_destination_state",
        "SCAN q USING COVERING INDEX idx_queue_items_source",
        "SCAN q USING COVERING INDEX sqlite_autoindex_queue_items_1",
      ]);
    }
  });

  it("returns only the newest 20 qualifying transitions and refuses an unscoped read", async () => {
    for (let index = 0; index < 24; index += 1) {
      const id = `q-${String(index).padStart(2, "0")}`;
      item(id, "rig-a", "in-progress");
      transition(id, "pending");
      transition(id, "in-progress");
    }

    const rows = repo.listRecentTransitions("rig-a", 999);
    expect(rows).toHaveLength(20);
    expect(rows[0]?.qitemId).toBe("q-04");
    expect(rows.at(-1)?.qitemId).toBe("q-23");

    const response = await app.request("/api/queue/recent-transitions");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "rig_required" });
  });

  it("serves one bounded instance chronology across active local rigs", async () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?), (?, ?)")
      .run("r-a", "rig-a", "r-b", "rig-b");
    db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES (?, ?, ?)")
      .run("r-archived", "rig-archived", "2026-09-03T23:59:00.000Z");
    item("q-a", "rig-a", "in-progress", ["mission:m-a"]);
    transition("q-a", "pending", { actor: "sender@rig-a" });
    transition("q-a", "in-progress", { actor: "owner@rig-a" });
    item("q-b", "rig-b", "done", ["slice:OPR.0.5.9.12"]);
    transition("q-b", "pending", { actor: "sender@rig-b" });
    transition("q-b", "in-progress", { actor: "owner@rig-b" });
    transition("q-b", "done", { actor: "owner@rig-b", reason: "no-follow-on" });
    item("q-foreign", "rig-c", "in-progress");
    transition("q-foreign", "pending", { actor: "sender@rig-c" });
    transition("q-foreign", "in-progress", { actor: "owner@rig-c" });
    item("q-archived", "rig-archived", "in-progress");
    transition("q-archived", "pending", { actor: "sender@rig-archived" });
    transition("q-archived", "in-progress", { actor: "owner@rig-archived" });

    const response = await app.request("/api/queue/recent-transitions?scope=instance&limit=20");
    expect(response.status).toBe(200);
    const rows = await response.json() as Array<{ qitemId: string; rig: string; change: string }>;
    expect(rows).toEqual([
      expect.objectContaining({ qitemId: "q-a", rig: "rig-a", change: "claimed" }),
      expect.objectContaining({ qitemId: "q-b", rig: "rig-b", change: "claimed" }),
      expect.objectContaining({ qitemId: "q-b", rig: "rig-b", change: "completed" }),
    ]);
  });
});
