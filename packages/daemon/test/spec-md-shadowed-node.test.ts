// Repairs to the SPEC.md compatibility change that is now in main.
//
// All three came from ONE mistake: putting SPEC.md at the FRONT of a list without asking what the
// list DOES with order. In a first-match-wins lookup, front means wins. In a later-wins merge it
// means LOSES. In a scan-everything loop it means the shadowed file gets read too. Same one-line
// change, three different meanings.
//
// This condition is LIVE on three nodes in this workspace today, so these are not hypotheticals.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";

let root: string;
let db: Database.Database;
let slicesRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-md-shadow-"));
  slicesRoot = path.join(root, "slices");
  fs.mkdirSync(slicesRoot, { recursive: true });
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function slice(name: string, files: Record<string, string>): void {
  const dir = path.join(slicesRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
}

const indexer = () => new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });

describe("repair 1 — the selected node file is not overwritten by the shadowed one", () => {
  it("takes the SPEC.md value when a stale README.md declares the same field", () => {
    slice("01-conflict", {
      "SPEC.md": "---\nslice: 01-conflict\ntitle: from-SPEC\nstatus: spec\n---\n\n# t\n",
      "README.md": "---\nslice: 01-conflict\ntitle: from-README-STALE\nstatus: shipped\n---\n\n# t\n",
    });
    const got = indexer().get("01-conflict");
    expect(got!.displayName).toBe("from-SPEC");
    expect(got!.rawStatus).toBe("spec");
  });

  it("still lets PROGRESS.md override as the lifecycle cursor", () => {
    slice("02-progress", {
      "SPEC.md": "---\nslice: 02-progress\nstatus: spec\n---\n\n# t\n",
      "PROGRESS.md": "---\nstatus: shipped\n---\n\n# p\n",
    });
    expect(indexer().get("02-progress")!.rawStatus).toBe("shipped");
  });

  it("keeps IMPLEMENTATION-PRD.md beneath the node file, exactly as it sat beneath README.md", () => {
    slice("03-prd", {
      "IMPLEMENTATION-PRD.md": "---\nslice: 03-prd\ntitle: from-PRD\n---\n\n# t\n",
      "SPEC.md": "---\nslice: 03-prd\ntitle: from-SPEC\n---\n\n# t\n",
    });
    expect(indexer().get("03-prd")!.displayName).toBe("from-SPEC");
  });

  it("leaves README-only slices exactly as they were", () => {
    slice("04-legacy", { "README.md": "---\nslice: 04-legacy\ntitle: legacy\nstatus: spec\n---\n\n# t\n" });
    expect(indexer().get("04-legacy")!.displayName).toBe("legacy");
  });
});

describe("repair 2 — the shadowed node file is not scanned a second time", () => {
  /** project() takes the indexed SliceRecord, not a name. */
  function acceptanceOf(name: string) {
    const idx = indexer();
    const record = idx.get(name);
    expect(record, `slice ${name} must index`).toBeTruthy();
    const projector = new SliceDetailProjector({ db, indexer: idx, workflowSpecCache: new WorkflowSpecCache(db) });
    return projector.project(record!).acceptance;
  }

  // POLLUTION, not duplication, is the observable form. Identical rows collapse under the existing
  // acceptance dedup, which is why an earlier version of this test passed against the defect. The
  // damage shows when the two files DISAGREE: the shadowed file's obligations leak in beside the
  // live ones, and the slice presents a contract its author never wrote.
  it("does not admit acceptance rows from the shadowed README.md", () => {
    slice("01-both", {
      "SPEC.md": "---\nslice: 01-both\ntitle: from-SPEC\n---\n\n# s\n\n## Proof contract\n\n- [ ] The live obligation.\n",
      "README.md": "---\nslice: 01-both\ntitle: stale\n---\n\n# r\n\n## Proof contract\n\n- [ ] A STALE obligation nobody promised.\n",
    });

    const items = acceptanceOf("01-both").items;
    expect(items.some((i) => i.text.includes("The live obligation"))).toBe(true);
    expect(items.some((i) => i.text.includes("STALE obligation"))).toBe(false);
    // And every row that IS present cites the file it actually came from.
    for (const i of items) expect(i.source.file).not.toBe("README.md");
  });

  it("still collapses a row the live node file and its PRD both declare", () => {
    slice("03-dedup", {
      "SPEC.md": "---\nslice: 03-dedup\n---\n\n# s\n\n## Proof contract\n\n- [ ] Shared obligation.\n",
      "IMPLEMENTATION-PRD.md": "---\nslice: 03-dedup\n---\n\n# p\n\n## Proof contract\n\n- [ ] Shared obligation.\n",
    });
    const rows = acceptanceOf("03-dedup").items.filter((i) => i.text.includes("Shared obligation"));
    expect(rows.length).toBe(1);
  });

  it("still collects acceptance rows for a README-only slice", () => {
    slice("02-legacy", { "README.md": "---\nslice: 02-legacy\n---\n\n# l\n\n## Proof contract\n\n- [ ] A legacy row.\n" });
    expect(acceptanceOf("02-legacy").items.some((i) => i.text.includes("A legacy row"))).toBe(true);
  });
});
