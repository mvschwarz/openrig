// SPEC.md is the authored contract file for a work node; README.md is the legacy name.
//
// The founder ruling renamed the chain file, and the product stopped being able to read its own
// work tree: `rig scope mission ls` DROPPED release-0.5.2, and `findMission` threw "contains no
// README.md" at a mission that was fully authored. Meanwhile ~59 dormant missions and every
// historical proof receipt are README-backed and must keep working untouched.
//
// So: SPEC.md wins when present, README.md still resolves when it is the only one, and nothing
// prompts a migration. Half of these tests exist to pin the legacy half — a fix that reads SPEC.md
// by breaking README.md would trade one silent drop for another.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findMission, findSlice, listMissions, listSlices } from "../src/lib/scope/scope-fs.js";

let root: string;

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

/** A mission directory whose authored file is `fileName`. */
function mission(name: string, fileName: string, frontmatter = ""): string {
  const dir = path.join(root, name);
  write(path.join(dir, fileName), `---\nid: OPR.9.9.9\n${frontmatter}---\n\n# ${name}\n`);
  return dir;
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "rig-spec-md-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("work-node resolution — SPEC.md first, README.md still valid", () => {
  it("lists a mission whose only authored file is SPEC.md", () => {
    mission("spec-only", "SPEC.md");
    expect(listMissions(root).map((m) => m.name)).toContain("spec-only");
  });

  it("resolves a SPEC.md-only mission instead of refusing it as undeclared", () => {
    mission("spec-only", "SPEC.md");
    // The exact failure orch-lead hit: a fully authored mission reported as not-a-mission.
    expect(() => findMission(root, "spec-only")).not.toThrow();
    expect(findMission(root, "spec-only").readmePath).toBe(path.join(root, "spec-only", "SPEC.md"));
  });

  it("still lists and resolves a README-only mission — no migration, no warning", () => {
    mission("legacy-only", "README.md");
    expect(listMissions(root).map((m) => m.name)).toContain("legacy-only");
    expect(findMission(root, "legacy-only").readmePath).toBe(path.join(root, "legacy-only", "README.md"));
  });

  it("prefers SPEC.md when both are present", () => {
    const dir = mission("both", "SPEC.md", "source: spec\n");
    write(path.join(dir, "README.md"), "---\nid: OPR.0.0.0\nsource: readme\n---\n\n# stale\n");
    const found = findMission(root, "both");
    expect(found.readmePath).toBe(path.join(dir, "SPEC.md"));
    // Precedence has to reach the PARSED CONTENT, not just the path — a resolver that returns the
    // right filename while frontmatter is still read from README is the same bug wearing a fix.
    expect(found.frontmatter["source"]).toBe("spec");
    expect(found.id).toBe("OPR.9.9.9");
  });

  it("reports a directory with neither file as undeclared, unchanged", () => {
    fs.mkdirSync(path.join(root, "not-a-mission"), { recursive: true });
    expect(listMissions(root).map((m) => m.name)).not.toContain("not-a-mission");
    expect(() => findMission(root, "not-a-mission")).toThrow();
  });

  it("lists a SPEC.md-only slice and parses its frontmatter", () => {
    const m = mission("m", "SPEC.md");
    write(path.join(m, "slices", "01-spec-slice", "SPEC.md"), "---\nid: OPR.9.9.9.1\nstatus: draft\n---\n\n# slice\n");
    const slices = listSlices(findMission(root, "m"), "active");
    const found = slices.find((s) => s.name === "01-spec-slice");
    expect(found).toBeDefined();
    expect(found!.id).toBe("OPR.9.9.9.1");
    expect(found!.status).toBe("draft");
    expect(found!.readmePath).toBe(path.join(m, "slices", "01-spec-slice", "SPEC.md"));
  });

  it("still resolves a README-only slice beside a SPEC-backed one", () => {
    const m = mission("m", "SPEC.md");
    write(path.join(m, "slices", "01-spec", "SPEC.md"), "---\nid: OPR.9.9.9.1\n---\n\n# a\n");
    write(path.join(m, "slices", "02-legacy", "README.md"), "---\nid: OPR.9.9.9.2\n---\n\n# b\n");
    const byName = new Map(listSlices(findMission(root, "m"), "active").map((s) => [s.name, s]));
    expect(byName.get("01-spec")!.readmePath).toBe(path.join(m, "slices", "01-spec", "SPEC.md"));
    expect(byName.get("02-legacy")!.readmePath).toBe(path.join(m, "slices", "02-legacy", "README.md"));
  });

  it("resolves a slice directly by path when it is SPEC.md-backed", () => {
    const m = mission("m", "SPEC.md");
    write(path.join(m, "slices", "01-spec", "SPEC.md"), "---\nid: OPR.9.9.9.1\n---\n\n# a\n");
    const slice = findSlice(root, path.join(m, "slices", "01-spec"));
    expect(slice.id).toBe("OPR.9.9.9.1");
    expect(slice.readmePath).toBe(path.join(m, "slices", "01-spec", "SPEC.md"));
  });
});
