// VM-005 (release-0.4.7) — the authored mission-status sidecar (plan §C-ii),
// the mapStatus scaffold literal (§C-vi), and the LOCKSTEP pin between the
// indexer's sidecar read and routes/missions.ts readMissionStatus (the
// share-vs-copy decision is COPY; this test is the divergence fence).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { readMissionStatus } from "../src/routes/missions.js";

// The V6 frozen mission README frontmatter — byte-bound from the dogfood
// evidence root (fixture/README.md sha256 660068d4…e688262, packet
// V6-FROZEN-FIXTURE-PACKET-5d184b24.md sha256 274a24f9…04d1ed): a canonical
// WIP mission that declares stage/id/release and NO `status:` field. At base
// (8250d702) the explorer projected it as UNKNOWN.
const V6_FROZEN_README = `---
id: OPR.0.4.7
mission: release-0.4.7
release: 0.4.7
stage: wip
verified: 2026-07-10 against scaffold (rig scope create)
created: 2026-07-10
---

# Release 0.4.7 — Release 0.4.7

## Theme

[What this release is about — the coherent bet]
`;

let base: string;
let db: Database.Database;

function missionsRoot(): string {
  return path.join(base, "missions");
}

function writeMission(name: string, readme: string | null, slices: Record<string, string>): void {
  const dir = path.join(missionsRoot(), name);
  fs.mkdirSync(path.join(dir, "slices"), { recursive: true });
  if (readme !== null) fs.writeFileSync(path.join(dir, "README.md"), readme);
  for (const [sliceName, frontmatter] of Object.entries(slices)) {
    const sliceDir = path.join(dir, "slices", sliceName);
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "README.md"), frontmatter);
  }
}

function makeIndexer(): SliceIndexer {
  return new SliceIndexer({
    slicesRoot: missionsRoot(),
    dogfoodEvidenceRoot: null,
    db,
  });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "mission-status-sidecar-"));
  fs.mkdirSync(missionsRoot(), { recursive: true });
  db = createDb(":memory:");
  migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
});

afterEach(() => {
  db.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("missionAuthoredStatuses — the sidecar (C-ii)", () => {
  it("carries the raw authored word for a mission with README status", () => {
    writeMission("relx", "---\nstatus: complete\n---\n# Relx\n", {
      target: "---\nstatus: active\n---\n# Target\n",
    });
    const sidecar = makeIndexer().missionAuthoredStatuses();
    expect(sidecar["relx"]).toEqual({ authoredStatus: "complete" });
  });

  it("V6 frozen bytes: stage/wip frontmatter with NO status field → authoredStatus null", () => {
    writeMission("release-0.4.7", V6_FROZEN_README, {
      "some-slice": "---\nstatus: active\n---\n# S\n",
    });
    const sidecar = makeIndexer().missionAuthoredStatuses();
    expect(sidecar["release-0.4.7"]).toEqual({ authoredStatus: null });
  });

  it("missing README → null; missions with zero indexed slices never appear", () => {
    writeMission("no-readme", null, { s1: "---\nstatus: active\n---\n" });
    writeMission("zero-slices", "---\nstatus: complete\n---\n", {});
    const sidecar = makeIndexer().missionAuthoredStatuses();
    expect(sidecar["no-readme"]).toEqual({ authoredStatus: null });
    expect("zero-slices" in sidecar).toBe(false);
  });

  it("invalidate() drops the sidecar cache (a status edit lands after refresh)", () => {
    writeMission("m", "---\nstatus: active\n---\n", { s1: "---\nstatus: active\n---\n" });
    const indexer = makeIndexer();
    expect(indexer.missionAuthoredStatuses()["m"]).toEqual({ authoredStatus: "active" });
    fs.writeFileSync(path.join(missionsRoot(), "m", "README.md"), "---\nstatus: complete\n---\n");
    // cached: unchanged until invalidated
    expect(indexer.missionAuthoredStatuses()["m"]).toEqual({ authoredStatus: "active" });
    indexer.invalidate();
    expect(indexer.missionAuthoredStatuses()["m"]).toEqual({ authoredStatus: "complete" });
  });
});

describe("LOCKSTEP — indexer sidecar read ≡ routes/missions.ts readMissionStatus", () => {
  it("both reads agree on every fixture class (status word · V6 no-status · empty value · missing README)", () => {
    writeMission("with-status", "---\nstatus: complete\n---\n# M\n", { s1: "---\nstatus: active\n---\n" });
    writeMission("v6-frozen", V6_FROZEN_README, { s2: "---\nstatus: active\n---\n" });
    writeMission("empty-value", "---\nstatus:\ntitle: x\n---\n# M\n", { s3: "---\nstatus: active\n---\n" });
    writeMission("no-readme", null, { s4: "---\nstatus: active\n---\n" });

    const sidecar = makeIndexer().missionAuthoredStatuses();
    for (const mission of ["with-status", "v6-frozen", "empty-value", "no-readme"]) {
      const routeValue = readMissionStatus(path.join(missionsRoot(), mission));
      expect(sidecar[mission]?.authoredStatus ?? null).toBe(routeValue);
    }
  });
});

describe("mapStatus scaffold literal (C-vi, FR-3 mechanical half)", () => {
  it("status: placeholder classifies as draft (not the terminal-default active)", () => {
    writeMission("scaffolded", V6_FROZEN_README, {
      "fresh-slice": "---\nstatus: placeholder\n---\n# Fresh\n",
    });
    const entries = makeIndexer().list();
    const fresh = entries.find((e) => e.name === "fresh-slice");
    expect(fresh?.status).toBe("draft");
    expect(fresh?.rawStatus).toBe("placeholder");
  });

  it("the terminal default stays UNCHANGED: an unrecognized word still maps active (named follow-up)", () => {
    writeMission("m2", null, {
      "odd-slice": "---\nstatus: percolating\n---\n# Odd\n",
    });
    const entries = makeIndexer().list();
    expect(entries.find((e) => e.name === "odd-slice")?.status).toBe("active");
  });
});

describe("SliceListEntry byte-identity (C-ii carve)", () => {
  it("the slices array shape is untouched — the sidecar is additive", () => {
    writeMission("m3", "---\nstatus: complete\n---\n", { s9: "---\nstatus: active\n---\n# S9\n" });
    const entries = makeIndexer().list();
    const entry = entries.find((e) => e.name === "s9")!;
    // Pinned pre-change key set (8757593f SliceListEntry shape).
    expect(Object.keys(entry).sort()).toEqual(
      [
        "name",
        "missionId",
        "displayName",
        "railItem",
        "workflowSpec",
        "status",
        "rawStatus",
        "description",
        "qitemCount",
        "hasProofPacket",
        "lastActivityAt",
        "slicePath",
      ].sort(),
    );
  });
});
