// release-0.3.2 slice 12 — scope-fs helpers + frontmatter parser tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ensureMissionId,
  findMission,
  findSlice,
  listMissions,
  listSlices,
  moveSlice,
  nextSliceNN,
  readFrontmatter,
  resolveMissionsRoot,
  splitFrontmatter,
  updateFrontmatter,
} from "../src/lib/scope/scope-fs.js";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-test-"));
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

describe("frontmatter parser", () => {
  it("returns {} when there is no frontmatter delimiter", () => {
    const { frontmatter, body } = splitFrontmatter("# heading\n\nbody");
    expect(frontmatter).toEqual({});
    expect(body).toBe("# heading\n\nbody");
  });

  it("parses simple key/value pairs", () => {
    const src = "---\nid: OPR.0.3.2.12\nstatus: active\n---\nbody";
    const { frontmatter, body } = splitFrontmatter(src);
    expect(frontmatter).toEqual({ id: "OPR.0.3.2.12", status: "active" });
    expect(body).toBe("body");
  });

  it("preserves unknown keys on update", () => {
    const dir = mktemp();
    const p = path.join(dir, "README.md");
    writeFile(p, "---\nstatus: active\ncustom: keep-me\n---\nbody\n");
    updateFrontmatter(p, { status: "shipped" });
    const fm = readFrontmatter(p);
    expect(fm.status).toBe("shipped");
    expect(fm.custom).toBe("keep-me");
  });

  it("generates minimal frontmatter when absent", () => {
    const dir = mktemp();
    const p = path.join(dir, "README.md");
    writeFile(p, "body only\n");
    updateFrontmatter(p, { id: "OPR.0.3.2" });
    const fm = readFrontmatter(p);
    expect(fm.id).toBe("OPR.0.3.2");
  });
});

describe("resolveMissionsRoot", () => {
  it("uses an explicit override path when present", () => {
    const root = mktemp();
    fs.mkdirSync(path.join(root, "missions"));
    expect(resolveMissionsRoot({ override: root })).toBe(path.join(root, "missions"));
  });

  it("throws ScopeCliError when no missions/ root is found", () => {
    const empty = mktemp();
    expect(() => resolveMissionsRoot({ override: empty, cwd: empty })).toThrow();
  });
});

describe("listMissions + listSlices + nextSliceNN", () => {
  let root: string;
  let missionsRoot: string;

  beforeEach(() => {
    root = mktemp();
    missionsRoot = path.join(root, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    // mission with 2 active + 1 closed slice
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "README.md"),
      "---\nid: OPR.0.3.2\n---\n# release-0.3.2\n",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "slices", "01-foo", "README.md"),
      "---\nid: OPR.0.3.2.1\nstatus: active\n---\nbody\n",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "slices", "02-bar", "README.md"),
      "---\nid: OPR.0.3.2.2\nstatus: active\n---\nbody\n",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "closed", "04-baz", "README.md"),
      "---\nid: OPR.0.3.2.4\nstatus: closed-stale\n---\nbody\n",
    );
    // mission with no README — should be skipped as "no slice count basis"
    fs.mkdirSync(path.join(missionsRoot, "no-readme"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists missions sorted by name with slice counts (HG-8)", () => {
    const missions = listMissions(missionsRoot);
    expect(missions.map((m) => m.name)).toEqual(["no-readme", "release-0.3.2"]);
    const r = missions.find((m) => m.name === "release-0.3.2")!;
    expect(r.activeSliceCount).toBe(2);
    expect(r.closedSliceCount).toBe(1);
    expect(r.id).toBe("OPR.0.3.2");
  });

  it("listSlices active filter excludes closed/shipped (HG-1)", () => {
    const mission = findMission(missionsRoot, "release-0.3.2");
    const active = listSlices(mission, "active");
    expect(active.map((s) => s.name).sort()).toEqual(["01-foo", "02-bar"]);
    const closed = listSlices(mission, "closed");
    expect(closed.map((s) => s.name)).toEqual(["04-baz"]);
  });

  it("nextSliceNN skips numbers already used in slices/ AND closed/ (HG-3)", () => {
    const missionAbs = path.join(missionsRoot, "release-0.3.2");
    // existing: 01, 02, 04 → next should be 5 (not 3 — numbers never reused).
    expect(nextSliceNN(missionAbs)).toBe(5);
  });
});

describe("findSlice + resolution variants", () => {
  let root: string;
  let missionsRoot: string;
  beforeEach(() => {
    root = mktemp();
    missionsRoot = path.join(root, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "README.md"),
      "---\nid: OPR.0.3.2\n---\nbody",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "slices", "07-target", "README.md"),
      "---\nid: OPR.0.3.2.7\nstatus: active\n---\nbody",
    );
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("resolves a mission-relative path with --mission hint", () => {
    const slice = findSlice(missionsRoot, "07-target", "release-0.3.2");
    expect(slice.name).toBe("07-target");
    expect(slice.id).toBe("OPR.0.3.2.7");
  });

  it("resolves an absolute path", () => {
    const abs = path.join(missionsRoot, "release-0.3.2", "slices", "07-target");
    const slice = findSlice(missionsRoot, abs);
    expect(slice.missionName).toBe("release-0.3.2");
  });

  it("3-part error when slice not found (HG-10)", () => {
    expect(() => findSlice(missionsRoot, "99-missing", "release-0.3.2")).toThrow(/not found/);
  });
});

describe("ensureMissionId", () => {
  let root: string;
  let missionsRoot: string;
  beforeEach(() => {
    root = mktemp();
    missionsRoot = path.join(root, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("returns existing frontmatter id when present", () => {
    writeFile(
      path.join(missionsRoot, "weird-name", "README.md"),
      "---\nid: OPR.99.0.7\n---\n",
    );
    const m = findMission(missionsRoot, "weird-name");
    expect(ensureMissionId(m, missionsRoot)).toBe("OPR.99.0.7");
  });

  it("derives from release-X.Y.Z pattern when no id present", () => {
    writeFile(path.join(missionsRoot, "release-0.4.0", "README.md"), "");
    const m = findMission(missionsRoot, "release-0.4.0");
    expect(ensureMissionId(m, missionsRoot)).toBe("OPR.0.4.0");
  });

  it("falls into escape band for non-release names", () => {
    writeFile(path.join(missionsRoot, "backlog", "README.md"), "");
    const m = findMission(missionsRoot, "backlog");
    const id = ensureMissionId(m, missionsRoot);
    expect(id).toMatch(/^OPR\.99\.0\.\d+$/);
  });
});

// ---------------------------------------------------------------------
// git mv path — uses real git in a tmp repo (HG-5, HG-11)
// ---------------------------------------------------------------------

function initRepo(root: string): void {
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Tester"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "init", "-q"], { stdio: "ignore" });
}

describe("moveSlice — git mv preserves history (HG-5) + refuses dirty tree (HG-11)", () => {
  let root: string;
  let missionsRoot: string;
  beforeEach(() => {
    root = mktemp();
    missionsRoot = path.join(root, "missions");
    initRepo(root);
    fs.mkdirSync(missionsRoot, { recursive: true });
    writeFile(
      path.join(missionsRoot, "backlog", "README.md"),
      "---\nid: OPR.99.0.1\n---\n# backlog\n",
    );
    writeFile(
      path.join(missionsRoot, "backlog", "slices", "01-foo", "README.md"),
      "---\nid: OPR.99.0.1.1\nstatus: active\n---\n# foo\n",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "README.md"),
      "---\nid: OPR.0.3.2\n---\n# release\n",
    );
    execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-m", "seed", "-q"], { stdio: "ignore" });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("uses git mv inside a repo and preserves the file via git log --follow", () => {
    const src = path.join(missionsRoot, "backlog", "slices", "01-foo");
    const dest = path.join(missionsRoot, "release-0.3.2", "slices", "01-foo");
    const result = moveSlice(src, dest);
    expect(result.usedGit).toBe(true);
    execFileSync("git", ["-C", root, "commit", "-m", "ship", "-q"], { stdio: "ignore" });
    const log = execFileSync("git", [
      "-C", root, "log", "--follow", "--pretty=format:%s", "--", path.relative(root, path.join(dest, "README.md")),
    ], { encoding: "utf8" });
    expect(log).toMatch(/seed/);
    expect(log).toMatch(/ship/);
  });

  it("refuses to move when slice has uncommitted local edits (HG-11)", () => {
    const src = path.join(missionsRoot, "backlog", "slices", "01-foo");
    fs.writeFileSync(path.join(src, "README.md"), "dirty\n", "utf8");
    const dest = path.join(missionsRoot, "release-0.3.2", "slices", "02-foo");
    expect(() => moveSlice(src, dest)).toThrow(/uncommitted/);
  });

  it("falls back to fs.rename outside a git repo", () => {
    const dir = mktemp();
    const src = path.join(dir, "src");
    const dest = path.join(dir, "dest");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "README.md"), "body");
    const result = moveSlice(src, dest);
    expect(result.usedGit).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
