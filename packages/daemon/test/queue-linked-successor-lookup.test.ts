// The stuck sweep's linked-successor index: read with indexes (no scan of the whole table), and loaded in pages the
// caller can yield between, with the same answers as the per-row hasLinkedSuccessor.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createLinkedSuccessorLookup, hasLinkedSuccessor, LINKED_SUCCESSOR_BUILD_SQL } from "../src/domain/queue-repository.js";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); });
afterEach(() => { db.close(); });

function insert(id: string, o: Record<string, string | null> = {}) {
  const cols = { ts_created: "2026-01-01T00:00:00.000Z", ts_updated: "2026-01-01T00:00:00.000Z", source_session: "a@r",
    destination_session: "b@r", state: "pending", tags: "[]", body: "b", ...o };
  db.prepare(`INSERT INTO queue_items(qitem_id, ${Object.keys(cols).join(", ")}) VALUES (?, ${Object.keys(cols).map(() => "?").join(", ")})`)
    .run(id, ...Object.values(cols));
}

/** Sources, successors by handed_off_from and by chain_of_record (several hops), rows with malformed or non-text chain
 *  values, and unrelated chain rows, interleaved in id order across pages. */
function fixture(): string[] {
  const sources: string[] = [];
  for (let i = 0; i < 30; i++) {
    const src = `qitem-s${String(i).padStart(3, "0")}`;
    sources.push(src);
    insert(src, { state: "done" });
    if (i % 3 === 0) insert(`qitem-h${String(i).padStart(3, "0")}`, { handed_off_from: src, destination_session: `seat-${i}@r` });
    if (i % 3 === 1) insert(`qitem-c${String(i).padStart(3, "0")}`, { chain_of_record: JSON.stringify(["qitem-x", src]), destination_session: `seat-${i}@r` });
    if (i % 5 === 0) insert(`qitem-m${String(i).padStart(3, "0")}`, { chain_of_record: "{not json", destination_session: `seat-${i}@r` });
    if (i % 7 === 0) insert(`qitem-n${String(i).padStart(3, "0")}`, { chain_of_record: JSON.stringify([7, { id: src }]), destination_session: `seat-${i}@r` });
  }
  for (let i = 0; i < 40; i++) insert(`qitem-u${String(i).padStart(3, "0")}`, { chain_of_record: JSON.stringify([`qitem-zz${i}`]) });
  insert("qitem-self", { handed_off_from: "qitem-self", chain_of_record: JSON.stringify(["qitem-self"]) });
  sources.push("qitem-self");
  return sources;
}
const targets = (i: number, src: string) => [`seat-${i}@r`, `qitem-h${String(i).padStart(3, "0")}`, `qitem-c${String(i).padStart(3, "0")}`,
  `qitem-m${String(i).padStart(3, "0")}`, `qitem-n${String(i).padStart(3, "0")}`, "b@r", src];

describe("createLinkedSuccessorLookup", () => {
  it("reads the successors through indexes: no statement of the build scans queue_items", () => {
    const ids = JSON.stringify(["qitem-a", "qitem-b"]);
    const plans = [
      [LINKED_SUCCESSOR_BUILD_SQL.byHandoff, [ids]],
      [LINKED_SUCCESSOR_BUILD_SQL.pageEnd, ["", 500]],
      [LINKED_SUCCESSOR_BUILD_SQL.page, ["", "qitem-z", ids]],
    ] as const;
    for (const [sql, params] of plans) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail);
      expect(plan.some((d) => /^SEARCH (s|queue_items) USING (COVERING )?INDEX idx_queue_items_/.test(d)), plan.join("\n")).toBe(true);
      expect(plan.filter((d) => /^SCAN (s|queue_items)\b/.test(d)), plan.join("\n")).toEqual([]);
    }
  });

  it("loaded in pages with a yield between them, answers as the per-row hasLinkedSuccessor does", async () => {
    const sources = fixture();
    const lookup = createLinkedSuccessorLookup(db, sources, { pageRows: 7 });
    let yields = 0;
    await lookup.load(async () => { yields++; await new Promise<void>((resolve) => setImmediate(resolve)); });
    expect(yields).toBe(Math.ceil(62 / 7)); // 62 rows with a chain_of_record
    sources.forEach((src, i) => {
      for (const target of targets(i, src)) expect(lookup.has(src, target), `${src} -> ${target}`).toBe(hasLinkedSuccessor(db, src, target));
    });
    expect(lookup.has("qitem-s000", "seat-0@r")).toBe(true);
    expect(lookup.has("qitem-s001", "qitem-c001")).toBe(true);
    expect(lookup.has("qitem-s014", "seat-14@r")).toBe(false); // a nested value never equals a text id
  });

  it("without load(), builds on its first has() with the same answers", () => {
    const sources = fixture();
    const lookup = createLinkedSuccessorLookup(db, sources, { pageRows: 7 });
    sources.forEach((src, i) => {
      for (const target of targets(i, src)) expect(lookup.has(src, target), `${src} -> ${target}`).toBe(hasLinkedSuccessor(db, src, target));
    });
  });
});
