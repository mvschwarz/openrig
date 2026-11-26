// #3616 — the one writer for a slice's planned owners and edges and a mission's waves and status: only the named
// fields change, comments and other keys survive, a rerun writes nothing, and a file it can't parse is left as it is.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { readMissionStatus } from "../src/routes/missions.js";
import {
  ManifestEditError,
  clearPlannedOwner,
  editManifest,
  servedMissionStatus,
  setExecutionDependsOn,
  setPlannedOwner,
  setWave,
  writeMissionStatus,
} from "../src/domain/scope/manifest-editor.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-editor-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function file(name: string, text: string): string {
  const at = path.join(dir, name);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, text);
  return at;
}

const SLICE = `# Reporter's slice
schema: openrig.slice/v0alpha1
kind: slice
description: a long plain line, as people write them, that runs well past eighty characters and must not be folded
composition:
  mission: ../../mission.yaml
sdlc:
  components:
    - id: build # the builder
      owner: dev-impl@lab
      notes: keep me
execution:
  gates: [external:design-review] # the reporter's own extension
`;

describe("editManifest", () => {
  it("changes only the named field, keeping comments, order and unknown keys, and a rerun writes nothing", () => {
    const at = file("slice.yaml", SLICE);
    expect(editManifest(at, (doc) => setPlannedOwner(doc, "build", "dev-qa@lab"))).toBe("written");
    const written = fs.readFileSync(at, "utf8");
    expect(written).toBe(SLICE.replace("owner: dev-impl@lab", "owner: dev-qa@lab"));
    const mtime = fs.statSync(at).mtimeMs;
    expect(editManifest(at, (doc) => setPlannedOwner(doc, "build", "dev-qa@lab"))).toBe("unchanged");
    expect(fs.readFileSync(at, "utf8")).toBe(written);
    expect(fs.statSync(at).mtimeMs).toBe(mtime);
    expect(fs.readdirSync(dir)).toEqual(["slice.yaml"]); // no temporary file left behind
  });

  it("writes flow collections padded or not as the file's own are", () => {
    const padded = file("padded.yaml", "kind: slice\nsdlc:\n  components:\n    - { id: build, owner: a@b }\nexecution:\n  gates: [ x ]\n");
    editManifest(padded, (doc) => setExecutionDependsOn(doc, ["OPR.1.0.0.1"]));
    expect(fs.readFileSync(padded, "utf8")).toBe("kind: slice\nsdlc:\n  components:\n    - { id: build, owner: a@b }\nexecution:\n  gates: [ x ]\n  depends_on: [ OPR.1.0.0.1 ]\n");
    const tight = file("tight.yaml", "kind: slice\nexecution:\n  depends_on: [\"OPR.1.0.0.1\"]\n");
    editManifest(tight, (doc) => setPlannedOwner(doc, "build", "a@b"));
    expect(fs.readFileSync(tight, "utf8")).toBe("kind: slice\nexecution:\n  depends_on: [\"OPR.1.0.0.1\"]\nsdlc:\n  components:\n    - id: build\n      owner: a@b\n");
  });

  it("leaves a file it can't parse exactly as it was, and names it", () => {
    const broken = "sdlc:\n  components: [unclosed\n";
    const at = file("slice.yaml", broken);
    expect(() => editManifest(at, (doc) => setPlannedOwner(doc, "build", "x@y"))).toThrow(ManifestEditError);
    expect(() => editManifest(at, (doc) => setPlannedOwner(doc, "build", "x@y"))).toThrow(`${at}: it can't be parsed`);
    expect(fs.readFileSync(at, "utf8")).toBe(broken);
  });

  it("leaves the file alone when a field it would write through isn't a collection", () => {
    const text = "kind: slice\nsdlc: none\n";
    const at = file("slice.yaml", text);
    expect(() => editManifest(at, (doc) => setPlannedOwner(doc, "build", "x@y"))).toThrow(ManifestEditError);
    expect(fs.readFileSync(at, "utf8")).toBe(text);
  });
});

describe("planned owners and build-order edges (slice.yaml)", () => {
  it("adds a component that isn't there, and clears only an owner", () => {
    const at = file("slice.yaml", SLICE);
    editManifest(at, (doc) => setPlannedOwner(doc, "review", "dev-review@lab"));
    expect(YAML.parse(fs.readFileSync(at, "utf8")).sdlc.components).toEqual([
      { id: "build", owner: "dev-impl@lab", notes: "keep me" }, { id: "review", owner: "dev-review@lab" },
    ]);
    let cleared: boolean[] = [];
    editManifest(at, (doc) => { cleared = [clearPlannedOwner(doc, "build"), clearPlannedOwner(doc, "absent")]; });
    expect(cleared).toEqual([true, false]);
    expect(YAML.parse(fs.readFileSync(at, "utf8")).sdlc.components[0]).toEqual({ id: "build", notes: "keep me" });
    expect(fs.readFileSync(at, "utf8")).toContain("- id: build # the builder");
  });

  it("creates sdlc.components when the slice has none", () => {
    const at = file("slice.yaml", "kind: slice\n");
    editManifest(at, (doc) => setPlannedOwner(doc, "build", "dev-impl@lab"));
    expect(YAML.parse(fs.readFileSync(at, "utf8"))).toEqual({ kind: "slice", sdlc: { components: [{ id: "build", owner: "dev-impl@lab" }] } });
  });

  it("sets and clears execution.depends_on beside the reporter's own execution keys", () => {
    const at = file("slice.yaml", SLICE);
    editManifest(at, (doc) => setExecutionDependsOn(doc, ["OPR.1.0.0.1", "OPR.1.0.0.2"]));
    expect(fs.readFileSync(at, "utf8")).toContain("depends_on: [OPR.1.0.0.1, OPR.1.0.0.2]");
    expect(YAML.parse(fs.readFileSync(at, "utf8")).execution).toEqual({ gates: ["external:design-review"], depends_on: ["OPR.1.0.0.1", "OPR.1.0.0.2"] });
    editManifest(at, (doc) => setExecutionDependsOn(doc, null));
    expect(fs.readFileSync(at, "utf8")).toBe(SLICE);
  });

  it("removes an execution mapping that clearing leaves empty", () => {
    const at = file("slice.yaml", "kind: slice\nexecution:\n  depends_on: [\"OPR.1.0.0.1\"]\n");
    editManifest(at, (doc) => setExecutionDependsOn(doc, null));
    expect(fs.readFileSync(at, "utf8")).toBe("kind: slice\n");
  });
});

describe("waves (mission.yaml arrangement.waves)", () => {
  const MISSION = `kind: mission
arrangement:
  waves:
    - id: w1
      slices: [OPR.1.0.0.1]
      review_model: claude # keep the review model
    - id: w2
      lanes:
        ui: [OPR.1.0.0.3]
        api: [OPR.1.0.0.4]
`;

  it("adds a wave, and replaces a wave's slices keeping its other keys and the other waves", () => {
    const at = file("mission.yaml", MISSION);
    let conflicts: Array<string | undefined> = [];
    editManifest(at, (doc) => {
      conflicts = [setWave(doc, "w1", ["OPR.1.0.0.1", "OPR.1.0.0.2"]).shapeConflict, setWave(doc, "w3", ["OPR.1.0.0.5"]).shapeConflict];
    });
    expect(conflicts).toEqual([undefined, undefined]);
    const waves = YAML.parse(fs.readFileSync(at, "utf8")).arrangement.waves;
    expect(waves).toEqual([
      { id: "w1", slices: ["OPR.1.0.0.1", "OPR.1.0.0.2"], review_model: "claude" },
      { id: "w2", lanes: { ui: ["OPR.1.0.0.3"], api: ["OPR.1.0.0.4"] } },
      { id: "w3", slices: ["OPR.1.0.0.5"] },
    ]);
    expect(fs.readFileSync(at, "utf8")).toContain("review_model: claude # keep the review model");
  });

  it("sets one lane of a lane-shaped wave, and never writes a slices list beside its lanes", () => {
    const at = file("mission.yaml", MISSION);
    let conflict: string | undefined;
    expect(editManifest(at, (doc) => { conflict = setWave(doc, "w2", ["OPR.1.0.0.9"]).shapeConflict; })).toBe("unchanged");
    expect(conflict).toBe("Wave w2 is lane-shaped (lanes: ui, api), and a slices list beside them would hide them.");
    expect(fs.readFileSync(at, "utf8")).toBe(MISSION);
    editManifest(at, (doc) => { conflict = setWave(doc, "w2", ["OPR.1.0.0.9"], "api").shapeConflict; });
    expect(conflict).toBeUndefined();
    expect(YAML.parse(fs.readFileSync(at, "utf8")).arrangement.waves[1]).toEqual({ id: "w2", lanes: { ui: ["OPR.1.0.0.3"], api: ["OPR.1.0.0.9"] } });
  });

  it("never turns a slices wave into a lane-shaped one", () => {
    const at = file("mission.yaml", MISSION);
    let conflict: string | undefined;
    expect(editManifest(at, (doc) => { conflict = setWave(doc, "w1", ["OPR.1.0.0.9"], "ui").shapeConflict; })).toBe("unchanged");
    expect(conflict).toBe("Wave w1 lists its slices directly, not in lanes.");
  });

  it("starts arrangement.waves in a mission that has none, with a lane-shaped wave when asked", () => {
    const at = file("mission.yaml", "kind: mission\n");
    editManifest(at, (doc) => setWave(doc, "w1", ["OPR.1.0.0.1"], "ui"));
    expect(YAML.parse(fs.readFileSync(at, "utf8"))).toEqual({ kind: "mission", arrangement: { waves: [{ id: "w1", lanes: { ui: ["OPR.1.0.0.1"] } }] } });
  });
});

describe("mission status", () => {
  it("writes metadata.status keeping its comment, reads back what readiness serves, and a rerun writes nothing", () => {
    const missionPath = path.join(dir, "m1");
    const manifest = "kind: mission\nmetadata:\n  name: m1\n  status: planned # until the build starts\ncomposition:\n  slices: []\n";
    file("m1/mission.yaml", manifest);
    expect(writeMissionStatus(missionPath, "active")).toBe("written");
    expect(fs.readFileSync(path.join(missionPath, "mission.yaml"), "utf8")).toBe(manifest.replace("status: planned", "status: active"));
    expect(servedMissionStatus(missionPath)).toEqual({ status: "active", countsTowardReadiness: true });
    expect(writeMissionStatus(missionPath, "active")).toBe("unchanged");
    writeMissionStatus(missionPath, "paused");
    expect(servedMissionStatus(missionPath)).toEqual({ status: "paused", countsTowardReadiness: false });
  });

  it("writes a legacy mission's node-file status, and a rerun writes nothing", () => {
    const missionPath = path.join(dir, "legacy");
    file("legacy/README.md", "---\nid: OPR.9\nstatus: planned\n---\n# Legacy\n");
    expect(writeMissionStatus(missionPath, "active")).toBe("written");
    expect(fs.readFileSync(path.join(missionPath, "README.md"), "utf8")).toBe("---\nid: OPR.9\nstatus: active\n---\n# Legacy\n");
    expect(writeMissionStatus(missionPath, "active")).toBe("unchanged");
    expect(servedMissionStatus(missionPath)).toEqual({ status: "active", countsTowardReadiness: false });
  });

  it("quotes a legacy status that YAML would misread, so the node file's YAML readers still parse it", () => {
    const missionPath = path.join(dir, "legacy");
    file("legacy/README.md", "---\nid: OPR.9\nstatus: planned\n---\n# Legacy\n");
    expect(writeMissionStatus(missionPath, "blocked: waiting on 0.7.24")).toBe("written");
    const text = fs.readFileSync(path.join(missionPath, "README.md"), "utf8");
    expect(text).toBe("---\nid: OPR.9\nstatus: \"blocked: waiting on 0.7.24\"\n---\n# Legacy\n");
    expect(YAML.parse(text.split("---\n")[1]!)).toEqual({ id: "OPR.9", status: "blocked: waiting on 0.7.24" });
    expect(servedMissionStatus(missionPath).status).toBe("blocked: waiting on 0.7.24");
    expect(writeMissionStatus(missionPath, "blocked: waiting on 0.7.24")).toBe("unchanged");
  });

  it("writes `$` patterns in a legacy status, and in the rest of the frontmatter, as they are", () => {
    const missionPath = path.join(dir, "legacy");
    file("legacy/README.md", "---\nid: OPR.9\nintent: saves $$ and $' each run\nstatus: planned\n---\n# Legacy\n");
    expect(writeMissionStatus(missionPath, "cost $& more")).toBe("written");
    expect(fs.readFileSync(path.join(missionPath, "README.md"), "utf8"))
      .toBe("---\nid: OPR.9\nintent: saves $$ and $' each run\nstatus: cost $& more\n---\n# Legacy\n");
    expect(writeMissionStatus(missionPath, "cost $& more")).toBe("unchanged");
  });

  it("writes only a legacy node file's top-level status: an empty one keeps the next field, a nested one stays", () => {
    const missionPath = path.join(dir, "legacy");
    const readme = path.join(missionPath, "README.md");
    file("legacy/README.md", "---\nstatus:\nid: OPR.9\n---\n# Legacy\n");
    expect(writeMissionStatus(missionPath, "active")).toBe("written");
    expect(fs.readFileSync(readme, "utf8")).toBe("---\nstatus: active\nid: OPR.9\n---\n# Legacy\n");
    file("legacy/README.md", "---\nid: OPR.9\nmetadata:\n  status: nested\nstatus: planned\n---\n# Legacy\n");
    expect(writeMissionStatus(missionPath, "active")).toBe("written");
    expect(fs.readFileSync(readme, "utf8")).toBe("---\nid: OPR.9\nmetadata:\n  status: nested\nstatus: active\n---\n# Legacy\n");
    expect(servedMissionStatus(missionPath).status).toBe("active");
  });

  it("keeps a legacy status YAML would write as a block on its one line, so a rerun writes nothing", () => {
    const missionPath = path.join(dir, "legacy");
    file("legacy/README.md", "---\nid: OPR.9\nstatus: planned\n---\n# Legacy\n");
    expect(writeMissionStatus(missionPath, "---")).toBe("written");
    expect(fs.readFileSync(path.join(missionPath, "README.md"), "utf8")).toBe("---\nid: OPR.9\nstatus: \"---\"\n---\n# Legacy\n");
    expect(writeMissionStatus(missionPath, "---")).toBe("unchanged");
    expect(servedMissionStatus(missionPath).status).toBe("---");
  });
});


describe("QA: legacy YAML status edits and ambiguous wave shapes", () => {
  it.each(["|", ">"])("replaces a legacy block status without leaving its continuation: %s", style => {
    const missionPath = path.join(dir, "legacy");
    const original = `---\nid: OPR.9\nstatus: ${style} # old label\n  waiting on the builder\nnotes: keep me\n---\n# Legacy body\n`;
    const at = file("legacy/SPEC.md", original);
    expect(writeMissionStatus(missionPath, "active")).toBe("written");
    const text = fs.readFileSync(at, "utf8");
    expect(YAML.parse(text.split("---\n")[1]!)).toEqual({ id: "OPR.9", status: "active", notes: "keep me" });
    expect(text).toContain("# old label");
    expect(text.endsWith("---\n# Legacy body\n")).toBe(true);
    expect(writeMissionStatus(missionPath, "active")).toBe("unchanged");
  });

  it("edits a quoted top-level status once, retaining a nested status", () => {
    const missionPath = path.join(dir, "legacy");
    const at = file("legacy/SPEC.md", '---\n"status": planned\nmetadata:\n  status: nested\n---\n# Legacy\n');
    writeMissionStatus(missionPath, "active");
    expect(YAML.parse(fs.readFileSync(at, "utf8").split("---\n")[1]!)).toEqual({ status: "active", metadata: { status: "nested" } });
  });

  it.each(["status: [unterminated", "- planned\n- active"])("leaves unreadable or non-mapping legacy frontmatter untouched: %s", yaml => {
    const missionPath = path.join(dir, "legacy");
    const original = `---\n${yaml}\n---\n# Legacy\n`;
    const at = file("legacy/SPEC.md", original);
    expect(() => writeMissionStatus(missionPath, "active")).toThrow(ManifestEditError);
    expect(fs.readFileSync(at, "utf8")).toBe(original);
  });

  it.each(["[a, b]", "invalid", "{ ui: [one] }\n      slices: [old]"])("does not write slices beside an existing lanes field: %s", lanes => {
    const original = `arrangement:\n  waves:\n    - id: w1\n      lanes: ${lanes}\n`;
    const at = file("mission.yaml", original);
    let conflict: string | undefined;
    expect(editManifest(at, doc => { conflict = setWave(doc, "w1", ["new"]).shapeConflict; })).toBe("unchanged");
    expect(conflict).toBeTruthy();
    expect(fs.readFileSync(at, "utf8")).toBe(original);
  });
});


describe("QA: legacy status readers use the same YAML field as the writer", () => {
  it("does not rewrite the bytes or mtime of an already selected quoted status", () => {
    const missionPath = path.join(dir, "legacy");
    const original = '---\nstatus: "active" # retain author style\n---\n# Body\n';
    const at = file("legacy/SPEC.md", original);
    const before = fs.statSync(at).mtimeMs;
    expect(writeMissionStatus(missionPath, "active")).toBe("unchanged");
    expect(fs.readFileSync(at, "utf8")).toBe(original);
    expect(fs.statSync(at).mtimeMs).toBe(before);
  });

  it.each(['status: planned # keep this comment', '"status": planned\nmetadata:\n  status: nested'])("serves the newly written top-level word: %s", frontmatter => {
    const missionPath = path.join(dir, "legacy");
    file("legacy/SPEC.md", `---\n${frontmatter}\n---\n# Legacy\n`);
    writeMissionStatus(missionPath, "active");
    expect(YAML.parse(fs.readFileSync(path.join(missionPath, "SPEC.md"), "utf8").split("---\n")[1]!).status).toBe("active");
    expect(servedMissionStatus(missionPath).status).toBe("active");
    expect(readMissionStatus(missionPath)).toBe("active");
  });

  it("can add a status to an empty YAML header, and preserves an unterminated one", () => {
    const missionPath = path.join(dir, "legacy");
    const at = file("legacy/SPEC.md", "---\n---\n# Body\n");
    expect(writeMissionStatus(missionPath, "active")).toBe("written");
    expect(fs.readFileSync(at, "utf8")).toBe("---\nstatus: active\n---\n# Body\n");
    const incomplete = "---\nstatus: planned\n# no closing delimiter\n";
    fs.writeFileSync(at, incomplete);
    expect(() => writeMissionStatus(missionPath, "active")).toThrow(ManifestEditError);
    expect(fs.readFileSync(at, "utf8")).toBe(incomplete);
  });
});
