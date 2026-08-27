// P15 — WRITER-EXCEEDS-ITS-OWNERSHIP fix (PM ruling, found at the 51-08 lock-verify):
// the approve stamp is sole-writer of its OWN keys but re-serialized the WHOLE
// frontmatter block (YAML.parse -> merge -> YAML.stringify), invalidating the very
// seal it certifies — seal-then-lock broke BY CONSTRUCTION. Append-only stamping:
// every byte the writer does not own is preserved verbatim.
// RED-first: the MONEY pin fails against the full-block rewriter.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { ScopeApproveService } from "../src/domain/scope/scope-approve.js";

// The 51-08 drift-instance shape: folded scalar, quoted strings, tab-free
// deliberate spacing, metacharacter-laden values ($, backrefs, regex chars) —
// everything a re-serializer normalizes and a naive replacement mangles.
const DRIFT_README = `---
id: OPR.0.5.1.8
slice: 51-08-token-telemetry-over-time
mission: release-0.5.1
status: spec
verified: >-
  2026-08-07 against scaffold (rig scope create) + the desk pin
  "062+ sequencing" — $VAR and \\1 backrefs ride along
created: 2026-08-07
tags: ["a b", 'c,d']
---

# Slice 51-08 — Per-agent token telemetry over time

## Intent

Body text with --- inside prose stays untouched.

## Proof contract

- [ ] One item — captured.
`;

const PRD = `---
id: OPR.0.5.1.8
---

## Mini-requirements

1. It works.

## Proof contract

- [ ] One item — captured.
`;

describe("P15 — append-only approve stamping (writer-exceeds-its-ownership fix)", () => {
  let db: Database.Database;
  let actionLog: MissionControlActionLog;
  let missionsRoot: string;
  let sliceDir: string;
  let readmePath: string;

  function service(): ScopeApproveService {
    return new ScopeApproveService({
      missionsRoot: () => missionsRoot,
      actionLog,
      now: () => new Date("2026-08-07T08:36:50.598Z"),
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema]);
    actionLog = new MissionControlActionLog(db);
    missionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p15-"));
    sliceDir = path.join(missionsRoot, "release-0.5.1", "slices", "51-08-token-telemetry-over-time");
    fs.mkdirSync(sliceDir, { recursive: true });
    readmePath = path.join(sliceDir, "README.md");
    fs.writeFileSync(readmePath, DRIFT_README);
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), PRD);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(missionsRoot, { recursive: true, force: true });
  });

  const specInput = {
    scopeTier: "slice" as const,
    scopePath: "release-0.5.1/slices/51-08-token-telemetry-over-time",
    approvalScope: "spec" as const,
    actorSession: "dev50-planner@v-openrig-build",
  };

  /** Textually remove ONLY the writer-owned lines: the approved-spec stamp pair
   *  and the plan-lock's locked-artifacts block (a top-level key + its indented
   *  continuation lines). Nothing else. */
  function stripOwned(content: string): string {
    return content
      .replace(/^approved-spec-by:[^\n]*\n/m, "")
      .replace(/^approved-spec-at:[^\n]*\n/m, "")
      .replace(/^locked-artifacts:[^\n]*\n(?:[ \t]+[^\n]*\n)*/m, "");
  }

  /** Replace the CURRENT writer-owned generation with the PRIOR one. A restamp
   *  does not mean "strip to author-pure": an amendment made after generation
   *  N has generation N in its pre-restamp bytes. The prior artifact is the
   *  source of those exact blocks; this helper merely performs the mechanical
   *  current -> prior substitution. */
  function restoreOwnedGeneration(current: string, prior: string): string {
    const keys = [
      "approved-spec-by",
      "approved-spec-at",
      "approved-spec-priors",
      "locked-artifacts",
      "provenance",
    ];
    const block = (content: string, key: string): string | null => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escaped}:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, "m").exec(content)?.[0] ?? null;
    };
    let restored = current;
    for (const key of keys) {
      const now = block(restored, key);
      const before = block(prior, key);
      if (now && before) restored = restored.slice(0, restored.indexOf(now)) + before + restored.slice(restored.indexOf(now) + now.length);
      else if (now) restored = restored.slice(0, restored.indexOf(now)) + restored.slice(restored.indexOf(now) + now.length + (restored[restored.indexOf(now) + now.length] === "\n" ? 1 : 0));
    }
    return restored;
  }

  it("MONEY (the 51-08 instance): stamp -> strip-owned-lines -> BYTE-IDENTICAL to the pre-stamp file", () => {
    const before = fs.readFileSync(readmePath, "utf8");
    service().approve(specInput);
    const after = fs.readFileSync(readmePath, "utf8");
    expect(after).not.toBe(before); // the stamp DID land
    expect(stripOwned(after)).toBe(before); // and touched NOTHING it does not own
  });

  it("the stamped file parses to the merged view: readers unchanged, folded scalar byte-verbatim, Lever A lands", () => {
    service().approve(specInput);
    const after = fs.readFileSync(readmePath, "utf8");
    const fm = YAML.parse(/^---\s*\n([\s\S]*?)\n---/.exec(after)![1]!) as Record<string, unknown>;
    expect(fm["approved-spec-by"]).toBe("dev50-planner@v-openrig-build");
    expect(fm["approved-spec-at"]).toBe("2026-08-07T08:36:50.598Z");
    expect(fm["id"]).toBe("OPR.0.5.1.8");
    expect(String(fm["verified"])).toContain("$VAR"); // survived byte-verbatim, still parseable
    expect(Array.isArray(fm["locked-artifacts"])).toBe(true); // the plan-lock co-write still lands
    expect(after).toContain('tags: ["a b", \'c,d\']'); // quoting style untouched
  });

  it("re-approve replaces ONLY its own keys in place: strip-owned still restores the original bytes", () => {
    const before = fs.readFileSync(readmePath, "utf8");
    service().approve(specInput);
    service().approve({ ...specInput, reApprove: true, reason: "amended after review" } as never);
    const after = fs.readFileSync(readmePath, "utf8");
    const fm = YAML.parse(/^---\s*\n([\s\S]*?)\n---/.exec(after)![1]!) as Record<string, unknown>;
    expect(fm["approved-spec-priors"]).toBe(1);
    const stripped = stripOwned(after).replace(/^approved-spec-priors:[^\n]*\n/m, "");
    expect(stripped).toBe(before);
  });

  it("S08 amendment cycle: current stamp generation mechanically restores the prior generation, including locked-artifacts.name", () => {
    service().approve({ ...specInput, lockedArtifacts: ["README.md"] });
    const firstGeneration = fs.readFileSync(readmePath, "utf8");
    expect(firstGeneration).toContain("locked-artifacts:\n  - name: README.md");

    // The amendment happens AFTER the first stamp, so its pre-restamp bytes
    // intentionally include generation 0. Re-approval re-derives the lock and
    // changes the nested name from the explicit path to the reader-facing label.
    const amendedBeforeRestamp = firstGeneration.replace(
      "Body text with --- inside prose stays untouched.",
      "Body text amended after generation zero stays untouched.",
    );
    fs.writeFileSync(readmePath, amendedBeforeRestamp);
    service().approve({
      ...specInput,
      actorSession: "orch-advisor@v-openrig-build",
      reApprove: true,
      reason: "amended after generation zero",
    });
    const secondGeneration = fs.readFileSync(readmePath, "utf8");
    expect(secondGeneration).toContain("locked-artifacts:\n  - name: Legacy specification");

    expect(restoreOwnedGeneration(secondGeneration, amendedBeforeRestamp)).toBe(amendedBeforeRestamp);
  });

  it("delivery approve on the already-spec-stamped file stays append-only too (two writers, zero drift)", () => {
    service().approve(specInput);
    const afterSpec = fs.readFileSync(readmePath, "utf8");
    service().approve({ ...specInput, approvalScope: "delivery" as const, actorSession: "dev50-qa@v-openrig-build" });
    const after = fs.readFileSync(readmePath, "utf8");
    const strippedDelivery = after
      .replace(/^approved-by:[^\n]*\n/m, "")
      .replace(/^approved-at:[^\n]*\n/m, "");
    expect(strippedDelivery).toBe(afterSpec);
  });
});
