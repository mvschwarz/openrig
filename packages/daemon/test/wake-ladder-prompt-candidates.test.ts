import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { REFUSED_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";
import { PROMPT_ALERT_TAG, PROMPT_REFUSAL_CANDIDATES_SQL, readPromptRefusalCandidates } from "../src/domain/queue-wake-ladder.js";
import { configureSyncSiteRecorder } from "../src/domain/sync-site-wrap.js";

// The candidate read the wake ladder used before it read from the open rows: every transition's note matched against
// the refusal prefix. Kept here as the oracle the new read must agree with, row for row. It has no ORDER BY, so its
// order is its plan's: on this schema, with no statistics, a scan of the transitions in id order, which is the order the
// new read makes explicit (each row's first refusal). These fixtures pin that observed order, not a guarantee.
const WHOLE_LOG_READ = `SELECT DISTINCT q.qitem_id, q.destination_session FROM queue_items q
    JOIN queue_transitions t ON t.qitem_id = q.qitem_id
    WHERE t.transition_note LIKE ? AND (q.state IN ('pending','in-progress','blocked') OR EXISTS (
      SELECT 1 FROM queue_items a WHERE a.state IN ('pending','in-progress','blocked')
      AND json_valid(a.tags) AND EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = ?)
      AND EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = 'recovery-for:' || q.qitem_id)))`;

describe("the wake ladder's prompt-refusal candidates", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); });
  afterEach(() => db.close());

  const row = (id: string, state: string, tags: string | null = null) => db.prepare(`INSERT INTO queue_items
      (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, tags)
      VALUES (?, '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z', 'source@rig', ?, ?, 'body', ?)`)
    .run(id, `${id}-seat@rig`, state, tags);
  const note = (id: string, text: string) => db.prepare(`INSERT INTO queue_transitions (qitem_id, ts, state, transition_note, actor_session)
      VALUES (?, '2026-11-12T00:00:00.000Z', 'pending', ?, 'source@rig')`).run(id, text);
  const refused = (id: string, detail = "the seat sits at a prompt") => note(id, `${REFUSED_PREFIX} ${detail}`);
  const alert = (id: string, state: string, ...recovers: unknown[]) => row(id, state, JSON.stringify([PROMPT_ALERT_TAG, ...recovers]));
  const wholeLog = () => db.prepare(WHOLE_LOG_READ).all(`${REFUSED_PREFIX}%`, PROMPT_ALERT_TAG);

  it("returns what the whole-log read returned, in the same order, across open, recovered and excluded rows", () => {
    row("q-z-open", "pending");
    row("q-a-open", "blocked", "[]");
    row("q-m-open-without-refusal", "in-progress");
    row("q-c-recovered", "done");
    row("q-d-closed", "done");
    row("q-e-recovered-by-closed-alert", "done");
    row("q-f-tagged-without-alert", "done");
    row("q-g-case-variant-tag", "done");
    row("q-h-case-variant-note", "pending");
    row("q-i-recovered-beside-other-values", "canceled");
    alert("q-alert-open", "pending", "recovery-for:q-c-recovered", "recovery-for:q-absent");
    alert("q-alert-closed", "done", "recovery-for:q-e-recovered-by-closed-alert");
    row("q-not-an-alert", "pending", JSON.stringify(["recovery-for:q-f-tagged-without-alert"]));
    alert("q-alert-case", "pending", "Recovery-For:q-g-case-variant-tag");
    row("q-malformed-tags", "pending", "[not json");
    alert("q-alert-mixed", "blocked", 5, { nested: "recovery-for:q-x" }, "recovery-for:q-i-recovered-beside-other-values");
    // Refusals in an order unlike the ids': the read is ordered by each row's first refusal.
    refused("q-c-recovered");
    refused("q-d-closed");
    refused("q-z-open");
    refused("q-e-recovered-by-closed-alert");
    refused("q-a-open");
    refused("q-f-tagged-without-alert");
    refused("q-a-open", "a second refusal");
    refused("q-g-case-variant-tag");
    note("q-h-case-variant-note", `${REFUSED_PREFIX.toUpperCase()} the seat sits at a prompt`);
    refused("q-i-recovered-beside-other-values");
    note("q-m-open-without-refusal", "an ordinary note");
    note("q-alert-open", "created");

    const read = readPromptRefusalCandidates(db);
    expect(read).toEqual(wholeLog());
    expect(read.map((candidate) => candidate.qitem_id)).toEqual(
      ["q-c-recovered", "q-z-open", "q-a-open", "q-h-case-variant-note", "q-i-recovered-beside-other-values"]);
    expect(read[1]).toEqual({ qitem_id: "q-z-open", destination_session: "q-z-open-seat@rig" });
  });

  // The create route accepts any string id, and text substr stops at a NUL, so a recovered id is cut as bytes.
  const withNul = "q-nul\u0000tail";

  it("keeps a recovered id with an embedded NUL selected", () => {
    row(withNul, "done");
    alert("q-alert-nul", "pending", `recovery-for:${withNul}`);
    refused(withNul);

    // The premise: the tag's JSON keeps the NUL, so the whole-log read found the whole id.
    expect(wholeLog()).toEqual([{ qitem_id: withNul, destination_session: `${withNul}-seat@rig` }]);
    expect(readPromptRefusalCandidates(db)).toEqual(wholeLog());
  });

  it("never borrows the row whose id equals a NUL-bearing recovered id's prefix", () => {
    row("q-nul", "done");
    alert("q-alert-nul", "pending", `recovery-for:${withNul}`);
    refused("q-nul");

    expect(wholeLog()).toEqual([]);
    expect(readPromptRefusalCandidates(db)).toEqual([]);
  });

  it("is empty when no row carries a refusal", () => {
    row("q-open", "pending");
    note("q-open", "an ordinary note");
    expect(readPromptRefusalCandidates(db)).toEqual([]);
    expect(wholeLog()).toEqual([]);
  });

  it("names its read in the slow-operation log, so a stall during it is attributed", () => {
    const sites: string[] = [];
    configureSyncSiteRecorder({ runSync<T>(site: string, fn: () => T): T { sites.push(site); return fn(); } });
    try { readPromptRefusalCandidates(db); } finally { configureSyncSiteRecorder(undefined); }
    expect(sites).toEqual(["queue.wake_ladder.prompt_candidates"]);
  });

  it("reads each candidate's own transitions through the qitem index, never the whole transition log", () => {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${PROMPT_REFUSAL_CANDIDATES_SQL}`)
      .all({ refused: `${REFUSED_PREFIX}%`, alertTag: PROMPT_ALERT_TAG }) as Array<{ detail: string }>).map((step) => step.detail);
    expect(plan.some((detail) => /^SEARCH t USING INDEX idx_queue_transitions_qitem/.test(detail))).toBe(true);
    expect(plan.filter((detail) => /^SCAN (t|queue_transitions)\b/.test(detail))).toEqual([]);
  });
});
